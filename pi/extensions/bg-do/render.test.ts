import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, jobHeader, notifyLabel, statusLabel, widgetLines } from "./render.ts";
import { job } from "./test/job.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

test("durations read like the subagent widget's", () => {
	assert.deepEqual([0, 59_999, 60_000, 252_000, 3_600_000, 7_380_000].map(formatDuration), [
		"0s",
		"59s",
		"1m00s",
		"4m12s",
		"1h00m",
		"2h03m",
	]);
});

test("a job's status names its exit code or the signal that killed it", () => {
	assert.equal(statusLabel(job()), "running");
	assert.equal(statusLabel(job({ running: false, returncode: 0 })), "exit 0");
	assert.equal(statusLabel(job({ running: false, returncode: -15 })), "signal 15");
	assert.equal(statusLabel(job({ running: false, returncode: null })), "exited");
	assert.equal(notifyLabel([null]), "on exit");
	assert.equal(notifyLabel(["listening on|error", null]), "on /listening on|error/, exit");
});

test("a header runs from start to now while running, and to its end once done", () => {
	assert.equal(jobHeader(job({ cmd: "bazel  test\n //..." }), theme, 1_252_000), "⏳ bg-1 bazel test //... [running] · 4m12s");
	const done = job({ running: false, returncode: 2, ended: 1003 });
	assert.equal(jobHeader(done, theme, 9_999_999), "✗ bg-1 make [exit 2] · 3s");
	assert.match(jobHeader(job({ cmd: "y".repeat(300) }), theme, 1_000_000), /y{79}… \[running\]/);
});

test("the widget shows one line per pending job, with what it waits for and its last line", () => {
	const jobs = [job({ id: "bg-3", notify: [null] }), job({ id: "bg-5", cmd: "npm run dev", notify: ["ready"] })];
	const tails = new Map([["bg-3", "INFO: 812 / 1,204 actions"]]);
	assert.deepEqual(widgetLines(jobs, tails, 1_012_000, theme), [
		"⏳ bg-3 make [on exit] · 12s · INFO: 812 / 1,204 actions",
		"⏳ bg-5 npm run dev [on /ready/] · 12s",
		"  /bg to list jobs",
	]);
	assert.deepEqual(widgetLines([], tails, 0, theme), []);
});
