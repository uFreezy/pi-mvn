/**
 * End-to-end smoke test: registers the real extension against a stub pi API and
 * drives every tool over a generated Maven project.
 *
 * Needs a JDK, `mvn` on PATH, and network access for the first dependency
 * download, so it is not part of `npm test`. Run it with `npm run smoke`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.ts";

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>smoke</artifactId>
  <version>1.0-SNAPSHOT</version>
  <properties><maven.compiler.release>17</maven.compiler.release></properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
    <version>3.2.5</version>
  </plugin></plugins></build>
</project>
`;

const APP = `package com.example;

public class App {
    public static int add(int a, int b) { return a + b; }

    public static void main(String[] args) {
        System.out.println("started");
    }
}
`;

const TEST = `package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class AppTest {
    @Test void shouldAdd() { assertEquals(4, App.add(2, 2)); }
    @Test void shouldFail() { assertEquals(5, App.add(2, 2)); }
}
`;

function createProject() {
	const root = mkdtempSync(join(tmpdir(), "pi-mvn-smoke-"));
	mkdirSync(join(root, "src/main/java/com/example"), { recursive: true });
	mkdirSync(join(root, "src/test/java/com/example"), { recursive: true });
	writeFileSync(join(root, "pom.xml"), POM);
	writeFileSync(join(root, "src/main/java/com/example/App.java"), APP);
	writeFileSync(join(root, "src/test/java/com/example/AppTest.java"), TEST);
	return root;
}

/** Minimal stand-in for ExtensionAPI: records what the extension registers. */
function stubApi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	return {
		tools,
		commands,
		handlers,
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: () => {},
		registerFlag: () => {},
		sendMessage: () => {},
		on: (event, handler) => handlers.set(event, handler),
	};
}

const root = createProject();
const ctx = { cwd: root, ui: { notify: () => {}, setStatus: () => {} } };
const pi = stubApi();
extension(pi);

assert.deepEqual([...pi.tools.keys()].sort(), ["mvn_build", "mvn_project", "mvn_run", "mvn_test"]);
assert.ok(pi.commands.has("mvn"), "the /mvn command must be registered");

const call = (name, params) => pi.tools.get(name).execute("smoke", params, undefined, undefined, ctx);
const textOf = (result) => result.content[0].text;

console.log(`project: ${root}`);

// --- overview answers without building
const overview = textOf(await call("mvn_project", { what: "overview" }));
console.log(`\n[overview]\n${overview}`);
assert.match(overview, /Artifact: {2}smoke \(jar\)/);
assert.match(overview, /com\.example\.App/, "the main method should be discovered");

// --- a clean compile
const build = textOf(await call("mvn_build", { goals: ["compile"] }));
console.log(`\n[build]\n${build}`);
assert.match(build, /^OK {2}mvn/);

// --- a broken compile throws, with file:line:column in the message
const appPath = join(root, "src/main/java/com/example/App.java");
const original = readFileSync(appPath, "utf8");
writeFileSync(appPath, original.replace("return a + b;", "return a.nope();"));
const broken = await call("mvn_build", { goals: ["compile"] }).then(
	() => assert.fail("a broken compile must throw"),
	(error) => error.message,
);
console.log(`\n[build broken]\n${broken}`);
assert.match(broken, /^ {2}src\/main\/java\/com\/example\/App\.java:\d+:\d+ {2}\S/m);
assert.match(broken, /Compile errors \(1\)/, "the same error must not be listed twice");
writeFileSync(appPath, original);

// --- a failing test reports the assertion, not the stack trace
const failed = await call("mvn_test", {}).then(
	() => assert.fail("a failing test run must throw"),
	(error) => error.message,
);
console.log(`\n[test]\n${failed}`);
assert.match(failed, /Tests: 2 run, 1 failed/);
assert.match(failed, /AppTest\.shouldFail:\d+ {2}expected: <5> but was: <4>/);
assert.ok(failed.split("\n").length < 12, "a test failure summary must stay short");

// --- filtering down to the passing test succeeds
const filtered = textOf(await call("mvn_test", { filter: "AppTest#shouldAdd" }));
console.log(`\n[test filtered]\n${filtered}`);
assert.match(filtered, /^OK {2}mvn/);
assert.match(filtered, /Tests: 1 run, 0 failed/);

// --- background app lifecycle
const started = textOf(await call("mvn_run", { background: true }));
console.log(`\n[run]\n${started}`);
const id = started.match(/(app-\S+?) in background/)?.[1];
assert.ok(id, "starting in the background must return an id");

await new Promise((resolve) => setTimeout(resolve, 25_000));
const logs = textOf(await call("mvn_run", { action: "logs", id }));
console.log(`\n[logs tail]\n${logs.split("\n").slice(-6).join("\n")}`);
assert.match(logs, /started/, "the app's stdout must reach the log");

console.log(`\n[stop]\n${textOf(await call("mvn_run", { action: "stop", id }))}`);
await pi.handlers.get("session_shutdown")({}, ctx);

console.log("\nsmoke: all checks passed");
