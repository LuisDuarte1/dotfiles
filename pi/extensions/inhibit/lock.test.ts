import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_STATE, inhibitArgs, type LockAction, type LockEvent, type LockState, lockWhy, runningJobs, step } from "./lock.ts";

const TURN: LockEvent = { type: "turn_start" };
const SETTLED: LockEvent = { type: "turn_settled" };
const EXPIRED: LockEvent = { type: "grace_expired" };
const SHUTDOWN: LockEvent = { type: "shutdown" };
const jobs = (running: number): LockEvent => ({ type: "jobs", running });
const exited = (missing = false): LockEvent => ({ type: "lock_exited", missing });

function run(events: LockEvent[], start: LockState = INITIAL_STATE): { state: LockState; actions: LockAction[][] } {
	let state = start;
	const actions: LockAction[][] = [];
	for (const event of events) {
		const result = step(state, event);
		state = result.state;
		actions.push(result.actions);
	}
	return { state, actions };
}

test("a turn acquires once, even when pi restarts the run for a retry", () => {
	assert.deepEqual(run([TURN, TURN]).actions, [["acquire"], []]);
});

test("settling arms the grace and its expiry releases the lock", () => {
	const { state, actions } = run([TURN, SETTLED, EXPIRED]);
	assert.deepEqual(actions, [["acquire"], ["arm_grace"], ["release"]]);
	assert.deepEqual(state, INITIAL_STATE);
});

test("a turn inside the grace keeps the same lock instead of flapping", () => {
	assert.deepEqual(run([TURN, SETTLED, TURN, SETTLED]).actions, [["acquire"], ["arm_grace"], ["cancel_grace"], ["arm_grace"]]);
});

test("background jobs hold the lock past the turn, and the grace starts when the last one ends", () => {
	const { actions } = run([TURN, jobs(2), SETTLED, jobs(1), jobs(0), EXPIRED]);
	assert.deepEqual(actions, [["acquire"], [], [], [], ["arm_grace"], ["release"]]);
});

test("jobs started while idle take the lock on their own", () => {
	assert.deepEqual(run([jobs(1), jobs(0), jobs(3)]).actions, [["acquire"], ["arm_grace"], ["cancel_grace"]]);
});

test("without any bg-do event the turn alone drives the lock", () => {
	assert.deepEqual(run([TURN, SETTLED, EXPIRED, TURN]).actions, [["acquire"], ["arm_grace"], ["release"], ["acquire"]]);
});

test("shutdown releases at once, mid-turn or mid-grace, and ends the machine", () => {
	assert.deepEqual(run([TURN, jobs(1), SHUTDOWN, TURN, jobs(2)]).actions, [["acquire"], [], ["release"], [], []]);
	assert.deepEqual(run([TURN, SETTLED, SHUTDOWN, EXPIRED]).actions, [["acquire"], ["arm_grace"], ["release", "cancel_grace"], []]);
	assert.deepEqual(run([SHUTDOWN]).actions, [[]]);
});

test("a lock that exits is not respawned in a loop, but the next busy event retries", () => {
	const { state, actions } = run([TURN, exited(), exited(), jobs(1)]);
	assert.deepEqual(actions, [["acquire"], [], [], ["acquire"]]);
	assert.equal(state.held, true);
});

test("a lock that exits during the grace drops the timer", () => {
	assert.deepEqual(run([TURN, SETTLED, exited(), EXPIRED]).actions, [["acquire"], ["arm_grace"], ["cancel_grace"], []]);
});

test("a missing systemd-inhibit turns the lock off for the session", () => {
	const { state, actions } = run([TURN, exited(true), SETTLED, TURN, jobs(1), SHUTDOWN]);
	assert.deepEqual(actions, [["acquire"], [], [], [], [], []]);
	assert.equal(state.held, false);
});

test("any event order keeps the grace tied to a held lock and acquire alone in its step", () => {
	const events = [TURN, SETTLED, EXPIRED, jobs(0), jobs(2), exited()];
	let seed = 7;
	for (let walk = 0; walk < 200; walk++) {
		let state = INITIAL_STATE;
		for (let i = 0; i < 30; i++) {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			const event = i < 29 ? events[(seed >>> 8) % events.length] : walk % 2 ? SHUTDOWN : exited(true);
			const result = step(state, event);
			state = result.state;
			assert.ok(!state.grace || state.held, JSON.stringify(state));
			assert.ok(!result.actions.includes("acquire") || result.actions.length === 1, result.actions.join());
			assert.ok(!(state.off && state.held), JSON.stringify(state));
		}
	}
});

test("runningJobs accepts only a finite count", () => {
	assert.equal(runningJobs(3), 3);
	assert.equal(runningJobs(0), 0);
	assert.equal(runningJobs(-1), 0);
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "2", { running: 2 }, undefined, null]) {
		assert.equal(runningJobs(bad), undefined, String(bad));
	}
});

test("the lock names the session and why it is held", () => {
	const session = { name: "fix ci", id: "0123456789abcdef", cwd: "/w" };
	assert.equal(lockWhy(session, { ...INITIAL_STATE, turn: true, jobs: 2 }), "fix ci (/w): agent turn");
	assert.equal(lockWhy({ ...session, name: undefined }, { ...INITIAL_STATE, jobs: 1 }), "01234567 (/w): 1 background job");
	assert.equal(lockWhy({ ...session, name: "" }, { ...INITIAL_STATE, jobs: 2 }), "01234567 (/w): 2 background jobs");
});

test("the lock blocks idle, sleep and shutdown and lives as long as cat's stdin", () => {
	assert.deepEqual(inhibitArgs("x"), ["--what=idle:sleep:shutdown", "--mode=block", "--who=pi", "--why=x", "cat"]);
});
