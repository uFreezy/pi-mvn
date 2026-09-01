/**
 * pi-mvn — Maven/Java tooling for the pi coding agent.
 *
 * Four tools (build, test, run, project) that wrap Maven and hand back the ten
 * lines that matter instead of the two thousand Maven printed, plus a `/mvn`
 * slash command so a human can drive the same loop.
 */

import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BASE_ARGS,
	type BackgroundApp,
	runMaven,
	runningApps,
	startBackground,
	stopAllApps,
	stopApp,
	tailLog,
	writeLog,
} from "./maven.ts";
import { type BuildResult, formatBuildResult, formatDependencyTree, parseBuildOutput } from "./parse.ts";
import { findJar, findMainClasses, loadProject, type MavenProject } from "./project.ts";

const DEFAULT_TIMEOUT_MINUTES = 15;

function requireProject(ctx: { cwd: string }): MavenProject {
	const project = loadProject(ctx.cwd);
	if (!project) {
		throw new Error(
			`No pom.xml found in ${ctx.cwd} or any parent directory. pi-mvn needs a Maven project; use bash for non-Maven builds.`,
		);
	}
	return project;
}

/** Accept either a module directory ("services/api") or an artifactId ("api"). */
function resolveModule(project: MavenProject, module: string | undefined): string | undefined {
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

function selectionArgs(project: MavenProject, module?: string, profiles?: string[]): string[] {
	const args: string[] = [];
	const path = resolveModule(project, module);
	if (path) args.push("-pl", path, "-am");
	if (profiles?.length) args.push("-P", profiles.join(","));
	return args;
}

interface MavenToolDetails {
	command: string;
	exitCode: number;
	durationMs: number;
	result: BuildResult;
	logPath?: string;
}

/** Run Maven, parse it, and shape the compact text + details the tool returns. */
async function execAndFormat(
	project: MavenProject,
	args: string[],
	label: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
	timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
) {
	// BASE_ARGS are always present; showing them on every line is just noise.
	const command = `${project.runnerLabel} ${args.filter((a) => !BASE_ARGS.includes(a)).join(" ")}`;

	const run = await runMaven(project.runner, args, {
		cwd: project.root,
		signal,
		timeoutMs: timeoutMinutes * 60_000,
		onPhase: onUpdate
			? (phase) => onUpdate({ content: [{ type: "text", text: `${command}\n  ${phase}` }], details: {} })
			: undefined,
	});

	const result = parseBuildOutput(run.output);
	const succeeded = result.ok && run.exitCode === 0;
	const logPath = succeeded ? undefined : writeLog(run.output, label);

	let text = formatBuildResult(result, {
		command,
		durationMs: run.durationMs,
		exitCode: run.exitCode,
		root: project.root,
		logPath,
	});

	if (run.timedOut) {
		text += `\n\nTimed out after ${timeoutMinutes} minutes and was killed. Raise timeoutMinutes, or start long-running processes with mvn_run background=true.`;
	}

	const details: MavenToolDetails = {
		command,
		exitCode: run.exitCode,
		durationMs: run.durationMs,
		result,
		logPath,
	};

	return { content: [{ type: "text" as const, text }], details, succeeded };
}

function describeApp(app: BackgroundApp): string {
	const state = app.child.exitCode !== null ? `exited (${app.child.exitCode})` : "running";
	const seconds = Math.round((Date.now() - app.startedAt) / 1000);
	return `${app.id}  ${state}  ${seconds}s  ${app.command}\n  log: ${app.logPath}`;
}

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------- build ---

	pi.registerTool({
		name: "mvn_build",
		label: "Maven Build",
		description:
			"Run Maven build goals (compile, package, verify, install, clean, or any plugin goal) and return only the parsed result: compile errors as file:line:column with the javac message, failed modules, and timing. Use this instead of `bash mvn ...` — raw Maven output is thousands of lines and floods context. The full log is written to a temp file and its path is returned when the build fails.",
		promptSnippet: "Compile or package a Maven project and get parsed compiler errors back",
		promptGuidelines: [
			"Use mvn_build instead of running `mvn` through bash, so Maven output arrives parsed rather than as thousands of raw lines.",
			"After editing Java sources, use mvn_build with goals ['compile'] to check they still compile before moving on.",
		],
		parameters: Type.Object({
			goals: Type.Optional(
				Type.Array(Type.String(), {
					description: "Maven goals/phases, e.g. ['compile'], ['clean','package'], ['dependency:analyze']. Default: ['compile'].",
				}),
			),
			module: Type.Optional(
				Type.String({ description: "Module directory or artifactId to build (adds -pl <module> -am). Default: whole reactor." }),
			),
			profiles: Type.Optional(Type.Array(Type.String(), { description: "Profiles to activate (-P)." })),
			skipTests: Type.Optional(Type.Boolean({ description: "Add -DskipTests. Default false." })),
			args: Type.Optional(Type.Array(Type.String(), { description: "Extra raw Maven arguments, e.g. ['-Dmaven.compiler.release=21']." })),
			timeoutMinutes: Type.Optional(Type.Number({ description: `Kill the build after this long. Default ${DEFAULT_TIMEOUT_MINUTES}.` })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const project = requireProject(ctx);
			const goals = params.goals?.length ? params.goals : ["compile"];
			const args = [
				...BASE_ARGS,
				...goals,
				...selectionArgs(project, params.module, params.profiles),
				...(params.skipTests ? ["-DskipTests"] : []),
				...(params.args ?? []),
			];

			const { content, details, succeeded } = await execAndFormat(
				project,
				args,
				"build",
				ctx,
				signal,
				onUpdate,
				params.timeoutMinutes,
			);
			if (!succeeded) throw new Error(content[0].text);
			return { content, details };
		},
	});

	// ----------------------------------------------------------------- test ---

	pi.registerTool({
		name: "mvn_test",
		label: "Maven Test",
		description:
			"Run Maven tests and return only the failures: test name, source line, and assertion message, plus run/failed/skipped counts. `filter` accepts Surefire patterns such as 'AppTest', 'AppTest#shouldAdd', or 'com.example.*Test'. Scope selects unit tests (surefire), integration tests (failsafe), or both.",
		promptSnippet: "Run Maven tests and get back only the failing tests with their assertion messages",
		promptGuidelines: [
			"Use mvn_test rather than `bash mvn test`; it returns failures parsed instead of the full Surefire log.",
			"When iterating on one failing test, pass a filter like 'AppTest#shouldAdd' to mvn_test so the run stays fast.",
		],
		parameters: Type.Object({
			filter: Type.Optional(
				Type.String({ description: "Surefire/Failsafe pattern: 'AppTest', 'AppTest#method', 'com.example.*Test'. Default: all tests." }),
			),
			scope: Type.Optional(StringEnum(["unit", "integration", "all"] as const, { description: "Default: unit." })),
			module: Type.Optional(Type.String({ description: "Module directory or artifactId to test." })),
			profiles: Type.Optional(Type.Array(Type.String(), { description: "Profiles to activate (-P)." })),
			args: Type.Optional(Type.Array(Type.String(), { description: "Extra raw Maven arguments." })),
			timeoutMinutes: Type.Optional(Type.Number({ description: `Default ${DEFAULT_TIMEOUT_MINUTES}.` })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const project = requireProject(ctx);
			const scope = params.scope ?? "unit";
			const args = [...BASE_ARGS];

			if (scope === "unit") {
				args.push("test");
				if (params.filter) args.push(`-Dtest=${params.filter}`);
			} else if (scope === "integration") {
				args.push("verify");
				// Surefire and Failsafe share -DskipTests, so there is no clean "skip
				// only unit tests" switch. Handing Surefire a pattern that matches
				// nothing is the standard way to run Failsafe alone.
				args.push("-Dtest=!*");
				if (params.filter) args.push(`-Dit.test=${params.filter}`);
			} else {
				args.push("verify");
				if (params.filter) args.push(`-Dtest=${params.filter}`, `-Dit.test=${params.filter}`);
			}

			if (scope !== "unit" || params.filter) {
				// In a reactor most modules will not contain the filtered test; without
				// these, Surefire/Failsafe fail those modules instead of skipping them.
				args.push("-Dsurefire.failIfNoSpecifiedTests=false", "-Dfailsafe.failIfNoSpecifiedTests=false");
			}

			args.push(...selectionArgs(project, params.module, params.profiles), ...(params.args ?? []));

			const { content, details, succeeded } = await execAndFormat(
				project,
				args,
				"test",
				ctx,
				signal,
				onUpdate,
				params.timeoutMinutes,
			);
			if (!succeeded) throw new Error(content[0].text);
			return { content, details };
		},
	});

	// ------------------------------------------------------------------ run ---

	pi.registerTool({
		name: "mvn_run",
		label: "Maven Run",
		description:
			"Run the application, the way IntelliJ's green arrow does. action='start' launches it (auto-detects spring-boot:run, an exec-plugin mainClass, or a `public static void main` in the sources); background=true returns immediately with an id so a server can keep running while you work. action='logs' tails a background app, action='status' lists them, action='stop' terminates one. Always use background=true for servers and anything that does not exit on its own.",
		promptSnippet: "Start, tail, or stop the Maven project's application",
		promptGuidelines: [
			"Use mvn_run with background=true for servers and long-running apps, then mvn_run action='logs' to read their output.",
		],
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["start", "logs", "status", "stop"] as const, { description: "Default: start." })),
			target: Type.Optional(
				StringEnum(["auto", "spring-boot", "exec", "jar"] as const, {
					description: "auto detects spring-boot vs exec:java. 'jar' runs the newest jar in target/ (build it first).",
				}),
			),
			mainClass: Type.Optional(Type.String({ description: "Fully-qualified main class. Overrides detection." })),
			appArgs: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the application itself." })),
			background: Type.Optional(Type.Boolean({ description: "Return immediately and keep the app running. Default false." })),
			id: Type.Optional(Type.String({ description: "Background app id, for logs/stop." })),
			lines: Type.Optional(Type.Number({ description: "Log lines to tail. Default 100." })),
			module: Type.Optional(Type.String({ description: "Module directory or artifactId to run." })),
			profiles: Type.Optional(Type.Array(Type.String(), { description: "Profiles to activate (-P)." })),
			javaHome: Type.Optional(Type.String({ description: "JAVA_HOME to run under, for projects needing a different JDK." })),
			timeoutMinutes: Type.Optional(Type.Number({ description: `Foreground runs only. Default ${DEFAULT_TIMEOUT_MINUTES}.` })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = params.action ?? "start";

			if (action === "status") {
				const apps = [...runningApps.values()];
				const text = apps.length ? apps.map(describeApp).join("\n") : "No background apps started in this session.";
				return { content: [{ type: "text", text }], details: { apps: apps.map((a) => a.id) } };
			}

			if (action === "logs" || action === "stop") {
				const apps = [...runningApps.values()];
				const app = params.id ? runningApps.get(params.id) : apps[apps.length - 1];
				if (!app) throw new Error(params.id ? `No background app with id "${params.id}".` : "No background app is running.");

				if (action === "stop") {
					await stopApp(app);
					runningApps.delete(app.id);
					return { content: [{ type: "text", text: `Stopped ${app.id}.` }], details: { id: app.id } };
				}

				const tail = tailLog(app.logPath, params.lines ?? 100);
				return {
					content: [{ type: "text", text: `${describeApp(app)}\n\n${tail}` }],
					details: { id: app.id, logPath: app.logPath },
				};
			}

			const project = requireProject(ctx);
			const env = params.javaHome ? { JAVA_HOME: params.javaHome } : undefined;
			const modulePath = resolveModule(project, params.module);
			let target = params.target ?? "auto";

			// --- jar: run the built artifact directly, no Maven in the loop.
			if (target === "jar") {
				const jar = findJar(project, modulePath);
				if (!jar) {
					throw new Error(
						`No jar in ${join(project.root, modulePath ?? "", "target")}. Run mvn_build with goals ['package'] first.`,
					);
				}
				const javaBin = params.javaHome ? join(params.javaHome, "bin", "java") : "java";
				const jarArgs = ["-jar", jar, ...(params.appArgs ?? [])];
				if (params.background) {
					const app = startBackground(javaBin, jarArgs, project.root, env);
					return {
						content: [{ type: "text", text: `Started ${app.id} in background.\n${describeApp(app)}` }],
						details: { id: app.id },
					};
				}
				const run = await runMaven(javaBin, jarArgs, {
					cwd: project.root,
					signal,
					timeoutMs: (params.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
					env,
				});
				const truncated = truncateTail(run.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				return {
					content: [{ type: "text", text: `exit ${run.exitCode}\n\n${truncated.content}` }],
					details: { exitCode: run.exitCode },
				};
			}

			// --- resolve what "run" means for this project.
			if (target === "auto") target = project.springBoot && !params.mainClass ? "spring-boot" : "exec";

			const args = [...BASE_ARGS];
			if (target === "spring-boot") {
				args.push("spring-boot:run");
				if (params.appArgs?.length) args.push(`-Dspring-boot.run.arguments=${params.appArgs.join(" ")}`);
			} else {
				let mainClass = params.mainClass ?? project.declaredMainClass;
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
				if (params.appArgs?.length) args.push(`-Dexec.args=${params.appArgs.join(" ")}`);
			}

			args.push(...selectionArgs(project, params.module, params.profiles));

			if (params.background) {
				const app = startBackground(project.runner, args, project.root, env);
				return {
					content: [
						{
							type: "text",
							text: `Started ${app.id} in background.\n${describeApp(app)}\n\nUse mvn_run action='logs' to read output, action='stop' to terminate.`,
						},
					],
					details: { id: app.id, logPath: app.logPath },
				};
			}

			const { content, details } = await execAndFormat(
				project,
				args,
				"run",
				ctx,
				signal,
				onUpdate,
				params.timeoutMinutes,
			);
			return { content, details };
		},
	});

	// -------------------------------------------------------------- project ---

	pi.registerTool({
		name: "mvn_project",
		label: "Maven Project",
		description:
			"Inspect the Maven project without building it. what='overview' returns the reactor root, runner (mvnw or mvn), module list, profiles, Java target, detected main classes and Maven/JDK versions. what='dependencies' returns a depth-limited dependency tree. what='effective_pom' returns the resolved POM.",
		promptSnippet: "Show the Maven project layout, modules, profiles and dependencies",
		promptGuidelines: [
			"Call mvn_project with what='overview' before the first build in an unfamiliar Maven repo, to learn the module names and whether a wrapper exists.",
		],
		parameters: Type.Object({
			what: Type.Optional(StringEnum(["overview", "dependencies", "effective_pom"] as const, { description: "Default: overview." })),
			module: Type.Optional(Type.String({ description: "Restrict to one module directory or artifactId." })),
			depth: Type.Optional(Type.Number({ description: "dependencies only: max tree depth. Default 2." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const project = requireProject(ctx);
			const what = params.what ?? "overview";

			if (what === "overview") {
				const version = await runMaven(project.runner, ["-v"], { cwd: project.root, signal, timeoutMs: 30_000 });
				const versionLines = version.output
					.split("\n")
					.filter((l) => /^(Apache Maven|Java version:)/.test(l.trim()))
					.map((l) => `  ${l.trim()}`);

				const mains = findMainClasses(project, resolveModule(project, params.module), 10);
				const lines = [
					`Root:      ${project.root}`,
					`Runner:    ${project.runnerLabel}`,
					`Artifact:  ${project.artifactId ?? "(unnamed)"} (${project.packaging})`,
					`Java:      ${project.javaTarget ?? "not pinned in pom"}${process.env.JAVA_HOME ? `   JAVA_HOME=${process.env.JAVA_HOME}` : ""}`,
					...versionLines,
					`Modules:   ${project.modules.length > 1 ? project.modules.map((m) => m.path || "(root)").join(", ") : "single module"}`,
					`Profiles:  ${project.profiles.length ? project.profiles.join(", ") : "none declared"}`,
					`Spring Boot: ${project.springBoot ? "yes (mvn_run uses spring-boot:run)" : "no"}`,
				];
				if (project.declaredMainClass) lines.push(`Main class (pom): ${project.declaredMainClass}`);
				if (mains.length) lines.push(`Main methods: ${mains.map((m) => m.fqn).join(", ")}`);

				return { content: [{ type: "text", text: lines.join("\n") }], details: { project } };
			}

			if (what === "dependencies") {
				const args = [...BASE_ARGS, "dependency:tree", ...selectionArgs(project, params.module)];
				const run = await runMaven(project.runner, args, { cwd: project.root, signal, timeoutMs: 300_000 });
				if (run.exitCode !== 0) {
					const parsed = parseBuildOutput(run.output);
					throw new Error(
						formatBuildResult(parsed, {
							command: `${project.runnerLabel} dependency:tree`,
							durationMs: run.durationMs,
							exitCode: run.exitCode,
							root: project.root,
							logPath: writeLog(run.output, "deps"),
						}),
					);
				}
				const tree = formatDependencyTree(run.output, params.depth ?? 2);
				const truncated = truncateTail(tree, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				return { content: [{ type: "text", text: truncated.content }], details: { depth: params.depth ?? 2 } };
			}

			const args = [...BASE_ARGS, "help:effective-pom", ...selectionArgs(project, params.module)];
			const run = await runMaven(project.runner, args, { cwd: project.root, signal, timeoutMs: 300_000 });
			const pom = run.output
				.split("\n")
				.filter((l) => !/^\[(INFO|WARNING|DEBUG)\]/.test(l))
				.join("\n")
				.trim();
			const truncated = truncateTail(pom, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			return { content: [{ type: "text", text: truncated.content }], details: { exitCode: run.exitCode } };
		},
	});

	// ------------------------------------------------------------- /mvn ------

	const SUBCOMMANDS = ["build", "compile", "package", "test", "run", "info", "deps", "logs", "stop"];

	pi.registerCommand("mvn", {
		description: "Maven: /mvn build | test [filter] | run [target] | info | deps | logs | stop | <raw maven args>",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},

		handler: async (args, ctx: ExtensionCommandContext) => {
			const [sub = "info", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			let project: MavenProject;
			try {
				project = requireProject(ctx);
			} catch (error) {
				ctx.ui.notify(String((error as Error).message), "error");
				return;
			}

			const report = (text: string) => {
				pi.sendMessage({ customType: "pi-mvn", content: text, display: true, details: {} }, { deliverAs: "nextTurn" });
			};

			if (sub === "info") {
				const mains = findMainClasses(project, undefined, 10);
				report(
					[
						`${project.runnerLabel} @ ${project.root}`,
						`artifact: ${project.artifactId ?? "(unnamed)"} (${project.packaging}), java ${project.javaTarget ?? "unpinned"}`,
						`modules: ${project.modules.map((m) => m.path || "(root)").join(", ")}`,
						`profiles: ${project.profiles.join(", ") || "none"}`,
						mains.length ? `main: ${mains.map((m) => m.fqn).join(", ")}` : "main: none found",
					].join("\n"),
				);
				return;
			}

			if (sub === "status" || sub === "logs" || sub === "stop") {
				const apps = [...runningApps.values()];
				const app = rest[0] ? runningApps.get(rest[0]) : apps[apps.length - 1];
				if (!app) {
					ctx.ui.notify("No background app running.", "warning");
					return;
				}
				if (sub === "stop") {
					await stopApp(app);
					runningApps.delete(app.id);
					ctx.ui.notify(`Stopped ${app.id}.`, "info");
					return;
				}
				report(`${describeApp(app)}\n\n${tailLog(app.logPath, 100)}`);
				return;
			}

			const mavenArgs = [...BASE_ARGS];
			let label = sub;
			if (sub === "build") mavenArgs.push(...(rest.length ? rest : ["compile"]));
			else if (sub === "compile" || sub === "package") mavenArgs.push(sub, ...rest);
			else if (sub === "test") {
				mavenArgs.push("test");
				if (rest[0]) mavenArgs.push(`-Dtest=${rest[0]}`, "-Dsurefire.failIfNoSpecifiedTests=false");
			} else if (sub === "deps") {
				mavenArgs.push("dependency:tree");
				label = "deps";
			} else if (sub === "run") {
				const target = project.springBoot ? "spring-boot:run" : "exec:java";
				if (target === "exec:java") {
					const mainClass = rest[0] ?? project.declaredMainClass ?? findMainClasses(project)[0]?.fqn;
					if (!mainClass) {
						ctx.ui.notify("No main class found. Try /mvn run <fully.qualified.Main>", "error");
						return;
					}
					mavenArgs.push("compile", "exec:java", `-Dexec.mainClass=${mainClass}`);
				} else {
					mavenArgs.push(target);
				}
			} else {
				// Anything unrecognised is passed straight through to Maven.
				mavenArgs.push(sub, ...rest);
				label = "raw";
			}

			ctx.ui.setStatus("pi-mvn", `${project.runnerLabel} ${mavenArgs.filter((a) => !BASE_ARGS.includes(a)).join(" ")}`);
			try {
				const run = await runMaven(project.runner, mavenArgs, {
					cwd: project.root,
					timeoutMs: DEFAULT_TIMEOUT_MINUTES * 60_000,
					onPhase: (phase) => ctx.ui.setStatus("pi-mvn", `mvn: ${phase}`),
				});

				if (label === "deps") {
					report(formatDependencyTree(run.output, 2));
				} else {
					const parsed = parseBuildOutput(run.output);
					const succeeded = parsed.ok && run.exitCode === 0;
					report(
						formatBuildResult(parsed, {
							command: `${project.runnerLabel} ${mavenArgs.filter((a) => !BASE_ARGS.includes(a)).join(" ")}`,
							durationMs: run.durationMs,
							exitCode: run.exitCode,
							root: project.root,
							logPath: succeeded ? undefined : writeLog(run.output, label),
						}),
					);
					ctx.ui.notify(succeeded ? "Build OK" : "Build FAILED", succeeded ? "info" : "error");
				}
			} finally {
				ctx.ui.setStatus("pi-mvn", undefined);
			}
		},
	});

	// Background apps are session-scoped; never leave a server running after exit.
	pi.on("session_shutdown", async () => {
		stopAllApps();
	});
}
