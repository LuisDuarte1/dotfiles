import assert from "node:assert/strict";
import test from "node:test";
import { decide, ENTRY_TYPE, type GateInput, INITIAL_STATE, restoreState } from "./gate.ts";

const ASTRA = "gpt-6-astra";
const OPUS = "claude-opus-5-5";
const TOOLS = ["read", "bash", "subagent"];

const input = (overrides: Partial<GateInput>): GateInput => ({
	modelId: ASTRA,
	prompt: "hi",
	active: TOOLS,
	state: INITIAL_STATE,
	...overrides,
});

test("removes subagent on Astra without the trigger", () => {
	assert.deepEqual(decide(input({})), {
		tools: ["read", "bash"],
		state: { unlocked: false, removed: true },
	});
});

test("keeps subagent on Astra when the prompt asks for subagents", () => {
	for (const prompt of ["use subagents here", "Spawn a Subagent", "SUBAGENTS: go"]) {
		assert.deepEqual(decide(input({ prompt })), { state: { unlocked: true, removed: false } }, prompt);
	}
});

test("does not match unrelated words", () => {
	for (const prompt of ["subagentic", "mysubagents", "sub-agents"]) {
		assert.equal(decide(input({ prompt })).state.unlocked, false, prompt);
	}
});

test("re-adds subagent once a later Astra prompt unlocks it", () => {
	const gated = decide(input({}));
	const unlocked = decide(input({ prompt: "now use subagents", active: gated.tools, state: gated.state }));
	assert.deepEqual(unlocked, { tools: TOOLS, state: { unlocked: true, removed: false } });
});

test("stays unlocked for the rest of the session", () => {
	const state = { unlocked: true, removed: false };
	assert.deepEqual(decide(input({ prompt: "fix finding 3", state })), { state });
});

test("restores subagent when switching away from Astra", () => {
	const gated = decide(input({}));
	assert.deepEqual(decide(input({ modelId: OPUS, active: gated.tools, state: gated.state })), {
		tools: ["read", "bash", "subagent"],
		state: { unlocked: false, removed: false },
	});
});

test("leaves other models untouched", () => {
	assert.deepEqual(decide(input({ modelId: OPUS })), { state: INITIAL_STATE });
	assert.deepEqual(decide(input({ modelId: undefined })), { state: INITIAL_STATE });
});

test("never adds subagent that the gate did not remove", () => {
	const active = ["read", "bash"];
	assert.deepEqual(decide(input({ active, prompt: "use subagents" })), { state: { unlocked: true, removed: false } });
	assert.deepEqual(decide(input({ active, modelId: OPUS })), { state: INITIAL_STATE });
});

test("clears the removed flag when subagent was re-enabled elsewhere", () => {
	const state = { unlocked: false, removed: true };
	assert.deepEqual(decide(input({ modelId: OPUS, state })), { tools: undefined, state: INITIAL_STATE });
});

test("restores the latest gate state from the branch", () => {
	const branch = [
		{ type: "custom", customType: ENTRY_TYPE, data: { unlocked: false, removed: true } },
		{ type: "message" },
		{ type: "custom", customType: "other", data: { unlocked: true, removed: true } },
		{ type: "custom", customType: ENTRY_TYPE, data: { unlocked: true, removed: false } },
		{ type: "custom", customType: ENTRY_TYPE, data: { garbage: 1 } },
	];
	assert.deepEqual(restoreState(branch), { unlocked: true, removed: false });
	assert.deepEqual(restoreState([]), INITIAL_STATE);
});
