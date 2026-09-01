/**
 * One Maven invocation path shared by the tools, the /mvn command and the panel
 * menu, so all three report identically and all three keep the panel current.
 */

import { basename, join, relative } from "node:path";
import { BASE_ARGS, runMaven, writeLog } from "./maven.ts";
import { type BuildResult, formatBuildResult, parseBuildOutput } from "./parse.ts";
import { findJar, findMainClasses, type MavenProject } from "./project.ts";
import { panel } from "./panel.ts";

export const DEFAULT_TIMEOUT_MINUTES = 15;

export interface ActionSpec {
	/** Stable id, used by "rerun last". */
	id: string;
	/** Short label shown in the panel, e.g. "compile". */
	label: string;
	goals: string[];
	extra?: string[];
	/** Fully resolved invocation, used when the caller already built one (see resolveRunTarget). */
	prebuilt?: { command: string; args: string[] };
	module?: string;
	profiles?: string[];
	timeoutMinutes?: number;
}

export interface ActionDetails {
	command: string;
	exitCode: number;
	durationMs: number;
	result: BuildResult;
	logPath?: string;
}

export interface ActionOutcome {
	text: string;
	details: ActionDetails;
	ok: boolean;
}

/** Accept either a module directory ("services/api") or an artifactId ("api"). */
export function resolveModule(project: MavenProject, module: string | undefined): string | undefined {
	if (!module) return undefined;
	const cleaned = module.replace(/^@/, "").replace(/\/+$/, "");
	const byPath = project.modules.find((m) => m.path === cleaned);
	if (byPath) return byPath.path;
	const byName = project.modules.find((m) => m.name === cleaned);
	if (byName) return byName.path;
	throw new Error(
		`Unknown module "${module}". Available: ${project.modules.map((m) => m.path || "(root)").join(", ")}`,
	);
}

export function selectionArgs(project: MavenProject, module?: string, profiles?: string[]): string[] {
	const args: string[] = [];
	const path = resolveModule(project, module);
	if (path) args.push("-pl", path, "-am");
	if (profiles?.length) args.push("-P", profiles.join(","));
	return args;
}

/** The single most useful failure line, for the panel's third row. */
function headlineOf(result: BuildResult, root: string): string | undefined {
	const failure = result.testFailures[0];
	if (failure) {
		const where = failure.line ? `${failure.test}:${failure.line}` : failure.test;
		return `${where}  ${failure.message}`;
	}
	const error = result.compileErrors[0];
	if (!error) return undefined;
	const file = error.file.startsWith(root) ? relative(root, error.file) : error.file;
	return `${[file, error.line, error.column].filter(Boolean).join(":")}  ${error.message}`;
}

export interface ActionOptions {
	signal?: AbortSignal;
	/** Called whenever the panel state changes, so the TUI can re-render. */
	onStateChange?: () => void;
	/** Streamed progress for tool calls. */
	onProgress?: (text: string) => void;
}

/** Run Maven for `spec`, parse it, update the panel, and return the compact report. */
export async function runAction(
	project: MavenProject,
	spec: ActionSpec,
	options: ActionOptions = {},
): Promise<ActionOutcome> {
	const args =
		spec.prebuilt?.args ??
		[...BASE_ARGS, ...spec.goals, ...(spec.extra ?? []), ...selectionArgs(project, spec.module, spec.profiles)];
	const executable = spec.prebuilt?.command ?? project.runner;
	const shown = spec.prebuilt ? basename(executable) : project.runnerLabel;
	const command = `${shown} ${args.filter((a) => !BASE_ARGS.includes(a)).join(" ")}`;

	panel.running = { label: spec.label, startedAt: Date.now() };
	options.onStateChange?.();

	try {
		const run = await runMaven(executable, args, {
			cwd: project.root,
			signal: options.signal,
			timeoutMs: (spec.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
			onPhase: (phase) => {
				if (panel.running) panel.running.phase = phase;
				options.onStateChange?.();
				options.onProgress?.(`${command}\n  ${phase}`);
			},
		});

		const result = parseBuildOutput(run.output);
		const ok = result.ok && run.exitCode === 0;
		const logPath = ok ? undefined : writeLog(run.output, spec.id);

		let text = formatBuildResult(result, {
			command,
			durationMs: run.durationMs,
			exitCode: run.exitCode,
			root: project.root,
			logPath,
		});
		if (run.timedOut) {
			text += `\n\nTimed out after ${spec.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES} minutes and was killed. Raise timeoutMinutes, or start long-running processes with mvn_run background=true.`;
		}

		panel.last = {
			label: spec.label,
			ok,
			durationMs: run.durationMs,
			tests: result.tests,
			errorCount: result.compileErrors.length + result.generic.length,
			headline: ok ? undefined : headlineOf(result, project.root),
		};
		panel.lastSpec = spec;
		// Keep failed selectors so the menu can offer "rerun failed tests".
		if (result.testFailures.length) {
			panel.lastFailedTests = [...new Set(result.testFailures.map((f) => f.test.replace(/\.([^.]+)$/, "#$1")))];
		} else if (result.tests) {
			panel.lastFailedTests = [];
		}

		return { text, details: { command, exitCode: run.exitCode, durationMs: run.durationMs, result, logPath }, ok };
	} finally {
		panel.running = undefined;
		options.onStateChange?.();
	}
}

/** The goal sets the panel menu and /mvn expose, in menu order. */
export const PRESETS: Record<string, Omit<ActionSpec, "module" | "profiles">> = {
	compile: { id: "compile", label: "compile", goals: ["compile"] },
	rebuild: { id: "rebuild", label: "rebuild", goals: ["clean", "compile"] },
	package: { id: "package", label: "package", goals: ["package"], extra: ["-DskipTests"] },
	verify: { id: "verify", label: "verify", goals: ["verify"] },
	test: { id: "test", label: "test", goals: ["test"] },
	install: { id: "install", label: "install", goals: ["install"], extra: ["-DskipTests"] },
	clean: { id: "clean", label: "clean", goals: ["clean"] },
};

/** Surefire filter flags, including the "skip modules without the test" guards. */
export function filterArgs(filter: string): string[] {
	return [`-Dtest=${filter}`, "-Dsurefire.failIfNoSpecifiedTests=false", "-Dfailsafe.failIfNoSpecifiedTests=false"];
}

export interface RunTarget {
	command: string;
	args: string[];
	/** Short description for the panel and for the message shown to the caller. */
	label: string;
}

export interface RunTargetOptions {
	target?: "auto" | "spring-boot" | "exec" | "jar";
	mainClass?: string;
	appArgs?: string[];
	module?: string;
	profiles?: string[];
	javaHome?: string;
}

/**
 * Decide what "run this project" means: spring-boot:run, exec:java with a main
 * class, or java -jar over the built artifact. Throws with the candidate list
 * when the main class is ambiguous, which is the case worth asking a human about.
 */
export function resolveRunTarget(project: MavenProject, options: RunTargetOptions): RunTarget {
	const modulePath = resolveModule(project, options.module);
	let target = options.target ?? "auto";
	if (target === "auto") target = project.springBoot && !options.mainClass ? "spring-boot" : "exec";

	if (target === "jar") {
		const jar = findJar(project, modulePath);
		if (!jar) {
			throw new Error(
				`No jar in ${join(project.root, modulePath ?? "", "target")}. Run mvn_build with goals ['package'] first.`,
			);
		}
		const java = options.javaHome ? join(options.javaHome, "bin", "java") : "java";
		return { command: java, args: ["-jar", jar, ...(options.appArgs ?? [])], label: `java -jar ${basename(jar)}` };
	}

	const args = [...BASE_ARGS];
	let label: string;

	if (target === "spring-boot") {
		args.push("spring-boot:run");
		if (options.appArgs?.length) args.push(`-Dspring-boot.run.arguments=${options.appArgs.join(" ")}`);
		label = "spring-boot:run";
	} else {
		let mainClass = options.mainClass ?? project.declaredMainClass;
		if (!mainClass) {
			const candidates = findMainClasses(project, modulePath);
			if (candidates.length === 1) {
				mainClass = candidates[0].fqn;
			} else if (candidates.length === 0) {
				throw new Error(
					"No `public static void main` found in src/main/java. Pass mainClass explicitly, or use target='jar' / target='spring-boot'.",
				);
			} else {
				throw new Error(
					`Several main classes found — pass mainClass explicitly:\n${candidates.map((c) => `  ${c.fqn}  (${c.file})`).join("\n")}`,
				);
			}
		}
		args.push("compile", "exec:java", `-Dexec.mainClass=${mainClass}`);
		if (options.appArgs?.length) args.push(`-Dexec.args=${options.appArgs.join(" ")}`);
		label = `exec:java ${mainClass.split(".").pop()}`;
	}

	args.push(...selectionArgs(project, options.module, options.profiles));
	return { command: project.runner, args, label };
}
