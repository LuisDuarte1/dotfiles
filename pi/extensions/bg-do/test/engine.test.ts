import assert from "node:assert/strict";
import test from "node:test";
import { type Client, type Engine, HAVE_XONSH, startEngine } from "./engine.ts";

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
