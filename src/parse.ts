/**
 * Maven console output -> compact structured result.
 *
 * This is the reason the extension exists. A failing `mvn verify` prints
 * thousands of lines; the model needs the ten that say what broke and where.
 *
 * ponytail: failures are read from Maven's console output, not from the Surefire
 * XML reports. Console gives the same "Class.method:line message" for free and
 * costs no XML dependency, but it truncates very long assertion messages and
 * omits stack frames. Switch to target/surefire-reports/*.xml if that ceiling
 * is ever reached; the full log path is already returned in the meantime.
 */

export interface CompileError {
	file: string;
	line?: number;
	column?: number;
	message: string;
	/** javac's "symbol:" / "location:" follow-up lines, already trimmed. */
	detail: string[];
}

export interface TestFailure {
	/** e.g. "AppTest.shouldAdd" */
	test: string;
	line?: number;
	message: string;
	kind: "failure" | "error";
}

export interface TestCounts {
	run: number;
	failures: number;
	errors: number;
	skipped: number;
}

export interface ModuleResult {
	name: string;
	status: "SUCCESS" | "FAILURE" | "SKIPPED";
	time?: string;
}

export interface BuildResult {
	ok: boolean;
	compileErrors: CompileError[];
	testFailures: TestFailure[];
	/** [ERROR] lines that are neither compile errors nor test failures. */
	generic: string[];
	tests?: TestCounts;
	modules: ModuleResult[];
	warnings: number;
	totalTime?: string;
	/** Goals that ran, e.g. ["compiler:compile", "surefire:test"]. */
	goals: string[];
}

const ANSI = /\x1b\[[0-9;]*m/g;
const LEVEL = /^\[(INFO|WARNING|ERROR|DEBUG)\]\s?/;

/** `/abs/Foo.java:[12,34] cannot find symbol` — the maven-compiler-plugin form. */
const MAVEN_FILE_ERROR = /^(.*?\.(?:java|kt|scala|groovy)):\[(\d+),(\d+)\]\s*(.*)$/;
/** `/abs/Foo.java:12: error: cannot find symbol` — raw javac / kotlinc form. */
const JAVAC_FILE_ERROR = /^(.*?\.(?:java|kt|scala|groovy)):(\d+):\s*(?:error|erreur|Fehler):\s*(.*)$/;
/** `  AppTest.shouldAdd:12 expected: <4> but was: <5>` */
const TEST_FAILURE = /^([\w$.]+(?:\.[\w$]+)?)(?::(\d+))?\s*(?:»\s*)?(.*)$/;

function stripLevel(line: string): { level: string; text: string } {
	const clean = line.replace(ANSI, "").replace(/\r$/, "");
	const match = clean.match(LEVEL);
	if (!match) return { level: "", text: clean };
	return { level: match[1], text: clean.slice(match[0].length) };
}

/** Boilerplate that carries no information for the model. */
function isNoise(text: string): boolean {
	return (
		text.trim() === "" ||
		/^-{5,}$/.test(text.trim()) ||
		/^COMPILATION ERROR/.test(text) ||
		/^BUILD (FAILURE|SUCCESS)$/.test(text) ||
		/^Tests? run:/.test(text) ||
		/^(Failures|Errors|Results|Tests in error):?\s*$/.test(text) ||
		/^To see the full stack trace/.test(text) ||
		/^Re-run Maven using the -X switch/.test(text) ||
		/^For more information about the errors/.test(text) ||
		/\[Help \d+\]/.test(text) ||
		/^After correcting the problems/.test(text) ||
		/^Please read the following articles/.test(text) ||
		/^Please refer to /.test(text) ||
		/<<<\s*(FAILURE|ERROR)!/.test(text) ||
		/^https?:\/\/cwiki\.apache\.org/.test(text) ||
		/^\d+ errors?$/.test(text)
	);
}

export function parseBuildOutput(output: string): BuildResult {
	const lines = output.split("\n");
	const compileErrors: CompileError[] = [];
	const testFailures: TestFailure[] = [];
	const generic: string[] = [];
	const modules: ModuleResult[] = [];
	const goals: string[] = [];
	let tests: TestCounts | undefined;
	let warnings = 0;
	let totalTime: string | undefined;
	let ok = false;
	let failureSection: "failure" | "error" | undefined;

	for (let i = 0; i < lines.length; i++) {
		const { level, text } = stripLevel(lines[i]);
		const trimmed = text.trim();

		if (level === "WARNING") warnings++;
		if (/^BUILD SUCCESS$/.test(trimmed)) ok = true;
		if (/^BUILD FAILURE$/.test(trimmed) || /^BUILD ERROR$/.test(trimmed)) ok = false;

		const goal = trimmed.match(/^---\s+(\S+?):\S+?:(\S+?)\s+\(/);
		if (goal) {
			const name = `${goal[1]}:${goal[2]}`;
			if (!goals.includes(name)) goals.push(name);
		}

		const time = trimmed.match(/^Total time:\s+(.+)$/);
		if (time) totalTime = time[1].trim();

		// Reactor summary: "core ......... FAILURE [  1.234 s]"
		const module = trimmed.match(/^(\S.*?)\s*\.{3,}\s*(SUCCESS|FAILURE|SKIPPED)(?:\s*\[\s*(.+?)\s*\])?$/);
		if (module) {
			modules.push({ name: module[1].trim(), status: module[2] as ModuleResult["status"], time: module[3] });
			continue;
		}

		// Aggregate test counts; the last "Tests run:" without a class suffix wins.
		const counts = trimmed.match(/^Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)\s*$/);
		if (counts) {
			tests = {
				run: Number(counts[1]),
				failures: Number(counts[2]),
				errors: Number(counts[3]),
				skipped: Number(counts[4]),
			};
			continue;
		}

		if (level !== "ERROR") continue;

		// Surefire prints "Failures:" / "Errors:" headers, then one line per test.
		if (/^Failures:\s*$/.test(trimmed)) {
			failureSection = "failure";
			continue;
		}
		if (/^(Errors|Tests in error):\s*$/.test(trimmed)) {
			failureSection = "error";
			continue;
		}

		const fileError = trimmed.match(MAVEN_FILE_ERROR) ?? trimmed.match(JAVAC_FILE_ERROR);
		if (fileError) {
			failureSection = undefined;
			const isMavenForm = fileError.length === 5;
			const error: CompileError = {
				file: fileError[1],
				line: Number(fileError[2]),
				column: isMavenForm ? Number(fileError[3]) : undefined,
				message: (isMavenForm ? fileError[4] : fileError[3]).trim(),
				detail: [],
			};
			// javac's follow-ups ("symbol:", "location:") arrive indented, with or
			// without an [ERROR] prefix depending on the compiler plugin version.
			for (let j = i + 1; j < lines.length; j++) {
				const next = stripLevel(lines[j]);
				if (next.level === "INFO" || next.level === "WARNING") break;
				if (!/^\s+\S/.test(next.text)) break;
				if (MAVEN_FILE_ERROR.test(next.text.trim())) break;
				error.detail.push(next.text.trim());
				i = j;
			}
			const duplicate = compileErrors.some(
				(existing) =>
					existing.file === error.file &&
					existing.line === error.line &&
					existing.column === error.column &&
					existing.message === error.message,
			);
			if (!duplicate) compileErrors.push(error);
			continue;
		}

		if (failureSection && /^\s/.test(text) && trimmed) {
			const failure = trimmed.match(TEST_FAILURE);
			if (failure) {
				testFailures.push({
					test: failure[1],
					line: failure[2] ? Number(failure[2]) : undefined,
					message: failure[3].trim(),
					kind: failureSection,
				});
				continue;
			}
		}

		if (isNoise(trimmed)) continue;
		failureSection = undefined;
		if (!generic.includes(trimmed)) generic.push(trimmed);
	}

	return { ok, compileErrors, testFailures, generic, tests, modules, warnings, totalTime, goals };
}

export interface FormatOptions {
	/** Shown on the headline, e.g. "mvn -B compile". */
	command: string;
	durationMs: number;
	exitCode: number;
	/** Root path that absolute file paths are made relative to. */
	root?: string;
	/** Where the untruncated log was written, mentioned only on failure. */
	logPath?: string;
	maxItems?: number;
}

function relativize(file: string, root?: string): string {
	if (!root) return file;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/** A single Maven error line can be kilobytes long; the model needs the start of it. */
function clamp(text: string, maxChars = 500): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… (+${text.length - maxChars} chars)`;
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Render a BuildResult as the compact text block handed to the model. */
export function formatBuildResult(result: BuildResult, options: FormatOptions): string {
	const max = options.maxItems ?? 20;
	const success = result.ok && options.exitCode === 0;
	const out: string[] = [];

	out.push(`${success ? "OK" : "FAILED"}  ${options.command}  (${formatDuration(options.durationMs)})`);

	if (result.tests) {
		const { run, failures, errors, skipped } = result.tests;
		out.push(`Tests: ${run} run, ${failures} failed, ${errors} errors, ${skipped} skipped`);
	}

	const failedModules = result.modules.filter((m) => m.status !== "SUCCESS");
	if (result.modules.length > 1 && failedModules.length) {
		out.push(`Modules: ${failedModules.map((m) => `${m.name} ${m.status}`).join(", ")}`);
	}

	if (result.compileErrors.length) {
		out.push("", `Compile errors (${result.compileErrors.length}):`);
		for (const error of result.compileErrors.slice(0, max)) {
			const where = [relativize(error.file, options.root), error.line, error.column].filter(Boolean).join(":");
			out.push(`  ${where}  ${clamp(error.message)}`);
			for (const detail of error.detail.slice(0, 3)) out.push(`      ${clamp(detail)}`);
		}
		if (result.compileErrors.length > max) out.push(`  ... ${result.compileErrors.length - max} more`);
	}

	if (result.testFailures.length) {
		out.push("", `Test failures (${result.testFailures.length}):`);
		for (const failure of result.testFailures.slice(0, max)) {
			const where = failure.line ? `${failure.test}:${failure.line}` : failure.test;
			out.push(`  ${where}  ${clamp(failure.message)}`.trimEnd());
		}
		if (result.testFailures.length > max) out.push(`  ... ${result.testFailures.length - max} more`);
	}

	// Once errors are listed individually, Maven's goal-level wrapper ("Failed to
	// execute goal ...: Compilation failure") only repeats what is already above.
	const detailed = result.compileErrors.length > 0 || result.testFailures.length > 0;
	const generic = detailed ? result.generic.filter((line) => !/^Failed to execute goal /.test(line)) : result.generic;

	if (!success && generic.length) {
		out.push("", "Errors:");
		for (const line of generic.slice(0, max)) out.push(`  ${clamp(relativize(line, options.root))}`);
		if (generic.length > max) out.push(`  ... ${generic.length - max} more`);
	}

	if (!success && !detailed && !generic.length) {
		out.push("", `Build failed with exit code ${options.exitCode} but printed no [ERROR] lines.`);
	}

	if (!success && options.logPath) out.push("", `Full log: ${options.logPath}`);

	return out.join("\n");
}

/**
 * Compress `mvn dependency:tree` to the lines that are actually a tree.
 * Keeps depth <= maxDepth so a 900-line transitive dump stays readable.
 */
export function formatDependencyTree(output: string, maxDepth = 2): string {
	const kept: string[] = [];
	for (const line of output.split("\n")) {
		const { level, text } = stripLevel(line);
		if (level !== "INFO") continue;
		const match = text.match(/^([|+\\ ]*[+\\]-\s)?(\S+:\S+:\S+:\S+(?::\S+)?)\s*$/);
		if (!match) continue;
		// Maven indents each level by exactly three characters ("|  " or "   ")
		// before the "+- " / "\\- " marker, so prefix length divides cleanly by 3.
		const prefix = match[1] ?? "";
		const depth = Math.round(prefix.length / 3);
		if (depth > maxDepth) continue;
		kept.push(`${"  ".repeat(depth)}${match[2]}`);
	}
	return kept.join("\n");
}
