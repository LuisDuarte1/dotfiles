import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcTable {
	children: Map<number, number[]>;
}

export interface TmuxState {
	clientSession: Map<number, string>;
	panes: Map<string, number[]>;
	attached: Map<string, number>;
}

export const EMPTY_TMUX: TmuxState = { clientSession: new Map(), panes: new Map(), attached: new Map() };

function statFields(stat: string): string[] {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

export function parentFromStat(stat: string): number | undefined {
	const ppid = Number(statFields(stat)[1]);
	return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

export function startTimeFromStat(stat: string): string | undefined {
	return statFields(stat)[19];
}

function readStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

export function processStartTime(pid: number): string | undefined {
	const stat = readStat(pid);
	return stat ? startTimeFromStat(stat) : undefined;
}

export function buildProcTable(parents: Iterable<[number, number]>): ProcTable {
	const children = new Map<number, number[]>();
	for (const [pid, ppid] of parents) {
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	return { children };
}

export function readProcTable(): ProcTable {
	const parents: [number, number][] = [];
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid)) continue;
		const stat = readStat(pid);
		const ppid = stat ? parentFromStat(stat) : undefined;
		if (ppid) parents.push([pid, ppid]);
	}
	return buildProcTable(parents);
}

async function tmuxLines(args: string[]): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("tmux", args, { timeout: 3000 });
		return stdout.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export function parseTmux(clients: string[], panes: string[], sessions: string[]): TmuxState {
	const state: TmuxState = { clientSession: new Map(), panes: new Map(), attached: new Map() };
	for (const line of clients) {
		const [pid, name] = line.split("\t");
		if (Number(pid) > 0 && name) state.clientSession.set(Number(pid), name);
	}
	for (const line of panes) {
		const [name, pid] = line.split("\t");
		if (!name || !(Number(pid) > 0)) continue;
		const list = state.panes.get(name);
		if (list) list.push(Number(pid));
		else state.panes.set(name, [Number(pid)]);
	}
	for (const line of sessions) {
		const [name, attached] = line.split("\t");
		if (name) state.attached.set(name, Number(attached) || 0);
	}
	return state;
}

export async function readTmux(): Promise<TmuxState> {
	const [clients, panes, sessions] = await Promise.all([
		tmuxLines(["list-clients", "-F", "#{client_pid}\t#{session_name}"]),
		tmuxLines(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]),
		tmuxLines(["list-sessions", "-F", "#{session_name}\t#{session_attached}"]),
	]);
	return parseTmux(clients, panes, sessions);
}

// A pi under the luisd wrapper runs in a tmux pane whose tree never reaches the terminal,
// so a tmux client found below the terminal continues the walk into its session's panes.
export function reachablePids(root: number, procs: ProcTable, tmux: TmuxState): Set<number> {
	const seen = new Set<number>();
	const queue = [root];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		if (seen.has(pid)) continue;
		seen.add(pid);
		queue.push(...(procs.children.get(pid) ?? []));
		const session = tmux.clientSession.get(pid);
		if (session) queue.push(...(tmux.panes.get(session) ?? []));
	}
	return seen;
}
