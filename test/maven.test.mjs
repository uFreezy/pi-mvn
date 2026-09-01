import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackground, stopApp, tailLog } from "../src/maven.ts";

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("stopping a background app kills the JVMs it forked, not just mvn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-mvn-tree-"));
	const pidFile = join(dir, "pid");
	const childPidFile = join(dir, "childpid");

	// `sh` that writes its own pid and a forked sleeper's pid, then waits. The
	// forked process is in the same process group — the case `mvn`+surefire/JVM
	// presents, and the one a bare child.kill("#SIGTERM") used to leave behind.
	const app = startBackground(
		"sh",
		["-c", `echo $$ > ${pidFile}; (sleep 30) & echo $! > ${childPidFile}; wait`],
		dir,
	);

	while (true) {
		const p = (fn) => {
			try {
				return readFileSync(fn, "utf8").trim();
			} catch {
				return "";
			}
		};
		if (p(pidFile) && p(childPidFile)) break;
		await new Promise((r) => setTimeout(r, 10));
	}
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	const childPid = Number(readFileSync(childPidFile, "utf8").trim());
	assert.ok(alive(pid), "the app itself should be running");
	assert.ok(alive(childPid), "the forked sleeper should be running");

	await stopApp(app);

	assert.ok(!alive(pid), "the app must be stopped");
	assert.ok(!alive(childPid), "the forked process must die with it, not linger as an orphan");
});

test("tailLog reads only the tail of a large log", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-mvn-tail-"));
	const path = join(dir, "big.log");
	writeFileSync(path, ["TOP-MARKER", ...Array(200).fill("x".repeat(1000))].join("\n") + "\nlast-line\n");

	const tail = tailLog(path, 2);
	assert.ok(tail.endsWith("last-line"));
	assert.ok(!tail.includes("TOP-MARKER"), "only the end of the file should be read");
	assert.equal(tailLog(path, 1), "last-line");
});
