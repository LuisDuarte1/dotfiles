import assert from "node:assert/strict";
import test from "node:test";
import { createLineSplitter } from "./rpc.ts";

function split(chunks: string[]): string[] {
	const lines: string[] = [];
	const splitter = createLineSplitter((line) => lines.push(line));
	for (const chunk of chunks) splitter.push(chunk);
	splitter.flush();
	return lines;
}

test("reassembles records split across chunks", () => {
	assert.deepEqual(split(['{"a":', "1}\n{", '"b":2}\n']), ['{"a":1}', '{"b":2}']);
});

test("keeps U+2028 and U+2029 inside a record", () => {
	const record = JSON.stringify({ text: "line\u2028sep\u2029para" });
	assert.deepEqual(split([`${record}\n`]), [record]);
});

test("strips CR, skips blank lines and flushes a trailing record", () => {
	assert.deepEqual(split(["a\r\n\n  \nb"]), ["a", "b"]);
});
