import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame, NOTIFY_LIMITS, type NotifyEvent, notifyMessage, routeFrame } from "./frames.ts";

const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

const notify = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
	id: "bg-3",
	cmd: "npm test",
	reason: "exit",
	returncode: 1,
	line: null,
	tail: ["FAIL a.test.ts", "Tests: 1 failed"],
	...over,
});

test("frames decode from base64 JSON, and garbage decodes to null", () => {
	assert.deepEqual(decodeFrame(b64({ ready: true, pid: 7 })), { ready: true, pid: 7 });
	assert.equal(decodeFrame("not base64 json"), null);
});

test("ready, reply and notify frames are told apart", () => {
	assert.deepEqual(routeFrame({ ready: true, pid: 42 }), { kind: "ready", pid: 42 });
	assert.deepEqual(routeFrame({ out: "hi\n", err: null }), { kind: "reply", out: "hi\n", err: null });
	assert.deepEqual(routeFrame({ out: "", err: "Traceback" }), { kind: "reply", out: "", err: "Traceback" });
	const ev = { event: "notify", ...notify() };
	const { event: _kind, ...fields } = ev;
	assert.deepEqual(routeFrame(ev), { kind: "notify", event: fields });
});

test("an event never settles a pending reply, even one this version does not know", () => {
	assert.deepEqual(routeFrame({ event: "jobs", running: 2 }), { kind: "ignore" });
	assert.deepEqual(routeFrame({ event: "something-new", out: "x" }), { kind: "ignore" });
	assert.deepEqual(routeFrame(null), { kind: "ignore" });
	assert.deepEqual(routeFrame("text"), { kind: "ignore" });
});

test("a malformed notify frame still yields a deliverable event", () => {
	const r = routeFrame({ event: "notify", id: 5, reason: "weird", returncode: "1", tail: ["ok", 3] });
	assert.deepEqual(r, {
		kind: "notify",
		event: { id: "?", cmd: "", reason: "exit", returncode: null, line: null, tail: ["ok"] },
	});
});

test("an exit message names the job, the command, the exit code and the tail", () => {
	assert.equal(
		notifyMessage(notify()),
		[
			"bg_do notify: bg-3 exited with code 1.",
			"Command: npm test",
			"Last 2 lines of output:",
			"  FAIL a.test.ts",
			"  Tests: 1 failed",
		].join("\n"),
	);
	assert.match(notifyMessage(notify({ returncode: -15 })), /bg-3 was killed by signal 15\./);
	assert.match(notifyMessage(notify({ tail: [] })), /\nNo output\.$/);
});

test("a match message names the matched line and whether the job still runs", () => {
	const running = notifyMessage(notify({ reason: "match", returncode: null, line: "listening on :8080" }));
	assert.match(running, /^bg_do notify: bg-3 printed a matching line \(still running\):\n {2}listening on :8080\n/);
	const exited = notifyMessage(notify({ reason: "match", returncode: 0, line: "done" }));
	assert.match(exited, /\(it has since exited with code 0\)/);
});

test("every part of the message is cut to size, and terminal noise is dropped", () => {
	const long = "x".repeat(5000);
	const text = notifyMessage(
		notify({
			reason: "match",
			cmd: `bash -c '\n  ${long}'`,
			line: long,
			tail: [...Array.from({ length: 30 }, (_, i) => `line ${i}`), "\x1b[32mPASS\x1b[0m", `10%\r50%\r100%\r`, long],
		}),
	);
	const lines = text.split("\n");
	assert.ok(lines[2].startsWith("Command: bash -c ' xxx"), lines[2]);
	assert.equal([...lines[2].slice("Command: ".length)].length, NOTIFY_LIMITS.cmd);
	assert.equal([...lines[1].trim()].length, NOTIFY_LIMITS.line);
	const tail = lines.slice(lines.indexOf("Last 10 lines of output:") + 1);
	assert.equal(tail.length, NOTIFY_LIMITS.tailLines);
	assert.deepEqual(tail.slice(-4, -1), ["  line 29", "  PASS", "  100%"]);
	assert.equal([...tail.at(-1)!.trim()].length, NOTIFY_LIMITS.tailLine);
	assert.ok(text.length < 4000, String(text.length));
});
