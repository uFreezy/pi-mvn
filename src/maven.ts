/** Spawning Maven and the app it builds, plus the background process registry. */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MavenRunOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	env?: Record<string, string>;
	/** Called with each phase change, for streaming progress. */
	onPhase?: (phase: string) => void;
}

export interface MavenRunResult {
	output: string;
	exitCode: number;
	durationMs: number;
	timedOut: boolean;
}

/**
 * Batch mode, no download spam. Locale is pinned through MAVEN_OPTS rather than
 * -D because javac reads Locale.getDefault() at JVM start; a -D property set
 * after that would still yield localized (unparseable) compiler messages.
 */
export const BASE_ARGS = ["-B", "--no-transfer-progress"];
const LOCALE_OPTS = "-Duser.language=en -Duser.country=US";

export function mavenEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	const existing = process.env.MAVEN_OPTS ? `${process.env.MAVEN_OPTS} ` : "";
	return { ...process.env, MAVEN_OPTS: `${existing}${LOCALE_OPTS}`, ...extra };
}

/** The line Maven prints when it starts a goal, reduced to something short. */
export function phaseOf(line: string): string | undefined {
	const goal = line.match(/^\[INFO\]\s+---\s+(\S+?):\S+?:(\S+?)\s+\(.*?\)\s+@\s+(\S+)/);
	if (goal) return `${goal[3]} ${goal[1]}:${goal[2]}`;
	const building = line.match(/^\[INFO\]\s+Building\s+(.+?)\s+[\d.]/);
	if (building) return `building ${building[1]}`;
	return undefined;
}

export function runMaven(command: string, args: string[], options: MavenRunOptions): Promise<MavenRunResult> {
	const started = Date.now();

	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: mavenEnv(options.env),
			stdio: ["ignore", "pipe", "pipe"],
		});

		const chunks: string[] = [];
		let pending = "";
		let timedOut = false;
		let settled = false;

		const collect = (data: Buffer) => {
			const text = data.toString();
			chunks.push(text);
			if (!options.onPhase) return;
			pending += text;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const phase = phaseOf(line);
				if (phase) options.onPhase(phase);
			}
		};

		child.stdout.on("data", collect);
		child.stderr.on("data", collect);

		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, options.timeoutMs)
			: undefined;

		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ output: chunks.join(""), exitCode, durationMs: Date.now() - started, timedOut });
		};

		child.on("error", (error) => {
			chunks.push(`\n[ERROR] Failed to start ${command}: ${error.message}`);
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 1));
	});
}

/** Write the untruncated log somewhere the model can read it back. */
export function writeLog(output: string, label: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mvn-"));
	const path = join(dir, `${label}.log`);
	writeFileSync(path, output, "utf8");
	return path;
}

export interface BackgroundApp {
	id: string;
	command: string;
	logPath: string;
	startedAt: number;
	child: ChildProcess;
	exitCode?: number;
}

/** Apps started with `background: true`, keyed by id. Session-scoped. */
export const runningApps = new Map<string, BackgroundApp>();

export function startBackground(command: string, args: string[], cwd: string, env?: Record<string, string>): BackgroundApp {
	const id = `app-${runningApps.size + 1}-${Date.now().toString(36)}`;
	const dir = mkdtempSync(join(tmpdir(), "pi-mvn-"));
	const logPath = join(dir, `${id}.log`);
	const log = createWriteStream(logPath);

	const child = spawn(command, args, { cwd, env: mavenEnv(env), stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.pipe(log);
	child.stderr.pipe(log);

	const app: BackgroundApp = { id, command: [command, ...args].join(" "), logPath, startedAt: Date.now(), child };
	child.on("close", (code) => {
		app.exitCode = code ?? 0;
	});
	runningApps.set(id, app);
	return app;
}

export function tailLog(path: string, lines: number): string {
	try {
		const all = readFileSync(path, "utf8").split("\n");
		return all.slice(Math.max(0, all.length - lines)).join("\n");
	} catch {
		return "(no output yet)";
	}
}

export async function stopApp(app: BackgroundApp): Promise<void> {
	if (app.child.exitCode !== null || app.child.killed) return;
	app.child.kill("SIGTERM");
	// ponytail: fixed 3s grace before SIGKILL. Long enough for a Spring Boot
	// shutdown hook; make it a parameter if some app legitimately needs more.
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			app.child.kill("SIGKILL");
			resolve();
		}, 3000);
		app.child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

export function stopAllApps(): void {
	for (const app of runningApps.values()) {
		if (app.child.exitCode === null && !app.child.killed) app.child.kill("SIGKILL");
	}
	runningApps.clear();
}
