import assert from "node:assert/strict";
import test from "node:test";
import { getWebSearchBackend, rewriteWebSearchPayload } from "./payload.ts";

test("selects a backend from the model API", () => {
	assert.equal(getWebSearchBackend({ provider: "anthropic", api: "anthropic-messages" }), "anthropic");
	assert.equal(getWebSearchBackend({ provider: "anthropic-proxy", api: "anthropic-messages" }), "anthropic");
	assert.equal(getWebSearchBackend({ provider: "openai", api: "openai-responses" }), "openai");
	assert.equal(getWebSearchBackend({ provider: "openai", api: "openai-completions" }), undefined);
	assert.equal(getWebSearchBackend(undefined), undefined);
});

test("rewrites only the Anthropic web search function schema", () => {
	const payload = {
		model: "claude-opus-5",
		tools: [
			{ name: "read", description: "Read", input_schema: { type: "object" } },
			{
				name: "web_search",
				description: "Search",
				input_schema: { type: "object", required: ["query"] },
			},
			{ name: "write", description: "Write", input_schema: { type: "object" } },
		],
	};
	const original = structuredClone(payload);

	assert.deepEqual(rewriteWebSearchPayload(payload, "anthropic"), {
		model: "claude-opus-5",
		tools: [
			{ name: "read", description: "Read", input_schema: { type: "object" } },
			{ type: "web_search_20250305", name: "web_search" },
			{ name: "write", description: "Write", input_schema: { type: "object" } },
		],
	});
	assert.deepEqual(payload, original);
});

test("rewrites only the OpenAI web search function schema", () => {
	const payload = {
		model: "gpt-5.6-sol",
		tools: [
			{ type: "function", name: "read", description: "Read", parameters: { type: "object" } },
			{
				type: "function",
				name: "web_search",
				description: "Search",
				parameters: { type: "object", required: ["query"] },
				strict: false,
			},
			{ type: "function", name: "write", description: "Write", parameters: { type: "object" } },
		],
	};
	const original = structuredClone(payload);

	assert.deepEqual(rewriteWebSearchPayload(payload, "openai"), {
		model: "gpt-5.6-sol",
		tools: [
			{ type: "function", name: "read", description: "Read", parameters: { type: "object" } },
			{ type: "web_search" },
			{ type: "function", name: "write", description: "Write", parameters: { type: "object" } },
		],
	});
	assert.deepEqual(payload, original);
});

test("leaves native and unrelated tool descriptors unchanged", () => {
	const anthropicPayload = {
		tools: [{ type: "web_search_20250305", name: "web_search" }, { name: "read", input_schema: {} }],
	};
	const openAiPayload = {
		tools: [{ type: "web_search" }, { type: "function", name: "read", parameters: {} }],
	};

	assert.equal(rewriteWebSearchPayload(anthropicPayload, "anthropic"), anthropicPayload);
	assert.equal(rewriteWebSearchPayload(openAiPayload, "openai"), openAiPayload);
});

test("leaves malformed payloads unchanged", () => {
	const values: unknown[] = [null, "payload", [], {}, { tools: null }, { tools: {} }, { tools: [null, "tool"] }];

	for (const value of values) {
		assert.equal(rewriteWebSearchPayload(value, "openai"), value);
	}
});
