/**
 * The Maven panel: a persistent status strip in the pi TUI.
 *
 * pi's widget API only offers "aboveEditor" and "belowEditor" placements — the
 * TUI stacks full-width line regions and has no horizontal split an extension
 * can claim, so a true side-docked tool window is not reachable. `align: "right"`
 * is the closest equivalent: the block hugs the terminal's right edge.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BackgroundApp, runningApps, tailLog } from "./maven.ts";
import type { ActionSpec } from "./actions.ts";
import type { TestCounts } from "./parse.ts";
import type { MavenProject } from "./project.ts";

export interface PanelConfig {
	enabled: boolean;
	placement: "aboveEditor" | "belowEditor";
	align: "right" | "left" | "full";
	/** Key that opens the actions menu. */
	menuKey: string;
}

export const DEFAULT_CONFIG: PanelConfig = {
	enabled: true,
	placement: "aboveEditor",
	align: "right",
	menuKey: "alt+m",
};

const CONFIG_PATH = () => join(getAgentDir(), "pi-mvn.json");

export function loadConfig(): PanelConfig {
	try {
		return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH(), "utf8")) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: PanelConfig): void {
	try {
		writeFileSync(CONFIG_PATH(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// A read-only home directory is not worth failing a build over; the
		// setting simply stays session-local.
	}
}

/** A Maven invocation currently in flight. */
export interface RunState {
	label: string;
	startedAt: number;
	phase?: string;
}

/** The outcome of the most recent invocation, kept for the idle panel line. */
export interface LastBuild {
	label: string;
	ok: boolean;
	durationMs: number;
	tests?: TestCounts;
	errorCount: number;
	/** First failure, already formatted, e.g. "AppTest.shouldFail:8  expected: <5>". */
	headline?: string;
}

export interface PanelState {
	project?: MavenProject;
	running?: RunState;
	last?: LastBuild;
	/** Surefire selectors for the tests that failed last, for "rerun failed". */
	lastFailedTests: string[];
	/** The last invocation, replayed verbatim by the menu's "rerun". */
	lastSpec?: ActionSpec;
	config: PanelConfig;
}

export const panel: PanelState = { lastFailedTests: [], config: loadConfig() };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function elapsed(since: number): string {
	const seconds = Math.floor((Date.now() - since) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function duration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Pull a listening port out of an app's log.
 *
 * ponytail: pattern match over the last 200 lines, covering Spring Boot, Quarkus
 * and Micronaut startup banners. Anything else simply shows no port.
 */
const PORT_PATTERNS = [
	/(?:Tomcat|Netty|Undertow) started on port\(?s?\)?:?\s*(\d{2,5})/i,
	/started on port\(?s?\)?:?\s*(\d{2,5})/i,
	/Listening on:?\s*\S*?:(\d{2,5})/i,
	/Server (?:running|listening) (?:at|on)\D{0,10}(\d{2,5})/i,
];

export function matchPort(text: string): string | undefined {
	for (const pattern of PORT_PATTERNS) {
		const match = text.match(pattern);
		if (match) return match[1];
	}
	return undefined;
}

export function detectPort(app: BackgroundApp): string | undefined {
	return matchPort(tailLog(app.logPath, 200));
}

function describeApps(theme: Theme): string | undefined {
	const apps = [...runningApps.values()].filter((app) => app.child.exitCode === null);
	if (!apps.length) return undefined;

	if (apps.length === 1) {
		const app = apps[0];
		const port = detectPort(app);
		return `${theme.fg("success", "●")} ${app.id}  up ${elapsed(app.startedAt)}${port ? `  :${port}` : ""}`;
	}
	return `${theme.fg("success", "●")} ${apps.length} apps running`;
}

function statusLine(theme: Theme, frame: number): string | undefined {
	if (panel.running) {
		const spinner = theme.fg("accent", SPINNER[frame % SPINNER.length]);
		const phase = panel.running.phase ? theme.fg("muted", `  ${panel.running.phase}`) : "";
		return `${spinner} ${theme.fg("text", panel.running.label)}${phase}  ${theme.fg("dim", elapsed(panel.running.startedAt))}`;
	}

	const last = panel.last;
	if (!last) return undefined;

	const mark = last.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const parts = [last.label];
	if (last.tests) parts.push(`${last.tests.run} run · ${last.tests.failures + last.tests.errors} failed`);
	else if (!last.ok && last.errorCount) parts.push(`${last.errorCount} error${last.errorCount === 1 ? "" : "s"}`);
	parts.push(duration(last.durationMs));

	return `${mark} ${theme.fg(last.ok ? "muted" : "text", parts.join("  ·  "))}`;
}

/**
 * Build the panel's lines. Adaptive: one header line when idle and clean, a
 * status line when something ran or is running, a third line for the failure
 * that matters most.
 */
export function renderPanel(theme: Theme, width: number, frame: number): string[] {
	const project = panel.project;
	if (!project || width < 24) return [];

	const identity = [
		project.artifactId ?? "maven",
		project.runnerLabel,
		project.javaTarget ? `java ${project.javaTarget}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");

	const header = `${theme.fg("dim", "─")} ${theme.fg("accent", "maven")}  ${theme.fg("muted", identity)}  ${theme.fg("dim", `${panel.config.menuKey} ─`)}`;

	const lines = [header];

	const status = statusLine(theme, frame);
	const apps = describeApps(theme);
	if (status && apps) {
		const combined = `  ${status}     ${apps}`;
		lines.push(visibleWidth(combined) <= width ? combined : `  ${status}`);
		if (visibleWidth(combined) > width) lines.push(`  ${apps}`);
	} else if (status) {
		lines.push(`  ${status}`);
	} else if (apps) {
		lines.push(`  ${apps}`);
	}

	if (!panel.running && panel.last?.headline) {
		lines.push(`  ${theme.fg("error", truncateToWidth(panel.last.headline, width - 2))}`);
	}

	return align(lines, width, panel.config.align, theme);
}

function align(lines: string[], width: number, mode: PanelConfig["align"], theme: Theme): string[] {
	if (mode === "left") return lines.map((line) => truncateToWidth(line, width));

	if (mode === "full") {
		// Stretch only the header's trailing rule out to the full width.
		const [header, ...rest] = lines;
		const pad = Math.max(0, width - visibleWidth(header));
		return [`${header}${theme.fg("dim", "─".repeat(pad))}`, ...rest.map((line) => truncateToWidth(line, width))];
	}

	return lines.map((line) => {
		const truncated = truncateToWidth(line, width);
		return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
	});
}
