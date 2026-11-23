import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { createRun, replaySession } from "../run.ts";
import { isSubagentEnd, makeSandbox, RpcSession, type Sandbox } from "./harness.ts";

let sandbox: Sandbox;
before(() => {
	sandbox = makeSandbox();
});
after(() => sandbox.cleanup());

const text = (end: { result: { content: { text: string }[] } }) => end.result.content[0].text;

test("a named subagent continues its session, keeping its agent and model", async () => {
	const session = new RpcSession(sandbox);
	try {
		const first = await session.prompt("delegate NAME=scout MODEL=fake/alternate first");
		assert.equal(text(first), 'child done; users=[]\n\n[subagent "scout" · new]');
		assert.deepEqual(first.result.details.thread, { name: "scout", agent: "tester", prompt: 1 });

		const second = await session.prompt("delegate NAME=scout AGENT=- second");
		assert.equal(text(second), 'child done; users=["AGENT=- second"]\n\n[subagent "scout" · continued, prompt 2]');
		assert.equal(second.result.details.sessionFile, first.result.details.sessionFile);
		assert.equal(second.result.details.agent, "tester");
		assert.equal(second.result.details.model, "fake/alternate");

		const { sessionFile, thread } = second.result.details;
		const replay = replaySession(createRun({ id: 0, task: "t" }), fs.readFileSync(sessionFile, "utf-8"), thread.after);
		assert.deepEqual(
			replay.transcript.map((i) => `${i.kind}:${"text" in i ? i.text : ""}`),
			['text:child done; users=["AGENT=- second"]'],
			"the follow-up's own slice, without its prompt counted as a steer",
		);
		assert.deepEqual(replay.steers, []);

		const third = await session.prompt("delegate NAME=scout AGENT=other third");
		assert.match(text(third), /^Subagent "scout" runs as agent "tester"; omit `agent` to continue it/);
	} finally {
		await session.close();
	}
});

test("a name runs one task at a time", async () => {
	const session = new RpcSession(sandbox);
	try {
		await session.prompt("delegate PARALLEL NAME=scout");
		const texts = session.events.filter(isSubagentEnd).map(text).sort();
		assert.equal(texts.length, 2);
		assert.match(texts[0], /^Subagent "scout" is still running; wait for its result/);
		assert.match(texts[1], /^child done; users=\[\]\n\n\[subagent "scout" · new\]$/);
	} finally {
		await session.close();
	}
});

test("a forked parent inherits a copy of the named subagent", async () => {
	const parentDir = path.join(sandbox.agentDir, "parent-sessions");
	const original = new RpcSession(sandbox, "fake/parent", ["--session-dir", parentDir]);
	const first = await original.prompt("delegate NAME=scout first").finally(() => original.close());
	const childFile: string = first.result.details.sessionFile;
	const childBefore = fs.readFileSync(childFile, "utf-8");

	const [parentFile] = fs.readdirSync(parentDir).map((f) => path.join(parentDir, f));
	const fork = new RpcSession(sandbox, "fake/parent", ["--session-dir", parentDir, "--fork", parentFile]);
	const second = await fork.prompt("delegate NAME=scout second").finally(() => fork.close());

	assert.equal(text(second), 'child done; users=["second"]\n\n[subagent "scout" · continued, prompt 2]');
	assert.notEqual(path.dirname(second.result.details.sessionFile), path.dirname(childFile), "copied into the fork's own dir");
	assert.equal(fs.readFileSync(childFile, "utf-8"), childBefore, "the original parent's subagent is untouched");
});
