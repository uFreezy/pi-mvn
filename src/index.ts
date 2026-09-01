/**
 * pi-mvn — Maven/Java tooling for the pi coding agent.
 *
 * Four tools (build, test, run, project) that wrap Maven and hand back the ten
 * lines that matter instead of the two thousand Maven printed, a `/mvn` command
 * so a human can drive the same loop, and a status panel with an actions menu.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { KeyId, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type ActionSpec,
	DEFAULT_TIMEOUT_MINUTES,
	PRESETS,
	filterArgs,
	resolveModule,
	resolveRunTarget,
	runAction,
	selectionArgs,
} from "./actions.ts";
import { openMenu } from "./menu.ts";
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
import { DEFAULT_CONFIG, panel, renderPanel, saveConfig } from "./panel.ts";
import { findMainClasses, loadProject, type MavenProject } from "./project.ts";
import { formatBuildResult, formatDependencyTree, parseBuildOutput } from "./parse.ts";

function requireProject(ctx: { cwd: string }): MavenProject {
	const project = panel.project ?? loadProject(ctx.cwd);
	if (!project) {
		throw new Error(
			`No pom.xml found in ${ctx.cwd} or any parent directory. pi-mvn needs a Maven project; use bash for non-Maven builds.`,
		);
	}
	return project;
}

function describeApp(app: BackgroundApp): string {
	const state = app.child.exitCode !== null ? `exited (${app.child.exitCode})` : "running";
	const seconds = Math.round((Date.now() - app.startedAt) / 1000);
	return `${app.id}  ${state}  ${seconds}s  ${app.command}\n  log: ${app.logPath}`;
}

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------ panel ---

	let tui: TUI | undefined;
	let ticker: NodeJS.Timeout | undefined;
	let tickMs = 0;
	let frame = 0;

	/** Re-tune the redraw interval: fast while building, slow while an app runs, off when idle. */
	function retune(): void {
		const anyApp = [...runningApps.values()].some((app) => app.child.exitCode === null);
		const wanted = !panel.config.enabled || !panel.project ? 0 : panel.running ? 120 : anyApp ? 1000 : 0;
		if (wanted === tickMs) return;
		tickMs = wanted;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (!wanted) return;
		ticker = setInterval(() => {
			frame++;
			tui?.requestRender();
		}, wanted);
		ticker.unref?.();
	}

	function refresh(): void {
		retune();
		tui?.requestRender();
	}

	function mount(ctx: ExtensionContext | ExtensionCommandContext): void {
		if (!panel.config.enabled || !panel.project) {
			ctx.ui.setWidget("pi-mvn-panel", undefined);
			retune();
			return;
		}
		ctx.ui.setWidget(
			"pi-mvn-panel",
			(instance, theme) => {
				tui = instance;
				return {
					// Rendered fresh every frame, so a theme switch needs no cache busting.
					render: (width: number) => renderPanel(theme, width, frame),
					invalidate: () => {},
				};
			},
			{ placement: panel.config.placement },
		);
		retune();
	}

	pi.on("session_start", async (_event, ctx) => {
		panel.project = loadProject(ctx.cwd);
		if (ctx.hasUI) mount(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		stopAllApps();
	});

	const report = (text: string) => {
		pi.sendMessage({ customType: "pi-mvn", content: text, display: true, details: {} }, { deliverAs: "nextTurn" });
	};

	// A malformed menuKey in the config file must not take the whole extension down.
	try {
		registerMenuShortcut();
	} catch {
		panel.config.menuKey = DEFAULT_CONFIG.menuKey;
		registerMenuShortcut();
	}

	function registerMenuShortcut(): void {
		pi.registerShortcut(panel.config.menuKey as KeyId, {
			description: "Maven actions menu",
			handler: async (ctx) => {
				const project = panel.project ?? loadProject(ctx.cwd);
				if (!project) {
					ctx.ui.notify("No Maven project here.", "warning");
					return;
				}
				panel.project = project;
				await openMenu(ctx, project, { report, refresh });
			},
		});
	}

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
			const spec: ActionSpec = {
				id: goals.join("+"),
				label: goals.join(" "),
				goals,
				extra: [...(params.skipTests ? ["-DskipTests"] : []), ...(params.args ?? [])],
				module: params.module,
				profiles: params.profiles,
				timeoutMinutes: params.timeoutMinutes,
			};

			const outcome = await runAction(project, spec, {
				signal,
				onStateChange: refresh,
				onProgress: onUpdate ? (text) => onUpdate({ content: [{ type: "text", text }], details: {} }) : undefined,
			});
			if (!outcome.ok) throw new Error(outcome.text);
			return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
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
			const goals = scope === "unit" ? ["test"] : ["verify"];
			const extra: string[] = [];

			if (scope === "unit") {
				if (params.filter) extra.push(...filterArgs(params.filter));
			} else if (scope === "integration") {
				// Surefire and Failsafe share -DskipTests, so there is no clean "skip
				// only unit tests" switch. Handing Surefire a pattern that matches
				// nothing is the standard way to run Failsafe alone.
				extra.push("-Dtest=!*", "-Dsurefire.failIfNoSpecifiedTests=false", "-Dfailsafe.failIfNoSpecifiedTests=false");
				if (params.filter) extra.push(`-Dit.test=${params.filter}`);
			} else {
				if (params.filter) extra.push(...filterArgs(params.filter), `-Dit.test=${params.filter}`);
			}

			const outcome = await runAction(
				project,
				{
					id: params.filter ? `test:${params.filter}` : "test",
					label: params.filter ? `test ${params.filter}` : "test",
					goals,
					extra: [...extra, ...(params.args ?? [])],
					module: params.module,
					profiles: params.profiles,
					timeoutMinutes: params.timeoutMinutes,
				},
				{
					signal,
					onStateChange: refresh,
					onProgress: onUpdate ? (text) => onUpdate({ content: [{ type: "text", text }], details: {} }) : undefined,
				},
			);
			if (!outcome.ok) throw new Error(outcome.text);
			return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
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
					refresh();
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
			const target = resolveRunTarget(project, params);

			if (params.background) {
				const app = startBackground(target.command, target.args, project.root, env);
				refresh();
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

			const outcome = await runAction(
				project,
				{
					id: "run",
					label: target.label,
					goals: [],
					prebuilt: { command: target.command, args: target.args },
					timeoutMinutes: params.timeoutMinutes,
				},
				{
					signal,
					onStateChange: refresh,
					onProgress: onUpdate ? (text) => onUpdate({ content: [{ type: "text", text }], details: {} }) : undefined,
				},
			);
			return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
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

	const SUBCOMMANDS = ["menu", "build", "rebuild", "package", "verify", "test", "run", "info", "deps", "logs", "stop", "panel"];

	/** `/mvn panel <on|off|right|left|full|above|below>`; no argument toggles. */
	function configurePanel(ctx: ExtensionCommandContext, value: string | undefined): void {
		switch (value) {
			case undefined:
			case "":
			case "toggle":
				panel.config.enabled = !panel.config.enabled;
				break;
			case "on":
			case "off":
				panel.config.enabled = value === "on";
				break;
			case "right":
			case "left":
			case "full":
				panel.config.align = value;
				panel.config.enabled = true;
				break;
			case "above":
				panel.config.placement = "aboveEditor";
				panel.config.enabled = true;
				break;
			case "below":
				panel.config.placement = "belowEditor";
				panel.config.enabled = true;
				break;
			default:
				ctx.ui.notify(`/mvn panel <on|off|right|left|full|above|below>`, "warning");
				return;
		}
		saveConfig(panel.config);
		mount(ctx);
		ctx.ui.notify(
			panel.config.enabled ? `Panel ${panel.config.align}, ${panel.config.placement}.` : "Maven panel hidden.",
			"info",
		);
	}

	pi.registerCommand("mvn", {
		description: "Maven: /mvn menu | build | test [filter] | run | info | deps | logs | stop | panel | <raw maven args>",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},

		handler: async (args, ctx: ExtensionCommandContext) => {
			const [sub = "info", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (sub === "panel") {
				configurePanel(ctx, rest[0]);
				return;
			}

			let project: MavenProject;
			try {
				project = requireProject(ctx);
			} catch (error) {
				ctx.ui.notify(String((error as Error).message), "error");
				return;
			}
			panel.project = project;

			if (sub === "menu") {
				await openMenu(ctx, project, { report, refresh });
				return;
			}

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

			if (sub === "logs" || sub === "stop") {
				const apps = [...runningApps.values()];
				const app = rest[0] ? runningApps.get(rest[0]) : apps[apps.length - 1];
				if (!app) {
					ctx.ui.notify("No background app running.", "warning");
					return;
				}
				if (sub === "stop") {
					await stopApp(app);
					runningApps.delete(app.id);
					refresh();
					ctx.ui.notify(`Stopped ${app.id}.`, "info");
					return;
				}
				report(`${describeApp(app)}\n\n${tailLog(app.logPath, 100)}`);
				return;
			}

			if (sub === "run") {
				try {
					const target = resolveRunTarget(project, { mainClass: rest[0] });
					const app = startBackground(target.command, target.args, project.root);
					refresh();
					ctx.ui.notify(`Started ${app.id} — ${target.label}. /mvn logs to follow.`, "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
				return;
			}

			if (sub === "deps") {
				ctx.ui.setStatus("pi-mvn", "mvn dependency:tree");
				try {
					const run = await runMaven(project.runner, [...BASE_ARGS, "dependency:tree"], {
						cwd: project.root,
						timeoutMs: 300_000,
					});
					report(formatDependencyTree(run.output, 2));
				} finally {
					ctx.ui.setStatus("pi-mvn", undefined);
				}
				return;
			}

			const spec: ActionSpec =
				sub === "build"
					? { ...PRESETS.compile, goals: rest.length ? rest : ["compile"], label: rest.length ? rest.join(" ") : "compile" }
					: PRESETS[sub]
						? sub === "test" && rest[0]
							? { ...PRESETS.test, id: `test:${rest[0]}`, label: `test ${rest[0]}`, extra: filterArgs(rest[0]) }
							: PRESETS[sub]
						: // Anything unrecognised is passed straight through to Maven.
							{ id: "raw", label: [sub, ...rest].join(" "), goals: [sub, ...rest] };

			ctx.ui.setStatus("pi-mvn", `${project.runnerLabel} ${spec.goals.join(" ")}`);
			try {
				const outcome = await runAction(project, spec, {
					onStateChange: () => {
						refresh();
						if (panel.running?.phase) ctx.ui.setStatus("pi-mvn", `mvn: ${panel.running.phase}`);
					},
				});
				report(outcome.text);
				ctx.ui.notify(outcome.ok ? `${spec.label} OK` : `${spec.label} FAILED`, outcome.ok ? "info" : "error");
			} finally {
				ctx.ui.setStatus("pi-mvn", undefined);
			}
		},
	});
}
