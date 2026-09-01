/** The panel's actions menu — the equivalent of double-clicking a goal in IntelliJ. */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { PRESETS, filterArgs, resolveRunTarget, runAction } from "./actions.ts";
import { runningApps, startBackground, stopApp, tailLog } from "./maven.ts";
import { panel, saveConfig } from "./panel.ts";
import type { MavenProject } from "./project.ts";

type AnyUiContext = ExtensionContext | ExtensionCommandContext;

/** Preset ids that always have their own row, so "rerun" never duplicates one. */
const FIXED = new Set(["compile", "rebuild", "test", "package", "verify", "clean"]);

export function menuItems(project: MavenProject): SelectItem[] {
	const list: SelectItem[] = [];
	const live = [...runningApps.values()].filter((app) => app.child.exitCode === null);

	// The fixed rows below already cover the plain presets, so "rerun" is offered
	// only for invocations they cannot express: a filtered test, custom goals.
	if (panel.lastSpec && !FIXED.has(panel.lastSpec.id)) {
		list.push({ value: "rerun:last", label: `rerun ${panel.lastSpec.label}`, description: "repeat the last invocation" });
	}
	list.push({ value: "preset:compile", label: "build", description: "mvn compile" });
	list.push({ value: "preset:rebuild", label: "rebuild", description: "mvn clean compile" });
	list.push({ value: "preset:test", label: "test", description: "mvn test" });

	if (panel.lastFailedTests.length) {
		list.push({
			value: "test:failed",
			label: `rerun ${panel.lastFailedTests.length} failed test${panel.lastFailedTests.length === 1 ? "" : "s"}`,
			description: panel.lastFailedTests.join(", "),
		});
	}

	list.push({ value: "preset:package", label: "package", description: "mvn package -DskipTests" });
	list.push({ value: "preset:verify", label: "verify", description: "mvn verify (unit + integration tests)" });

	if (live.length) {
		list.push({ value: "app:logs", label: "logs", description: `tail ${live[live.length - 1].id}` });
		list.push({ value: "app:stop", label: "stop app", description: live.map((app) => app.id).join(", ") });
	} else {
		list.push({ value: "app:start", label: "run", description: project.springBoot ? "spring-boot:run in the background" : "run the main class in the background" });
	}

	list.push({ value: "preset:clean", label: "clean", description: "mvn clean" });
	list.push({ value: "panel:align", label: `panel align: ${panel.config.align}`, description: "cycle right / left / full" });
	list.push({ value: "panel:hide", label: "hide panel", description: `bring it back with /mvn panel on` });

	return list;
}

/** Show the menu and return the chosen value, or null if dismissed. */
async function pick(ctx: AnyUiContext, project: MavenProject): Promise<string | null> {
	const list = menuItems(project);

	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(`${theme.fg("accent", "maven")}  ${theme.fg("muted", project.artifactId ?? project.root)}`, 1, 0),
		);

		const select = new SelectList(list, Math.min(list.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		select.onSelect = (item: SelectItem) => done(item.value);
		select.onCancel = () => done(null);
		container.addChild(select);

		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter run • esc close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				select.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export interface MenuDeps {
	/** Push a result block into the transcript so the agent sees it too. */
	report: (text: string) => void;
	refresh: () => void;
}

export async function openMenu(ctx: AnyUiContext, project: MavenProject, deps: MenuDeps): Promise<void> {
	if (panel.running) {
		ctx.ui.notify(`Maven is busy: ${panel.running.label}`, "warning");
		return;
	}

	const choice = await pick(ctx, project);
	if (!choice) return;

	const [kind, value] = choice.split(":");

	if (kind === "panel") {
		if (value === "hide") {
			panel.config.enabled = false;
			ctx.ui.setWidget("pi-mvn-panel", undefined);
			ctx.ui.notify("Maven panel hidden. /mvn panel on to bring it back.", "info");
		} else {
			const order = ["right", "left", "full"] as const;
			panel.config.align = order[(order.indexOf(panel.config.align) + 1) % order.length];
			ctx.ui.notify(`Panel aligned ${panel.config.align}.`, "info");
		}
		saveConfig(panel.config);
		deps.refresh();
		return;
	}

	if (kind === "app") {
		const live = [...runningApps.values()].filter((app) => app.child.exitCode === null);
		if (value === "start") {
			try {
				const target = resolveRunTarget(project, {});
				const app = startBackground(target.command, target.args, project.root);
				ctx.ui.notify(`Started ${app.id} — ${target.label}`, "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		} else if (value === "stop") {
			for (const app of live) {
				await stopApp(app);
				runningApps.delete(app.id);
			}
			ctx.ui.notify(`Stopped ${live.length} app${live.length === 1 ? "" : "s"}.`, "info");
		} else {
			const app = live[live.length - 1];
			if (app) deps.report(`${app.id}  ${app.command}\n\n${tailLog(app.logPath, 100)}`);
		}
		deps.refresh();
		return;
	}

	const spec =
		kind === "rerun"
			? panel.lastSpec
			: choice === "test:failed"
				? {
						...PRESETS.test,
						id: "test:failed",
						label: "test (failed)",
						extra: filterArgs(panel.lastFailedTests.join(",")),
					}
				: PRESETS[value];
	if (!spec) return;

	const outcome = await runAction(project, spec, { onStateChange: deps.refresh });
	deps.report(outcome.text);
	ctx.ui.notify(outcome.ok ? `${spec.label} OK` : `${spec.label} FAILED`, outcome.ok ? "info" : "error");
}
