import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPort, panel, renderPanel } from "../src/panel.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Theme stub: identity styling, so assertions see plain text. */
const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
const WIDTH = 78;

function reset(overrides = {}) {
	panel.project = {
		root: "/tmp/demo",
		runner: "mvn",
		runnerLabel: "mvn",
		artifactId: "demo",
		packaging: "jar",
		javaTarget: "17",
		profiles: [],
		modules: [{ name: "demo", path: "" }],
		springBoot: false,
	};
	panel.running = undefined;
	panel.last = undefined;
	panel.lastFailedTests = [];
	panel.config = { enabled: true, placement: "aboveEditor", align: "right", menuKey: "alt+m" };
	Object.assign(panel, overrides);
}

test("idle and clean collapses to a single header line", () => {
	reset();
	const lines = renderPanel(theme, WIDTH, 0);

	assert.equal(lines.length, 1);
	assert.match(lines[0], /maven {2}demo · mvn · java 17/);
	assert.match(lines[0], /alt\+m/);
});

test("a build in flight adds a phase line with a spinner", () => {
	reset({ running: { label: "compile", startedAt: Date.now() - 4000, phase: "demo compiler:compile" } });
	const lines = renderPanel(theme, WIDTH, 0);

	assert.equal(lines.length, 2);
	assert.match(lines[1], /compile {2}demo compiler:compile {2}4s$/);
	assert.match(lines[1].trimStart(), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("the spinner advances with the frame counter", () => {
	reset({ running: { label: "compile", startedAt: Date.now() } });
	const first = renderPanel(theme, WIDTH, 0)[1];
	const second = renderPanel(theme, WIDTH, 1)[1];

	assert.notEqual(first, second);
});

test("a failure adds a third line naming the failing test", () => {
	reset({
		last: {
			label: "test",
			ok: false,
			durationMs: 2200,
			tests: { run: 2, failures: 1, errors: 0, skipped: 0 },
			errorCount: 0,
			headline: "AppTest.shouldFail:8  expected: <5> but was: <4>",
		},
	});
	const lines = renderPanel(theme, WIDTH, 0);

	assert.equal(lines.length, 3);
	assert.match(lines[1], /✗ test {2}· {2}2 run · 1 failed {2}· {2}2\.2s$/);
	assert.match(lines[2], /AppTest\.shouldFail:8/);
});

test("a passing build stays at two lines, with no failure row", () => {
	reset({ last: { label: "compile", ok: true, durationMs: 1800, errorCount: 0 } });
	const lines = renderPanel(theme, WIDTH, 0);

	assert.equal(lines.length, 2);
	assert.match(lines[1], /✓ compile {2}· {2}1\.8s$/);
});

test("right alignment pads every line to the terminal edge, never past it", () => {
	reset({ last: { label: "compile", ok: true, durationMs: 1800, errorCount: 0 } });

	for (const line of renderPanel(theme, WIDTH, 0)) {
		assert.equal(visibleWidth(line), WIDTH, `line should be flush right: ${JSON.stringify(line)}`);
	}
});

test("left alignment leaves lines unpadded and within the width", () => {
	reset({ last: { label: "compile", ok: true, durationMs: 1800, errorCount: 0 } });
	panel.config.align = "left";

	for (const line of renderPanel(theme, WIDTH, 0)) {
		assert.ok(visibleWidth(line) <= WIDTH);
		assert.ok(!line.startsWith(" ".repeat(4)));
	}
});

test("full alignment stretches the header rule to the width", () => {
	reset();
	panel.config.align = "full";
	const [header] = renderPanel(theme, WIDTH, 0);

	assert.equal(visibleWidth(header), WIDTH);
	assert.match(header, /─$/);
});

test("no project and absurdly narrow terminals render nothing", () => {
	reset();
	assert.deepEqual(renderPanel(theme, 10, 0), []);
	panel.project = undefined;
	assert.deepEqual(renderPanel(theme, WIDTH, 0), []);
});

test("listening ports are recognised across the common JVM banners", () => {
	assert.equal(matchPort("Tomcat started on port(s): 8080 (http)"), "8080");
	assert.equal(matchPort("Netty started on port 9090"), "9090");
	assert.equal(matchPort("Listening on: http://0.0.0.0:8081"), "8081");
	assert.equal(matchPort("nothing here"), undefined);
});
