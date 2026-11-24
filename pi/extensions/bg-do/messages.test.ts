import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { apiBlock, ENGINE_INTERRUPT, errorText, SUBPROC_HINT } from "./messages.ts";

const code = "bg.wait(j)";
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("an interrupt from the timer names the timeout", () => {
	const text = errorText({ code, err: `${ENGINE_INTERRUPT}\n`, cause: "timeout", timeoutS: 120 });
	assert.match(text, /hit the 120s bg_do timeout/);
	assert.match(text, /still running/);
});

test("an interrupt from the user's abort is not called a timeout", () => {
	const text = errorText({ code, err: ENGINE_INTERRUPT, cause: "user", timeoutS: 120 });
	assert.equal(text, "Interrupted by the user, not a timeout. Background jobs are still running.");
});

test("any other error passes through unchanged, whatever the cause", () => {
	const err = "Traceback (most recent call last):\nKeyError: 'bg-9'\n";
	assert.equal(errorText({ code, err, cause: "user", timeoutS: 120 }), err);
	assert.equal(errorText({ code, err, timeoutS: 120 }), err);
});

test("a SyntaxError from a chained command inside $() gets the bash -c hint", () => {
	const err = '  File "<stdin>", line 1\n    x = $(cd /tmp && ls)\nSyntaxError: code: and\n';
	assert.equal(errorText({ code: "x = $(cd /tmp && ls)", err, timeoutS: 120 }), `${err.trimEnd()}\n${SUBPROC_HINT}`);
	assert.match(errorText({ code: "x = $(a || b)", err, timeoutS: 120 }), /bash -c/);
});

test("the hint stays out of SyntaxErrors it cannot explain, and out of other errors", () => {
	const syntax = "SyntaxError: invalid syntax\n";
	assert.equal(errorText({ code: "print($(ls)", err: syntax, timeoutS: 120 }), syntax);
	assert.equal(errorText({ code: "if a && b: pass", err: syntax, timeoutS: 120 }), syntax);
	const other = "NameError: name 'x' is not defined\n";
	assert.equal(errorText({ code: "x = $(a && b)", err: other, timeoutS: 120 }), other);
});

test("the API block in USAGE.md names every public method of the engine's bg object", () => {
	const block = apiBlock(read("./USAGE.md"));
	assert.ok(block.split("\n").length >= 9, block);
	const engine = read("./bg_engine.xsh");
	const cls = engine.slice(engine.indexOf("class _BG:"), engine.indexOf("\nbg = _BG()"));
	const names = [...cls.matchAll(/^ {4}(?:def ([a-z]\w*)\(|([a-z]\w*) = \w+$)/gm)].map((m) => m[1] ?? m[2]);
	assert.ok(names.includes("run") && names.includes("start") && names.includes("tail"), names.join());
	for (const name of names) assert.match(block, new RegExp(`bg\\.${name}\\(`), `bg.${name} missing from USAGE.md`);
});

test("a USAGE.md without the API section yields no block", () => {
	assert.equal(apiBlock("# bg_do\n```\nbg.run()\n```\n"), "");
});
