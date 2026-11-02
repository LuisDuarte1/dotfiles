import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authHook, runHook } from "./auth.ts";
import { readLiveBeacons } from "./beacons.ts";
import { tryLock } from "./lock.ts";
import { buildProcTable, parseTmux, reachablePids } from "./procs.ts";
import { batchLua, dsp } from "./hypr.ts";
import {
	agentLabel,
	execCommand,
	planWorkspaces,
	reconcile,
	rootLayoutFor,
	shellQuote,
	spawnSpec,
	translateRect,
} from "./restore.ts";
import { buildSnapshot, defaultSnapshot, listSnapshots, pruneSnapshots, saveSnapshot, stableKey } from "./snapshot.ts";
import type { Agent, Beacon, HyprClient, HyprMonitor, Snapshot } from "./types.ts";

const beacon = (pid: number, sessionFile: string | null, tmuxSession: string | null = null): Beacon => ({
	version: 1,
	pid,
	startTime: "1",
	cwd: `/w/${pid}`,
	sessionFile,
	sessionId: `id-${pid}`,
	sessionName: null,
	flags: pid === 300 ? ["--mcp-profile", "portal"] : [],
	tmuxSession,
	updatedAt: "2026-01-01T00:00:00.000Z",
});

const client = (pid: number, ws: number, x: number, extra: Partial<HyprClient> = {}): HyprClient => ({
	address: `0x${pid}`,
	class: "kitty",
	pid,
	workspace: { id: ws, name: String(ws) },
	monitor: 1,
	at: [x, 52],
	size: [600, 1366],
	floating: false,
	fullscreen: 0,
	hidden: false,
	mapped: true,
	focusHistoryID: pid,
	...extra,
});

const monitor: HyprMonitor = {
	id: 1,
	name: "DP-3",
	x: 3840,
	y: 0,
	width: 3840,
	height: 2160,
	scale: 1.5,
	transform: 0,
	focused: true,
	activeWorkspace: { id: 2, name: "2" },
};

// Process tree mirroring the luisd wrapper: kitty -> bash -> wrapper -> tmux client, and
// the tmux server -> pane bash -> launcher -> pi, plus a kitty running pi directly.
function fixture() {
	const procs = buildProcTable([
		[11, 10],
		[12, 11],
		[13, 12],
		[51, 50],
		[52, 51],
		[100, 52],
		[21, 20],
		[300, 21],
		[31, 30],
		[41, 40],
		[42, 41],
	]);
	const tmux = parseTmux(["13\tpi-aaaa", "42\tbtw-1"], ["pi-aaaa\t51", "btw-1\t60"], ["pi-aaaa\t1", "btw-1\t1"]);
	const beacons = [beacon(100, "/s/a.jsonl", "pi-aaaa"), beacon(300, "/s/b.jsonl"), beacon(999, null), beacon(31, "/s/never-prompted.jsonl")];
	const clients = [
		client(10, 2, 3862),
		client(20, 2, 4476),
		client(30, 2, 5090),
		client(40, 3, 3862),
		client(70, 2, 3862, { class: "google-chrome" }),
	];
	return { procs, tmux, beacons, clients };
}

test("reachablePids follows tmux clients into their session panes", () => {
	const { procs, tmux } = fixture();
	assert.ok(reachablePids(10, procs, tmux).has(100));
	assert.ok(!reachablePids(30, procs, tmux).has(100));
});

test("buildSnapshot records only terminals running a pi whose session file exists", () => {
	const { procs, tmux, beacons, clients } = fixture();
	const snap = buildSnapshot({
		clients,
		monitors: [monitor],
		workspaces: [{ id: 2, name: "2", monitor: "DP-3", windows: 4 }],
		beacons,
		procs,
		tmux,
		instance: "inst-1",
		bootId: "boot",
		now: new Date("2026-10-27T10:00:00Z"),
		exists: (file) => file !== "/s/never-prompted.jsonl",
	});
	assert.deepEqual(
		snap.agents.map((a) => [a.sessionFile, a.workspace.id, a.monitor, a.rect.x, a.tmuxSession]),
		[
			["/s/a.jsonl", 2, "DP-3", 3862, "pi-aaaa"],
			["/s/b.jsonl", 2, "DP-3", 4476, null],
		],
	);
	assert.deepEqual(snap.agents[1].flags, ["--mcp-profile", "portal"]);
	assert.equal(snap.monitors[0].activeWorkspace, "2");
});

const agent = (sessionFile: string, x: number, extra: Partial<Agent> = {}): Agent => ({
	workspace: { id: 2, name: "2", monitor: "DP-3" },
	monitor: "DP-3",
	rect: { x, y: 52, w: 600, h: 1366 },
	floating: false,
	fullscreen: 0,
	hidden: false,
	focusHistoryID: 0,
	cwd: "/w",
	sessionFile,
	sessionId: "0123456789",
	sessionName: null,
	flags: [],
	tmuxSession: "pi-x",
	...extra,
});

const snapshot = (instance: string, takenAt: string, agents: Agent[]): Snapshot => ({
	version: 1,
	takenAt,
	instance,
	bootId: "b",
	monitors: [{ ...monitor, activeWorkspace: "2" }],
	agents,
});

test("saveSnapshot replaces the latest file when only focus changed, and adds one otherwise", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "snaps-"));
	const a = snapshot("i1", "2026-10-27T10:00:00.000Z", [agent("/s/a", 0)]);
	assert.equal(saveSnapshot(a, dir).created, true);
	const refocused = { ...a, takenAt: "2026-10-27T10:01:00.000Z", agents: [{ ...a.agents[0], focusHistoryID: 5 }] };
	assert.equal(stableKey(refocused), stableKey(a));
	assert.equal(saveSnapshot(refocused, dir).created, false);
	assert.equal(readdirSync(dir).length, 1);
	assert.equal(listSnapshots(dir)[0].snapshot.takenAt, "2026-10-27T10:01:00.000Z");
	const moved = { ...a, takenAt: "2026-10-27T10:02:00.000Z", agents: [agent("/s/a", 700)] };
	assert.equal(saveSnapshot(moved, dir).created, true);
	assert.equal(readdirSync(dir).length, 2);
});

test("pruning keeps the newest five plus the previous session's restore candidate", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "prune-"));
	saveSnapshot(snapshot("prev", "2026-10-27T09:00:00.000Z", [agent("/s/old", 0)]), dir);
	saveSnapshot(snapshot("prev", "2026-10-27T09:30:00.000Z", [agent("/s/prev", 0)]), dir);
	for (let i = 0; i < 7; i++) {
		saveSnapshot(snapshot("now", `2026-10-27T10:0${i}:00.000Z`, [agent("/s/now", i * 10)]), dir);
	}
	const left = listSnapshots(dir).map((s) => s.snapshot.takenAt);
	assert.deepEqual(left, [
		"2026-10-27T10:06:00.000Z",
		"2026-10-27T10:05:00.000Z",
		"2026-10-27T10:04:00.000Z",
		"2026-10-27T10:03:00.000Z",
		"2026-10-27T10:02:00.000Z",
		"2026-10-27T09:30:00.000Z",
	]);
	pruneSnapshots(dir, "prev", 2);
	assert.equal(listSnapshots(dir).length, 2);
});

test("defaultSnapshot skips the current instance and empty snapshots", () => {
	const stored = [
		{ file: "c", snapshot: snapshot("now", "2026-10-27T12:00:00Z", [agent("/s/a", 0)]) },
		{ file: "b", snapshot: snapshot("prev", "2026-10-27T11:00:00Z", []) },
		{ file: "a", snapshot: snapshot("prev", "2026-10-27T10:00:00Z", [agent("/s/a", 0)]) },
	];
	assert.equal(defaultSnapshot(stored, "now")?.file, "a");
	assert.equal(defaultSnapshot(stored.slice(0, 2), "now"), undefined);
});

test("reconcile splits restore, running and orphaned sessions", () => {
	const tmux = parseTmux([], [], ["pi-live\t1", "pi-orphan\t0"]);
	const agents = [agent("/s/new", 0), agent("/s/live", 1), agent("/s/orphan", 2), agent("/s/plain", 3)];
	const beacons = [beacon(1, "/s/live", "pi-live"), beacon(2, "/s/orphan", "pi-orphan"), beacon(3, "/s/plain")];
	const result = reconcile(agents, beacons, tmux);
	assert.deepEqual(result.restore.map((a) => a.sessionFile), ["/s/new"]);
	assert.deepEqual(result.running.map((a) => a.sessionFile), ["/s/live", "/s/plain"]);
	assert.deepEqual(result.orphans.map((o) => o.beacon.tmuxSession), ["pi-orphan"]);
});

test("spawnSpec resumes through interactive bash and falls back when paths are gone", () => {
	const a = agent("/s/it's.jsonl", 0, { cwd: "/w/repo", flags: ["--mcp-profile", "portal"] });
	const spec = spawnSpec(a, () => true, "/home/u");
	assert.deepEqual(spec.argv.slice(0, 5), ["kitty", "--directory", "/w/repo", "bash", "-ic"]);
	assert.equal(spec.argv[5], "pi --session '/s/it'\\''s.jsonl' --mcp-profile portal; exec kitten run-shell");
	assert.deepEqual(spec.warnings, []);
	const gone = spawnSpec(a, () => false, "/home/u");
	assert.equal(gone.cwd, "/home/u");
	assert.equal(gone.argv[5], "pi --mcp-profile portal; exec kitten run-shell");
	assert.equal(gone.warnings.length, 2);
});

test("planWorkspaces separates floating and fullscreen agents and orders by monitor", () => {
	const snap = snapshot("i", "2026-10-27T10:00:00Z", []);
	snap.monitors = [
		{ ...snap.monitors[0], name: "eDP-1" },
		{ ...snap.monitors[0], name: "DP-3" },
	];
	const ws3 = { id: 3, name: "3", monitor: "eDP-1" };
	const plans = planWorkspaces(snap, [
		agent("/s/a", 0),
		agent("/s/b", 614),
		agent("/s/c", 0, { floating: true }),
		agent("/s/d", 0, { workspace: ws3, monitor: "eDP-1", fullscreen: 2 }),
	]);
	assert.deepEqual(
		plans.map((p) => [p.workspace.id, p.tiled.length, p.floating.length, p.fullscreen.length]),
		[
			[3, 0, 0, 1],
			[2, 2, 1, 0],
		],
	);
});

test("rootLayoutFor accounts for rotation", () => {
	assert.equal(rootLayoutFor({ ...snapshot("i", "t", []).monitors[0] }), "h");
	assert.equal(rootLayoutFor({ ...snapshot("i", "t", []).monitors[0], transform: 1 }), "v");
});

test("the pi-auth hook is optional and must be executable", async () => {
	const config = mkdtempSync(path.join(tmpdir(), "hooks-"));
	const hook = path.join(config, "dotfiles", "hooks", "pi-auth");
	assert.equal(authHook({ XDG_CONFIG_HOME: config }), undefined);
	mkdirSync(path.dirname(hook), { recursive: true });
	writeFileSync(hook, '#!/bin/sh\n[ "$1" = check ]\n');
	assert.equal(authHook({ XDG_CONFIG_HOME: config }), undefined);
	chmodSync(hook, 0o755);
	assert.equal(authHook({ XDG_CONFIG_HOME: config }), hook);
	assert.equal(await runHook(hook, ["check"]), true);
	assert.equal(await runHook(hook, ["login"]), false);
});

test("readLiveBeacons drops beacons whose process is gone or was replaced", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "beacons-"));
	saveBeacon(dir, beacon(1, "/s/a"));
	saveBeacon(dir, beacon(2, "/s/b"));
	const live = readLiveBeacons(dir, (pid) => (pid === 1 ? "1" : "999"), true);
	assert.deepEqual(live.map((b) => b.pid), [1]);
	assert.deepEqual(readdirSync(dir), ["1.json"]);
});

test("tryLock is exclusive and recovers from a dead owner", () => {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock");
	const lock = tryLock(file);
	assert.ok(lock);
	assert.equal(tryLock(file), undefined);
	lock.release();
	const dead = tryLock(file, 2 ** 31 - 1);
	assert.ok(dead);
	assert.ok(tryLock(file));
});

test("execCommand records the pid that kitty inherits through exec", () => {
	const spec = spawnSpec(agent("/s/a.jsonl", 0, { cwd: "/w" }), () => true, "/home/u");
	assert.equal(
		execCommand(spec, "/run/user/1000/agent-layout/spawn-1.pid"),
		"echo $$ > /run/user/1000/agent-layout/spawn-1.pid; exec kitty --directory /w bash -ic 'pi --session /s/a.jsonl; exec kitten run-shell'",
	);
});

test("batchLua aborts on the first failed dispatcher", () => {
	const lua = batchLua([dsp.focusWindow("0x1"), dsp.makeGroup("v")]);
	assert.match(lua, /^local function run\(d\)/);
	assert.match(lua, /run\(hl\.dsp\.focus\(\{ window = "address:0x1" \}\)\)\nrun\(hl\.plugin\.hy3\.make_group\("v"\)\)$/);
	assert.equal(dsp.exec('echo "hi"', "9"), 'hl.dsp.exec_cmd("echo \\"hi\\"", { workspace = "9" })');
});

test("translateRect maps a floating window from a missing monitor onto the one used", () => {
	const dp3 = { x: 3840, y: 0, width: 3840, height: 2160, scale: 1.5, transform: 0 };
	const edp = { x: 3840, y: 1440, width: 3840, height: 2400, scale: 2, transform: 0 };
	assert.deepEqual(translateRect({ x: 3840 + 1280, y: 720, w: 1280, h: 720 }, dp3, edp), {
		x: 3840 + 960,
		y: 1440 + 600,
		w: 960,
		h: 600,
	});
	assert.deepEqual(translateRect({ x: 1, y: 2, w: 3, h: 4 }, dp3, dp3), { x: 1, y: 2, w: 3, h: 4 });
	assert.deepEqual(translateRect({ x: 1, y: 2, w: 3, h: 4 }, undefined, edp), { x: 1, y: 2, w: 3, h: 4 });
});

test("helpers", () => {
	assert.equal(shellQuote(["a b", "c"]), "'a b' c");
	assert.equal(agentLabel(agent("/s/a", 0, { cwd: "/nowhere" })), "/nowhere (23456789)");
});

function saveBeacon(dir: string, b: Beacon) {
	writeFileSync(path.join(dir, `${b.pid}.json`), JSON.stringify(b));
}
