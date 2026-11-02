import assert from "node:assert/strict";
import test from "node:test";
import {
	AnthropicRawContentRecorder,
	collectContentKeys,
	isRawContentRecord,
	restoreRawAssistantContent,
	type RawContentRecord,
} from "./raw-content.ts";

function recordSearchTurn(recorder: AnthropicRawContentRecorder): RawContentRecord | undefined {
	recorder.push({ type: "message_start", message: { id: "msg_1", content: [] } });
	recorder.push({
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "", signature: "" },
	});
	recorder.push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me search" } });
	recorder.push({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } });
	recorder.push({ type: "content_block_stop", index: 0 });
	recorder.push({
		type: "content_block_start",
		index: 1,
		content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
	});
	recorder.push({
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"query":"seaweedfs cas"}' },
	});
	recorder.push({ type: "content_block_stop", index: 1 });
	recorder.push({
		type: "content_block_start",
		index: 2,
		content_block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [{ type: "web_search_result", url: "https://example.com", encrypted_content: "opaque" }],
		},
	});
	recorder.push({ type: "content_block_stop", index: 2 });
	recorder.push({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } });
	recorder.push({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Found it." } });
	recorder.push({
		type: "content_block_delta",
		index: 3,
		delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.com" } },
	});
	recorder.push({ type: "content_block_stop", index: 3 });
	recorder.push({
		type: "content_block_start",
		index: 4,
		content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
	});
	recorder.push({ type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' } });
	recorder.push({ type: "content_block_stop", index: 4 });
	return recorder.push({ type: "message_stop" });
}

test("records the full raw content of a native web search turn", () => {
	const record = recordSearchTurn(new AnthropicRawContentRecorder());
	assert.ok(record && isRawContentRecord(record));

	assert.deepEqual(record.keys, ["sig:sig-abc", "tool:toolu_1", "text:Found it."]);
	assert.deepEqual(record.content, [
		{ type: "thinking", thinking: "let me search", signature: "sig-abc" },
		{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "seaweedfs cas" } },
		{
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [{ type: "web_search_result", url: "https://example.com", encrypted_content: "opaque" }],
		},
		{
			type: "text",
			text: "Found it.",
			citations: [{ type: "web_search_result_location", url: "https://example.com" }],
		},
		{ type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } },
	]);
});

test("returns nothing for turns without server-side blocks", () => {
	const recorder = new AnthropicRawContentRecorder();
	recorder.push({ type: "message_start" });
	recorder.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } });
	recorder.push({ type: "content_block_stop", index: 0 });
	assert.equal(recorder.push({ type: "message_stop" }), undefined);
});

test("collects only keys that survive pi's serialization", () => {
	assert.deepEqual(
		collectContentKeys([
			{ type: "thinking", thinking: "x", signature: "" },
			{ type: "server_tool_use", id: "srvtoolu_9" },
			{ type: "text", text: "  " },
			{ type: "text", text: "answer" },
			{ type: "tool_use", id: "toolu_9" },
		]),
		["tool:toolu_9", "text:answer"],
	);
});

test("restores recorded raw content into matching assistant messages", () => {
	const record = recordSearchTurn(new AnthropicRawContentRecorder());
	assert.ok(record);
	const lookup = (key: string) => (record.keys.includes(key) ? record : undefined);

	const payload = {
		model: "claude-fable-5",
		messages: [
			{ role: "user", content: [{ type: "text", text: "search please" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me search", signature: "sig-abc" },
					{ type: "text", text: "Found it." },
					{ type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
		],
	};

	const restored = restoreRawAssistantContent(payload, lookup) as typeof payload;
	assert.notEqual(restored, payload);
	assert.deepEqual(restored.messages[1].content, record.content);
	assert.equal(restored.messages[0], payload.messages[0]);
	assert.equal(restored.messages[2], payload.messages[2]);
});

test("leaves payloads without matches untouched", () => {
	const payload = {
		messages: [{ role: "assistant", content: [{ type: "text", text: "no search here" }] }],
	};
	assert.equal(
		restoreRawAssistantContent(payload, () => undefined),
		payload,
	);
	assert.equal(restoreRawAssistantContent("not a payload", () => undefined), "not a payload");
});
