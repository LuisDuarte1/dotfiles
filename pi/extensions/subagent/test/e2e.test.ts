import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, before, test } from "node:test";
import { createRun, replaySession } from "../run.ts";
import { finalAssistantText, makeSandbox, runJson, type Sandbox, subagentResult } from "./harness.ts";

let sandbox: Sandbox;
before(() => {
	sandbox = makeSandbox();
});
after(() => sandbox.cleanup());

test("runs the child over RPC and returns its answer, usage and session", async () => {
	const events = await runJson(sandbox, "delegate SLEEP1 please");
	const result = subagentResult(events);

	assert.equal(result.content[0].text, "child done; users=[]");
	assert.equal(result.details.status, "done");
	assert.equal(result.details.model, "fake/child");
	assert.equal(result.usage.totalTokens, 30, "two child turns of 15 tokens each");
	assert.ok(fs.existsSync(result.details.sessionFile), "child session file is kept");
	assert.ok(result.details.sessionFile.startsWith(`${sandbox.agentDir}/subagent-sessions/`));
	assert.equal(finalAssistantText(events), "parent saw: child done; users=[]");
	assert.equal(result.details.turns, 2);
	assert.equal(result.details.tokens, 30);
	assert.ok(result.details.durationMs >= 1000, "the child slept for a second");
});

test("overrides the agent model for one call without changing its definition", async () => {
	const result = subagentResult(await runJson(sandbox, "delegate MODEL=fake/alternate please"));

	assert.equal(result.details.status, "done");
	assert.equal(result.details.agent, "tester");
	assert.equal(result.details.model, "fake/alternate");
	const entries = fs.readFileSync(result.details.sessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	const response = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	assert.equal(response.message.provider, "fake");
	assert.equal(response.message.model, "alternate");

	const next = subagentResult(await runJson(sandbox, "delegate please"));
	assert.equal(next.details.status, "done");
	assert.equal(next.details.model, "fake/child");
});

for (const model of ["fake/missing-model", "alternate"]) {
	test(`rejects model override ${model} instead of silently choosing another model`, async () => {
		const result = subagentResult(await runJson(sandbox, `delegate MODEL=${model} please`));

		assert.equal(result.content[0].text, `Unknown model override "${model}". Use an exact provider/model-id.`);
	});
}

test("streams live progress while the child works", async () => {
	const updates = (await runJson(sandbox, "delegate SLEEP2 please"))
		.filter((e) => e.type === "tool_execution_update" && e.toolName === "subagent")
		.map((e) => e.partialResult.details);

	assert.ok(updates.length >= 2, "ticker keeps updating during the sleep");
	assert.ok(updates.every((d) => d.status === "running" && d.runId === updates[0].runId));
	assert.ok(updates.some((d) => d.tokens === 15), "usage advances before the child finishes");
});

test("replays a finished child session into a transcript", async () => {
	const { sessionFile } = subagentResult(await runJson(sandbox, "delegate SLEEP1 please")).details;
	const run = replaySession(createRun({ id: 1, task: "t" }), fs.readFileSync(sessionFile, "utf-8"));

	assert.deepEqual(
		run.transcript.map((i) => (i.kind === "tool" ? `tool:${i.name}:${i.state}:${i.output.trim()}` : `${i.kind}:${"text" in i ? i.text : ""}`)),
		["thinking:planning a nap", "tool:bash:done:slept", "text:child done; users=[]"],
	);
	assert.equal(run.turns, 2);
});

test("reports child model errors as a failed subagent", async () => {
	const result = subagentResult(await runJson(sandbox, "delegate FAIL now"));

	assert.equal(result.details.status, "error");
	assert.match(result.content[0].text, /^Subagent error: boom from fake child/);
});

test("rejects unknown agents", async () => {
	const result = subagentResult(await runJson(sandbox, "delegate AGENT=nope hi"));

	assert.match(result.content[0].text, /Unknown agent "nope"/);
});

test("passes large contexts through stdin instead of argv", async () => {
	const result = subagentResult(await runJson(sandbox, "delegate BIG context"));

	assert.equal(result.details.status, "done");
});
