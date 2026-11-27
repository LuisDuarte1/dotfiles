import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_STATE, type Mode, modeFor, type ReloadAction, type ReloadEvent, type ReloadState, requestDir, step } from "./state.ts";

const IDLE: ReloadEvent = { type: "request", idle: true };
const BUSY: ReloadEvent = { type: "request", idle: false };
const TOOLS: ReloadEvent = { type: "turn_end", hasToolResults: true };
const ANSWER: ReloadEvent = { type: "turn_end", hasToolResults: false };
const SETTLED: ReloadEvent = { type: "settled" };
const DONE: ReloadEvent = { type: "reload_done" };

function run(mode: Mode, events: ReloadEvent[]): { state: ReloadState; actions: ReloadAction[][] } {
	let state = INITIAL_STATE;
	const actions: ReloadAction[][] = [];
	for (const event of events) {
		const result = step(mode, state, event);
		state = result.state;
		actions.push(result.actions);
	}
	return { state, actions };
}

test("an idle session reloads at once and ignores the other inotify events of the same write", () => {
	assert.deepEqual(run("tui", [IDLE, IDLE, BUSY]).actions, [["reload"], [], []]);
});

test("a finished reload lets the next broadcast through, so a failed one does not stick", () => {
	assert.deepEqual(run("tui", [IDLE, DONE, IDLE]).actions, [["reload"], [], ["reload"]]);
});

test("a busy session aborts after its next tool turn, then reloads and continues", () => {
	const { state, actions } = run("tui", [BUSY, BUSY, TOOLS, TOOLS, SETTLED, DONE]);
	assert.deepEqual(actions, [["notify_queued"], [], ["abort"], [], ["reload_and_continue"], []]);
	assert.deepEqual(state, INITIAL_STATE);
});

test("a final answer is never aborted; the session reloads once it settles and does not continue", () => {
	assert.deepEqual(run("tui", [BUSY, ANSWER, SETTLED]).actions, [["notify_queued"], [], ["reload"]]);
});

test("an RPC child reloads only mid-run, since an idle one has just started or is exiting", () => {
	assert.deepEqual(run("rpc", [IDLE]).actions, [[]]);
	assert.deepEqual(run("rpc", [BUSY, TOOLS, SETTLED]).actions, [["notify_queued"], ["abort"], ["reload_and_continue"]]);
	const natural = run("rpc", [BUSY, ANSWER, SETTLED]);
	assert.deepEqual(natural.actions, [["notify_queued"], [], []]);
	assert.deepEqual(natural.state, INITIAL_STATE);
});

test("settling without a request does nothing", () => {
	assert.deepEqual(run("tui", [TOOLS, SETTLED]).actions, [[], []]);
});

test("only the TUI and opted-in RPC children take part", () => {
	assert.equal(modeFor("tui", {}), "tui");
	assert.equal(modeFor("rpc", {}), undefined);
	assert.equal(modeFor("rpc", { PI_RELOAD_BROADCAST: "1" }), "rpc");
	assert.equal(modeFor("print", { PI_RELOAD_BROADCAST: "1" }), undefined);
	assert.equal(modeFor("json", { PI_RELOAD_BROADCAST: "1" }), undefined);
});

test("the request dir lives in the runtime dir, like the session beacons", () => {
	assert.equal(requestDir({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/pi-reload");
	assert.match(requestDir({}, 1234), /pi-reload-1234$/);
});
