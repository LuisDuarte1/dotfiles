import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore, killJob, lastLine, tailLines } from "./jobs.ts";
import { job } from "./test/job.ts";

test("the store lists running jobs in start order, then finished ones newest first", () => {
	const store = new JobStore();
	store.set([
		job({ id: "bg-10", running: false, returncode: 0 }),
		job({ id: "bg-2" }),
		job({ id: "bg-9", running: false, returncode: 1 }),
		job({ id: "bg-11" }),
		job({ id: "bg-1", running: false, returncode: 0 }),
	]);
	assert.deepEqual(
		store.all().map((j) => j.id),
		["bg-2", "bg-11", "bg-10", "bg-9", "bg-1"],
	);
	assert.equal(store.get("bg-9")?.returncode, 1);
	assert.equal(store.get("bg-99"), undefined);
});

test("only jobs with a pending notify are pending, and listeners hear each change", () => {
	const store = new JobStore();
	let calls = 0;
	const off = store.subscribe(() => calls++);
	store.set([]);
	assert.equal(calls, 0, "empty to empty is no change");
	store.set([job({ id: "bg-1" }), job({ id: "bg-2", notify: [null] }), job({ id: "bg-3", notify: ["ready"] })]);
	assert.deepEqual(
		store.pending().map((j) => j.id),
		["bg-2", "bg-3"],
	);
	store.set([]);
	assert.equal(calls, 2);
	off();
	store.set([job()]);
	assert.equal(calls, 2, "unsubscribed");
});

test("a log tail drops the cut first line, terminal noise and a missing file", () => {
	const dir = mkdtempSync(join(tmpdir(), "bg-do-jobs-"));
	try {
		const log = join(dir, "job.log");
		writeFileSync(log, `${"x".repeat(50)}\nfirst\n\x1b[32mPASS\x1b[0m\n10%\r55%\r\n\n`);
		assert.deepEqual(tailLines(log, 1 << 20), ["x".repeat(50), "first", "PASS", "55%", ""]);
		assert.deepEqual(tailLines(log, 30), ["first", "PASS", "55%", ""]);
		assert.equal(lastLine(log), "55%");
		assert.deepEqual(tailLines(join(dir, "gone.log"), 100), []);
		assert.equal(lastLine(join(dir, "gone.log")), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a kill sends SIGTERM to the job's process group, or to its pid without setsid", () => {
	const sent: [number, string][] = [];
	const kill = (pid: number, signal: string) => sent.push([pid, signal]);
	assert.equal(killJob(job({ pid: 321 }), kill), undefined);
	assert.equal(killJob(job({ pid: 322, group: false }), kill), undefined);
	assert.deepEqual(sent, [
		[-321, "SIGTERM"],
		[322, "SIGTERM"],
	]);
	assert.equal(killJob(job({ running: false, returncode: 0 }), kill), "bg-1 is not running");
	assert.equal(killJob(job({ pid: null }), kill), "bg-1 has no pid");
	const gone = () => {
		throw new Error("kill ESRCH");
	};
	assert.equal(killJob(job(), gone), "kill ESRCH");
	assert.equal(sent.length, 2);
});
