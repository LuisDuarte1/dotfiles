import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type Client, type Engine, encode, HAVE_XONSH, startEngine } from "./engine.ts";

const skip = HAVE_XONSH ? false : "xonsh is not on PATH";

async function withEngine(fn: (engine: Engine, client: Client) => Promise<void>): Promise<void> {
	const engine = await startEngine();
	let client: Client | undefined;
	try {
		client = await engine.connect();
		await fn(engine, client);
	} finally {
		await client?.close();
		await engine.stop();
	}
}

test("bg.start, name= and bg.tail work as models guess them", { skip }, () =>
	withEngine(async (_engine, c) => {
		const r = await c.run(
			[
				'a = bg.start("seq 1 30", name="counter")',
				'b = bg.run("echo hi", name="greeter")',
				"bg.wait(a); bg.wait(b)",
				"print(repr(bg.tail(a, 3)))",
				"print(repr(bg.tail(a)))",
				"print(repr(bg.tail(b, 0)))",
			].join("\n"),
		);
		assert.equal(r.err, null);
		const lines = r.out.split("\n");
		assert.match(r.out, /\[bg\] started bg-1 .*: seq 1 30/);
		assert.match(r.out, /\[bg\] started bg-2 .*: echo hi/);
		assert.ok(lines.includes("'28\\n29\\n30'"), r.out);
		assert.ok(lines.includes(`'${Array.from({ length: 20 }, (_, i) => i + 11).join("\\n")}'`), r.out);
		assert.ok(lines.includes("''"), r.out);
	}));

test("a command passed where cwd goes fails at once and names the signature", { skip }, () =>
	withEngine(async (engine, c) => {
		const r = await c.run('bg.start("build", "make -j8 all")');
		assert.match(r.err ?? "", /ValueError: bg\.run\(cmd, cwd=None\): cwd 'make -j8 all' is not a directory/);
		assert.doesNotMatch(r.out, /started/);
		const ok = await c.run(`j = bg.run("pwd", cwd=${JSON.stringify(engine.dir)}); bg.wait(j); print(bg.tail(j))`);
		assert.equal(ok.err, null);
		assert.match(ok.out, new RegExp(`^${engine.dir}$`, "m"));
	}));

test("a chained command inside $() is a SyntaxError, which the extension explains", { skip }, () =>
	withEngine(async (_engine, c) => {
		const r = await c.run("x = $(cd / && ls)");
		assert.match(r.err ?? "", /SyntaxError/);
	}));

const isNotify = (f: Record<string, unknown>) => f.event === "notify";
const gate = (engine: Engine, name = "go") => join(engine.dir, name);
const waitGate = (path: string) => `until [ -e ${path} ]; do sleep 0.02; done`;

test("notify on exit sends the id, command, exit code and last ten lines", { skip }, () =>
	withEngine(async (_engine, c) => {
		const r = await c.run('j = bg.run("seq 1 25; exit 3"); bg.notify(j)');
		assert.equal(r.err, null);
		assert.match(r.out, /\[bg\] notify bg-1 on exit: end your turn/);
		const ev = await c.next(isNotify, "exit notify");
		assert.deepEqual(ev, {
			event: "notify",
			id: "bg-1",
			cmd: "seq 1 25; exit 3",
			reason: "exit",
			returncode: 3,
			line: null,
			tail: ["16", "17", "18", "19", "20", "21", "22", "23", "24", "25"],
		});
		assert.equal(c.events("notify").length, 1, "a notify fires once");
	}));

test("notify on a regex fires on the first matching line while the job runs", { skip }, () =>
	withEngine(async (engine, c) => {
		const go = gate(engine);
		await c.run(`j = bg.run("echo boot; echo 'READY on 8080'; echo 'READY on 9090'; ${waitGate(go)}")`);
		await c.run('bg.notify(j, r"READY on \\d+")');
		const ev = await c.next(isNotify, "match notify");
		assert.equal(ev.reason, "match");
		assert.equal(ev.line, "READY on 8080");
		assert.equal(ev.returncode, null);
		assert.deepEqual(ev.tail, ["boot", "READY on 8080", "READY on 9090"]);
		writeFileSync(go, "");
		const done = await c.run("print(bg.wait(j, timeout=10)['returncode'])");
		assert.equal(done.out.split("\n")[0], "0");
	}));

test("a regex that never matches still fires on exit, and a finished job fires at once", { skip }, () =>
	withEngine(async (_engine, c) => {
		await c.run('a = bg.run("echo nothing here"); bg.notify(a, "never")');
		const miss = await c.next(isNotify, "exit after a miss");
		assert.deepEqual([miss.reason, miss.line, miss.returncode], ["exit", null, 0]);
		await c.run('b = bg.run("echo early-bird"); bg.wait(b); bg.notify(b, "early")');
		const late = await c.next(isNotify, "match on a finished job");
		assert.deepEqual([late.id, late.reason, late.line, late.returncode], ["bg-2", "match", "early-bird", 0]);
		await c.run(`k = bg.run("sleep 30"); bg.notify(k); bg.kill(k)`);
		const killed = await c.next(isNotify, "exit of a killed job");
		assert.equal(killed.id, "bg-3");
		assert.ok((killed.returncode as number) !== 0, String(killed.returncode));
		const bad = await c.run("bg.notify(k, 5)");
		assert.match(bad.err ?? "", /TypeError/);
		assert.equal((await c.run("print(len(bg._watches))")).out.split("\n")[0], "0", "a bad regex registers nothing");
	}));

test("an event fired while no client is attached is queued and flushed right after ready", { skip }, () =>
	withEngine(async (engine, first) => {
		const go = gate(engine);
		// The snippet holds the engine until the watch has fired, so the event is
		// sent to the departed client, fails, and must wait in the queue.
		first.socket.write(
			encode({
				code: `j = bg.run("${waitGate(go)}; echo finished")\nbg.notify(j)\nwhile bg._watches: bg.wait(j, timeout=0.05)`,
			}),
		);
		await first.close();
		writeFileSync(go, "");
		const second = await engine.connect();
		try {
			assert.equal(second.frames[0].ready, true);
			const ev = await second.next(isNotify, "queued notify");
			assert.equal(second.frames.indexOf(ev), 1, "the queued event comes straight after ready");
			assert.deepEqual([ev.id, ev.reason, ev.returncode, ev.tail], ["bg-1", "exit", 0, ["finished"]]);
			const r = await second.run("print(len(bg._watches))");
			assert.equal(r.out.split("\n")[0], "0");
			assert.equal(second.events("notify").length, 1, "delivered once");
		} finally {
			await second.close();
		}
	}));

const isJobs = (f: Record<string, unknown>) => f.event === "jobs";
const counts = (c: Client) => c.events("jobs").map((f) => f.running);

test("the running-job count is sent on attach and on every change, once each", { skip }, () =>
	withEngine(async (engine, c) => {
		assert.deepEqual(c.frames.slice(0, 2), [{ ready: true, pid: engine.proc.pid }, { event: "jobs", running: 0 }]);
		const [goA, goB] = [gate(engine, "a"), gate(engine, "b")];
		await c.next(isJobs, "count on attach");
		await c.run(`a = bg.run("${waitGate(goA)}")`);
		assert.equal((await c.next(isJobs, "count 1")).running, 1);
		await c.run(`b = bg.run("${waitGate(goB)}")`);
		assert.equal((await c.next(isJobs, "count 2")).running, 2);
		writeFileSync(goA, "");
		assert.equal((await c.next(isJobs, "count back to 1")).running, 1);
		await c.run("bg.kill(b)");
		assert.equal((await c.next(isJobs, "count back to 0")).running, 0);
		const r = await c.run("print(len([j for j in bg.list() if j['running']]))");
		assert.equal(r.out.split("\n")[0], "0");
		assert.deepEqual(counts(c), [0, 1, 2, 1, 0]);
	}));

test("a reattached client gets the current count, not the changes it missed", { skip }, () =>
	withEngine(async (engine, first) => {
		const [goA, goB] = [gate(engine, "a"), gate(engine, "b")];
		await first.run(`keep = bg.run("${waitGate(goA)}")`);
		await first.next((f) => f.running === 1, "count 1");
		// The snippet holds the engine until the second job has ended, so that change
		// happens with no client attached, as during a /reload.
		first.socket.write(encode({ code: `j = bg.run("${waitGate(goB)}")\nwhile not bg.get(j).done: bg.wait(j, timeout=0.05)` }));
		await first.close();
		writeFileSync(goB, "");
		const second = await engine.connect();
		try {
			assert.deepEqual(second.frames[1], { event: "jobs", running: 1 });
			await second.run("print(1)");
			assert.deepEqual(counts(second), [1], "no queued counts");
			writeFileSync(goA, "");
			await second.next((f) => f.running === 0, "count 0 after reattach");
			assert.deepEqual(counts(second), [1, 0]);
		} finally {
			await second.close();
		}
	}));

test("events written while a large reply is mid-send do not tear either frame", { skip }, () =>
	withEngine(async (engine, c) => {
		const go = gate(engine);
		const jobs = 40;
		let opened = false;
		// Reading slowly keeps the reply's sendall blocked for over a second; the jobs
		// are released once part of it has arrived, so their events fire mid-send.
		c.socket.on("data", () => {
			if (!opened && c.partial > 100000) {
				opened = true;
				writeFileSync(go, "");
			}
			c.socket.pause();
			setTimeout(() => c.socket.resume(), 10);
		});
		const r = await c.run(
			`for _ in range(${jobs}): bg.notify(bg.run("${waitGate(go)}; seq 1 20"))\nprint("y" * 6000000)`,
			30000,
		);
		assert.equal(r.err, null);
		assert.ok(r.out.includes("y".repeat(6000000)));
		await c.next(() => c.events("notify").length === jobs, `${jobs} notify events`, 30000);
		assert.deepEqual(c.bad, [], "no torn frames");
		const reply = c.frames.findIndex((f) => "out" in f);
		const firstEvent = c.frames.findIndex(isNotify);
		assert.ok(reply < firstEvent, "the events waited for the reply");
		for (const ev of c.events("notify")) assert.equal((ev.tail as string[]).at(-1), "20");
	}));
