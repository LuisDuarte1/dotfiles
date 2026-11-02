import assert from "node:assert/strict";
import test from "node:test";
import {
	applyEvent,
	createRun,
	formatDuration,
	formatTokens,
	resultText,
	type RunState,
	summarizeArgs,
	type ToolItem,
} from "./run.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content,
	usage,
	stopReason: "stop",
	...extra,
});
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

function feed(run: RunState, events: Record<string, unknown>[]): RunState {
	for (const event of events) applyEvent(run, event as never);
	return run;
}

const newRun = () => createRun({ id: 1, task: "t" });

test("streams text deltas into one item and settles on text_end", () => {
	const run = feed(newRun(), [
		{ type: "message_start", message: assistant([]) },
		{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
	]);
	assert.equal(run.activity, "writing");
	assert.deepEqual(run.transcript.map((i) => i.kind === "text" && i.text), ["Hello"]);

	feed(run, [
		{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello!" } },
		{ type: "message_end", message: assistant([{ type: "text", text: "Hello!" }]) },
	]);
	assert.equal(run.transcript.length, 1, "message_end must not duplicate streamed blocks");
	assert.equal(run.transcript[0].kind === "text" && run.transcript[0].text, "Hello!");
	assert.equal(run.usage.totalTokens, 15);
	assert.equal(run.usage.cost.total, 0.5);
});

test("tracks a tool call from model request through execution", () => {
	const toolCall = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } };
	const run = feed(newRun(), [
		{ type: "message_start", message: assistant([]) },
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" } },
		{ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall } },
		{ type: "message_end", message: assistant([toolCall], { stopReason: "toolUse" }) },
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: toolCall.arguments },
	]);
	const tool = run.transcript[0] as ToolItem;
	assert.equal(tool.state, "running");
	assert.equal(tool.args, "ls -la");
	assert.equal(run.activity, "bash: ls -la");

	feed(run, [
		{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a\n" }] } },
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a\nb\n" }] }, isError: false },
		{ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a\nb\n" }], isError: false } },
		{ type: "turn_end", message: assistant([toolCall], { stopReason: "toolUse" }) },
		{ type: "turn_end", message: assistant([], { stopReason: "aborted" }) },
	]);
	assert.equal(run.transcript.length, 1);
	assert.equal(tool.state, "done");
	assert.equal(tool.output, "a\nb\n");
	assert.equal(run.turns, 1, "an aborted turn does not count");
});

test("skips the initial prompt but records later user messages as steers", () => {
	const run = feed(newRun(), [
		{ type: "message_end", message: user("the task") },
		{ type: "queue_update", steering: ["go left"], followUp: [] },
	]);
	assert.deepEqual(run.pending, ["go left"]);
	assert.equal(run.transcript.length, 0);

	feed(run, [
		{ type: "queue_update", steering: [], followUp: [] },
		{ type: "message_end", message: user("go left") },
	]);
	assert.deepEqual(run.steers, ["go left"]);
	assert.deepEqual(run.pending, []);
	assert.equal(run.transcript[0].kind, "user");
});

test("builds items from a complete message when nothing was streamed", () => {
	const run = feed(newRun(), [
		{ type: "message_start", message: assistant([]) },
		{
			type: "message_end",
			message: assistant([
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a.ts" } },
			]),
		},
	]);
	assert.deepEqual(
		run.transcript.map((i) => i.kind),
		["thinking", "text", "tool"],
	);
	assert.equal((run.transcript[2] as ToolItem).args, "a.ts");
});

test("notes model errors and retries", () => {
	const run = feed(newRun(), [
		{ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: "overloaded" }) },
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "overloaded" },
	]);
	assert.deepEqual(
		run.transcript.map((i) => (i.kind === "note" ? `${i.level}:${i.text}` : i.kind)),
		["error:overloaded", "warning:retrying (1/3): overloaded"],
	);
});

test("caps the transcript so long runs do not grow without bound", () => {
	const run = newRun();
	for (let i = 0; i < 450; i++) {
		feed(run, [{ type: "message_end", message: { role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [], isError: false } }]);
	}
	assert.equal(run.transcript.length, 400);
	assert.equal((run.transcript[0] as ToolItem).id, "c50");
});

test("formats durations, tokens and tool arguments", () => {
	assert.equal(formatDuration(5_400), "5s");
	assert.equal(formatDuration(72_000), "1m12s");
	assert.equal(formatDuration(3_780_000), "1h03m");
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(4_560), "4.6k");
	assert.equal(formatTokens(45_600), "46k");
	assert.equal(formatTokens(1_250_000), "1.3M");
	assert.equal(summarizeArgs("bash", { command: "rg  foo\n src/" }), "rg foo src/");
	assert.equal(summarizeArgs("grep", { pattern: "x", path: "src" }), "x in src");
	assert.equal(summarizeArgs("mystery", { a: 1 }), '{"a":1}');
});

test("tells the parent about user stops and steering", () => {
	const run = createRun({ id: 1, task: "t" });
	run.status = "stopped";
	run.turns = 1;
	assert.equal(resultText(run), "Stopped by the user after 1 turn. No output yet.");

	run.lastAssistant = assistant([{ type: "text", text: "half done" }]) as never;
	run.steers = ["focus on auth", "skip tests"];
	assert.equal(
		resultText(run),
		"Stopped by the user after 1 turn. Partial output:\n\nhalf done\n\n---\nThe user sent this subagent extra instructions while it ran:\n- focus on auth\n- skip tests",
	);

	run.status = "error";
	run.steers = [];
	run.lastAssistant = assistant([], { stopReason: "error", errorMessage: "overloaded" }) as never;
	assert.equal(resultText(run), "Subagent error: overloaded");
});
