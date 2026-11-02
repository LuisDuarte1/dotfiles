import assert from "node:assert/strict";
import test from "node:test";
import { WebSearchActivityParser } from "./activity.ts";
import { getNativeWebSearchBackend, SseJsonParser } from "./stream.ts";

test("parses OpenAI search and page actions", () => {
	const parser = new WebSearchActivityParser("openai");

	assert.deepEqual(
		parser.push({
			type: "response.output_item.done",
			item: {
				id: "ws_1",
				type: "web_search_call",
				action: {
					type: "search",
					query: "SeaweedFS compare and swap",
					queries: ["SeaweedFS compare and swap", "SeaweedFS conditional writes"],
				},
			},
		}),
		[
			{
				id: "ws_1",
				provider: "openai",
				action: "search",
				query: "SeaweedFS compare and swap",
				queries: ["SeaweedFS compare and swap", "SeaweedFS conditional writes"],
			},
		],
	);

	assert.deepEqual(
		parser.push({
			type: "response.output_item.done",
			item: {
				id: "ws_2",
				type: "web_search_call",
				action: { type: "open_page", url: "https://github.com/seaweedfs/seaweedfs/issues/7153" },
			},
		}),
		[
			{
				id: "ws_2",
				provider: "openai",
				action: "open_page",
				url: "https://github.com/seaweedfs/seaweedfs/issues/7153",
			},
		],
	);
});

test("pairs Anthropic search calls with sanitized results", () => {
	const parser = new WebSearchActivityParser("anthropic");

	assert.deepEqual(
		parser.push({
			type: "content_block_start",
			index: 1,
			content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
		}),
		[],
	);
	assert.deepEqual(
		parser.push({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"query":"SeaweedFS issues"}' },
		}),
		[],
	);
	assert.deepEqual(parser.push({ type: "content_block_stop", index: 1 }), []);

	assert.deepEqual(
		parser.push({
			type: "content_block_start",
			index: 2,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_1",
				content: [
					{
						type: "web_search_result",
						url: "https://github.com/seaweedfs/seaweedfs/issues/7153",
						title: "Conditional writes",
						page_age: "August 2026",
						encrypted_content: "must-not-be-persisted",
					},
				],
			},
		}),
		[
			{
				id: "srvtoolu_1",
				provider: "anthropic",
				action: "search",
				query: "SeaweedFS issues",
				sources: [
					{
						url: "https://github.com/seaweedfs/seaweedfs/issues/7153",
						title: "Conditional writes",
						pageAge: "August 2026",
					},
				],
			},
		],
	);
});

test("flushes an Anthropic call when no result block arrives", () => {
	const parser = new WebSearchActivityParser("anthropic");
	parser.push({
		type: "content_block_start",
		index: 0,
		content_block: {
			type: "server_tool_use",
			id: "srvtoolu_2",
			name: "web_search",
			input: { query: "Example Blog" },
		},
	});
	parser.push({ type: "content_block_stop", index: 0 });

	assert.deepEqual(parser.push({ type: "message_stop" }), [
		{
			id: "srvtoolu_2",
			provider: "anthropic",
			action: "search",
			query: "Example Blog",
		},
	]);
});

test("parses fragmented SSE data records", () => {
	const parser = new SseJsonParser();

	assert.deepEqual(parser.push('event: response.output_item.done\ndata: {"type":"response.output'), []);
	assert.deepEqual(parser.push('_item.done","item":{"type":"web_search_call"}}\n\n'), [
		{ type: "response.output_item.done", item: { type: "web_search_call" } },
	]);
	assert.deepEqual(parser.push("data: [DONE]\n\n"), []);
});

test("detects only native web search request payloads", () => {
	assert.equal(getNativeWebSearchBackend('{"tools":[{"type":"web_search"}]}'), "openai");
	assert.equal(
		getNativeWebSearchBackend('{"tools":[{"type":"web_search_20250305","name":"web_search"}]}'),
		"anthropic",
	);
	assert.equal(getNativeWebSearchBackend('{"tools":[{"type":"function","name":"web_search"}]}'), undefined);
	assert.equal(getNativeWebSearchBackend("not json"), undefined);
});
