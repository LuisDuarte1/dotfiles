import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, before, test } from "node:test";
import { finalAssistantText, makeSandbox, RpcSession, runJson, type Sandbox, subagentResult } from "./harness.ts";

let sandbox: Sandbox;
before(() => {
	sandbox = makeSandbox({ autoRetry: true });
});
after(() => sandbox.cleanup());

test("auto-retry keeps a subagent alive through repeated transient provider errors", async () => {
	const result = subagentResult(await runJson(sandbox, "delegate FLAKY2 please"));

	assert.equal(result.details.status, "done");
	assert.equal(result.content[0].text, "child done; users=[]");
	const entries = fs.readFileSync(result.details.sessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	const errors = entries.filter((e) => e.type === "message" && e.message.stopReason === "error");
	assert.deepEqual(errors.map((e) => e.message.errorMessage), ["fetch failed", "fetch failed"]);
	assert.equal(entries.filter((e) => e.customType === "auto-retry-kick").length, 2);
});

test("a message queued during the backoff retries right away", async () => {
	const session = new RpcSession(sandbox, "fake/child");
	try {
		await session.send({ type: "prompt", message: "FLAKY1 go" });
		await session.waitFor((e) => e.type === "extension_ui_request" && /Retrying in 2s/.test(e.message ?? ""));
		const queuedAt = Date.now();
		assert.equal((await session.send({ type: "steer", message: "hurry" })).success, true);
		await session.waitFor((e) => e.type === "agent_settled");

		assert.ok(Date.now() - queuedAt < 1500, "did not sit out the 2s backoff");
		assert.equal(finalAssistantText(session.events), 'child done; users=["hurry"]');
	} finally {
		await session.close();
	}
});
