import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBuildResult, formatDependencyTree, parseBuildOutput } from "../src/parse.ts";

const COMPILE_FAILURE = `[INFO] Scanning for projects...
[INFO] --- compiler:3.13.0:compile (default-compile) @ demo ---
[INFO] Compiling 1 source file with javac [debug target 17] to target/classes
[INFO] -------------------------------------------------------------
[ERROR] COMPILATION ERROR :
[INFO] -------------------------------------------------------------
[ERROR] /home/x/demo/src/main/java/com/example/App.java:[7,20] cannot find symbol
  symbol:   method fooo()
  location: class com.example.App
[ERROR] /home/x/demo/src/main/java/com/example/App.java:[9,5] ';' expected
[INFO] 2 errors
[INFO] -------------------------------------------------------------
[INFO] ------------------------------------------------------------------------
[INFO] BUILD FAILURE
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  1.842 s
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile (default-compile) on project demo: Compilation failure
[ERROR] -> [Help 1]
[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.
`;

test("compile errors carry file, line, column, message and javac detail", () => {
	const result = parseBuildOutput(COMPILE_FAILURE);

	assert.equal(result.ok, false);
	assert.equal(result.compileErrors.length, 2);

	const [first, second] = result.compileErrors;
	assert.equal(first.file, "/home/x/demo/src/main/java/com/example/App.java");
	assert.equal(first.line, 7);
	assert.equal(first.column, 20);
	assert.equal(first.message, "cannot find symbol");
	assert.deepEqual(first.detail, ["symbol:   method fooo()", "location: class com.example.App"]);
	assert.equal(second.line, 9);
	assert.equal(second.message, "';' expected");

	assert.equal(result.totalTime, "1.842 s");
	assert.ok(result.goals.includes("compiler:compile"));
});

test("boilerplate never reaches the model as a generic error", () => {
	const { generic } = parseBuildOutput(COMPILE_FAILURE);

	assert.ok(generic.some((line) => line.startsWith("Failed to execute goal")));
	assert.ok(!generic.some((line) => line.includes("COMPILATION ERROR")));
	assert.ok(!generic.some((line) => line.includes("re-run Maven with the -e switch")));
	assert.ok(!generic.some((line) => line.includes("[Help 1]")));
});

const TEST_FAILURE = `[INFO] --- surefire:3.2.5:test (default-test) @ demo ---
[INFO] Running com.example.AppTest
[ERROR] Tests run: 3, Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 0.03 s <<< FAILURE! -- in com.example.AppTest
[INFO]
[INFO] Results:
[INFO]
[ERROR] Failures:
[ERROR]   AppTest.shouldAdd:12 expected: <4> but was: <5>
[ERROR] Errors:
[ERROR]   AppTest.shouldParse:31 » NullPointer Cannot invoke "String.length()"
[INFO]
[ERROR] Tests run: 3, Failures: 1, Errors: 1, Skipped: 0
[INFO] BUILD FAILURE
`;

test("test failures keep test name, line, message and kind", () => {
	const result = parseBuildOutput(TEST_FAILURE);

	assert.deepEqual(result.tests, { run: 3, failures: 1, errors: 1, skipped: 0 });
	assert.equal(result.testFailures.length, 2);

	assert.deepEqual(result.testFailures[0], {
		test: "AppTest.shouldAdd",
		line: 12,
		message: "expected: <4> but was: <5>",
		kind: "failure",
	});
	assert.equal(result.testFailures[1].kind, "error");
	assert.equal(result.testFailures[1].test, "AppTest.shouldParse");

	// The per-class "Tests run: ... <<< FAILURE! -- in ..." line is not a failure entry.
	assert.ok(!result.testFailures.some((f) => f.test.startsWith("Tests")));
});

const REACTOR = `[INFO] Reactor Summary for parent 1.0-SNAPSHOT:
[INFO]
[INFO] parent ............................................. SUCCESS [  0.123 s]
[INFO] core ............................................... FAILURE [  1.234 s]
[INFO] app ................................................ SKIPPED
[INFO] BUILD FAILURE
`;

test("reactor summary yields per-module status", () => {
	const { modules } = parseBuildOutput(REACTOR);

	assert.equal(modules.length, 3);
	assert.deepEqual(modules[1], { name: "core", status: "FAILURE", time: "1.234 s" });
	assert.equal(modules[2].status, "SKIPPED");
	assert.equal(modules[2].time, undefined);
});

test("a clean build reports OK and nothing else", () => {
	const result = parseBuildOutput("[INFO] BUILD SUCCESS\n[INFO] Total time:  0.9 s\n");
	const text = formatBuildResult(result, { command: "mvn -B compile", durationMs: 900, exitCode: 0 });

	assert.equal(result.ok, true);
	assert.equal(text, "OK  mvn -B compile  (900ms)");
});

test("formatted failure is compact, relative and points at the full log", () => {
	const result = parseBuildOutput(COMPILE_FAILURE);
	const text = formatBuildResult(result, {
		command: "mvn -B compile",
		durationMs: 1842,
		exitCode: 1,
		root: "/home/x/demo",
		logPath: "/tmp/pi-mvn-a/build.log",
	});

	assert.match(text, /^FAILED {2}mvn -B compile {2}\(1\.8s\)/);
	assert.match(text, /src\/main\/java\/com\/example\/App\.java:7:20 {2}cannot find symbol/);
	assert.ok(!text.includes("/home/x/demo/src"), "absolute paths should be relativized");
	assert.match(text, /Full log: \/tmp\/pi-mvn-a\/build\.log/);
	assert.ok(text.split("\n").length < 15, "failure summary must stay short");
});

test("javac's own error format is understood too", () => {
	const { compileErrors } = parseBuildOutput(
		"[ERROR] /src/Foo.java:42: error: incompatible types: String cannot be converted to int\n",
	);

	assert.equal(compileErrors.length, 1);
	assert.equal(compileErrors[0].line, 42);
	assert.equal(compileErrors[0].column, undefined);
	assert.match(compileErrors[0].message, /incompatible types/);
});

test("dependency tree is flattened and depth-limited", () => {
	const tree = formatDependencyTree(
		`[INFO] com.example:demo:jar:1.0
[INFO] +- org.junit.jupiter:junit-jupiter:jar:5.10.2:test
[INFO] |  +- org.opentest4j:opentest4j:jar:1.3.0:test
[INFO] |  |  +- deep:deep:jar:1.0:test
[INFO] \\- com.google.guava:guava:jar:33.0.0-jre:compile
[INFO] BUILD SUCCESS
`,
		2,
	);

	const lines = tree.split("\n");
	assert.equal(lines[0], "com.example:demo:jar:1.0");
	assert.equal(lines[1], "  org.junit.jupiter:junit-jupiter:jar:5.10.2:test");
	assert.equal(lines[2], "    org.opentest4j:opentest4j:jar:1.3.0:test");
	assert.ok(!tree.includes("deep:deep"), "depth beyond the limit is dropped");
	assert.ok(!tree.includes("BUILD SUCCESS"), "non-coordinate lines are dropped");
});

test("a kilobyte-long error line is clamped before it reaches the model", () => {
	const long = "x".repeat(3000);
	const result = parseBuildOutput(`[ERROR] Failed to resolve dependencies: ${long}\n`);
	const text = formatBuildResult(result, { command: "mvn -B compile", durationMs: 10, exitCode: 1 });

	assert.ok(text.length < 900, `expected a clamped line, got ${text.length} chars`);
	assert.match(text, /… \(\+\d+ chars\)/);
});
