import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
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

const sse = (events: object[]) =>
	events.map((data) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const ANTHROPIC_REPLY = sse([
	{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]);

test("a request without response headers in time is retried every 2s, with a deadline of 1x, 2x, then 3x the step", async () => {
	const abandoned: Promise<void>[] = [];
	const server = http.createServer((req, res) => {
		if (abandoned.length < 3) {
			abandoned.push(new Promise((resolve) => res.on("close", () => resolve())));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" }).end(ANTHROPIC_REPLY);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const models = {
		providers: {
			local: {
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				api: "anthropic-messages",
				apiKey: "test",
				models: [{ id: "m" }],
			},
		},
	};
	fs.writeFileSync(path.join(sandbox.agentDir, "models.json"), JSON.stringify(models));
	const session = new RpcSession({ ...sandbox, env: { ...sandbox.env, PI_AUTO_RETRY_HEADERS_TIMEOUT_MS: "1000" } }, "local/m");
	try {
		await session.send({ type: "prompt", message: "hello" });
		await session.waitFor((e) => e.type === "agent_settled");
		await Promise.all(abandoned);

		const notices = session.events.filter((e) => e.type === "extension_ui_request" && /Retrying in/.test(e.message ?? ""));
		assert.deepEqual(notices.map((e) => /within (\d+s)/.exec(e.message)?.[1]), ["1s", "2s", "3s"]);
		assert.deepEqual(notices.map((e) => /Retrying in (\d+s)/.exec(e.message)?.[1]), ["2s", "2s", "2s"]);
		assert.equal(finalAssistantText(session.events), "recovered");
	} finally {
		await session.close();
		server.closeAllConnections();
		server.close();
		fs.rmSync(path.join(sandbox.agentDir, "models.json"));
	}
});

test("network errors and request timeouts retry on a flat delay instead of backing off", async () => {
	const session = new RpcSession(sandbox, "fake/child");
	try {
		await session.send({ type: "prompt", message: "OFFLINE3 go" });
		await session.waitFor((e) => e.type === "agent_settled");

		const notices = session.events.filter((e) => e.type === "extension_ui_request" && /Retrying in/.test(e.message ?? ""));
		assert.deepEqual(notices.map((e) => /Retrying in (\d+s)/.exec(e.message)?.[1]), ["2s", "2s", "2s"]);
		assert.equal(finalAssistantText(session.events), "child done; users=[]");
	} finally {
		await session.close();
	}
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
