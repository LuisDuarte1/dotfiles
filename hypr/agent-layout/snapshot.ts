import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ProcTable, reachablePids, type TmuxState } from "./procs.ts";
import type { Agent, Beacon, HyprClient, HyprMonitor, HyprWorkspace, MonitorInfo, Snapshot } from "./types.ts";

export const TERMINAL_CLASS = "kitty";
const KEEP_SNAPSHOTS = 5;

export interface SnapshotInput {
	clients: HyprClient[];
	monitors: HyprMonitor[];
	workspaces: HyprWorkspace[];
	beacons: Beacon[];
	procs: ProcTable;
	tmux: TmuxState;
	instance: string;
	bootId: string;
	now: Date;
	exists?: (path: string) => boolean;
}

// pi writes a session file only after the first reply, so a pi that was never prompted has
// nothing to resume; recording it would relaunch a fresh pi on every restore, even twice.
export function buildSnapshot(input: SnapshotInput): Snapshot {
	const exists = input.exists ?? existsSync;
	const beaconByPid = new Map(
		input.beacons.filter((b) => b.sessionFile && exists(b.sessionFile)).map((b) => [b.pid, b]),
	);
	const monitorById = new Map(input.monitors.map((m) => [m.id, m.name]));
	const wsMonitor = new Map(input.workspaces.map((w) => [w.id, w.monitor]));
	const agents: Agent[] = [];
	const seenSessions = new Set<string>();

	for (const client of input.clients) {
		if (client.class !== TERMINAL_CLASS || !client.mapped || client.workspace.id === -1) continue;
		const pids = reachablePids(client.pid, input.procs, input.tmux);
		const beacon = [...pids].map((pid) => beaconByPid.get(pid)).find((b) => b !== undefined);
		if (!beacon?.sessionFile || seenSessions.has(beacon.sessionFile)) continue;
		seenSessions.add(beacon.sessionFile);
		const monitor = wsMonitor.get(client.workspace.id) ?? monitorById.get(client.monitor) ?? "";
		agents.push({
			workspace: { id: client.workspace.id, name: client.workspace.name, monitor },
			monitor,
			rect: { x: client.at[0], y: client.at[1], w: client.size[0], h: client.size[1] },
			floating: client.floating,
			fullscreen: client.fullscreen,
			hidden: client.hidden,
			focusHistoryID: client.focusHistoryID,
			cwd: beacon.cwd,
			sessionFile: beacon.sessionFile,
			sessionId: beacon.sessionId,
			sessionName: beacon.sessionName,
			flags: beacon.flags,
			tmuxSession: beacon.tmuxSession,
		});
	}

	agents.sort((a, b) => a.workspace.id - b.workspace.id || a.rect.x - b.rect.x || a.rect.y - b.rect.y);
	const monitors: MonitorInfo[] = input.monitors.map((m) => ({
		name: m.name,
		x: m.x,
		y: m.y,
		width: m.width,
		height: m.height,
		scale: m.scale,
		transform: m.transform,
		focused: m.focused,
		activeWorkspace: m.activeWorkspace.name,
	}));

	return {
		version: 1,
		takenAt: input.now.toISOString(),
		instance: input.instance,
		bootId: input.bootId,
		monitors,
		agents,
	};
}

// Focus order and active workspaces change constantly, so they are left out of the key:
// a snapshot that differs only there replaces the latest file instead of adding one.
export function stableKey(snapshot: Snapshot): string {
	return JSON.stringify({
		instance: snapshot.instance,
		monitors: snapshot.monitors.map(({ focused, activeWorkspace, ...rest }) => rest),
		agents: snapshot.agents.map(({ focusHistoryID, ...rest }) => rest),
	});
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agent-layout");
}

export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), "agent-layout");
}

export function snapshotDir(base: string = stateDir()): string {
	return path.join(base, "snapshots");
}

export interface StoredSnapshot {
	file: string;
	snapshot: Snapshot;
}

export function isSnapshot(value: unknown): value is Snapshot {
	const s = value as Snapshot;
	return typeof s === "object" && s !== null && s.version === 1 && Array.isArray(s.agents) && Array.isArray(s.monitors);
}

export function loadSnapshot(file: string): Snapshot {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!isSnapshot(parsed)) throw new Error(`${file}: not an agent-layout snapshot`);
	return parsed;
}

export function listSnapshots(dir: string = snapshotDir()): StoredSnapshot[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const out: StoredSnapshot[] = [];
	for (const name of names.sort().reverse()) {
		const file = path.join(dir, name);
		try {
			out.push({ file, snapshot: loadSnapshot(file) });
		} catch {}
	}
	return out;
}

function writeAtomic(file: string, snapshot: Snapshot): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
	renameSync(tmp, file);
}

export function snapshotFileName(snapshot: Snapshot): string {
	return `${snapshot.takenAt.replace(/[:.]/g, "-")}.json`;
}

export function saveSnapshot(snapshot: Snapshot, dir: string = snapshotDir()): { file: string; created: boolean } {
	mkdirSync(dir, { recursive: true });
	const latest = listSnapshots(dir)[0];
	if (latest && stableKey(latest.snapshot) === stableKey(snapshot)) {
		writeAtomic(latest.file, snapshot);
		return { file: latest.file, created: false };
	}
	const file = path.join(dir, snapshotFileName(snapshot));
	writeAtomic(file, snapshot);
	pruneSnapshots(dir, snapshot.instance);
	return { file, created: true };
}

// Rearranging windows after a reboot produces new snapshots before anyone restores, so the
// previous session's snapshot is kept outside the window, or "Restore Agents" would lose it.
export function pruneSnapshots(dir: string, currentInstance: string, keep = KEEP_SNAPSHOTS): void {
	const stored = listSnapshots(dir);
	const kept = new Set(stored.slice(0, keep).map((s) => s.file));
	const candidate = defaultSnapshot(stored, currentInstance);
	if (candidate) kept.add(candidate.file);
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
		const file = path.join(dir, name);
		if (!kept.has(file)) rmSync(file, { force: true });
	}
}

export function defaultSnapshot(stored: StoredSnapshot[], currentInstance: string): StoredSnapshot | undefined {
	return stored.find((s) => s.snapshot.instance !== currentInstance && s.snapshot.agents.length > 0);
}

export function describeSnapshot(snapshot: Snapshot): string {
	const workspaces = [...new Set(snapshot.agents.map((a) => a.workspace.name))];
	const when = new Date(snapshot.takenAt).toLocaleString("sv-SE").slice(0, 16);
	return `${when}  ${snapshot.agents.length} agents  ws ${workspaces.join(",") || "-"}`;
}
