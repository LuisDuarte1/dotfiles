import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HyprWorkspace {
	id: number;
	name: string;
}

export interface HyprClient {
	pid: number;
	workspace: HyprWorkspace;
	focusHistoryID: number;
}

export interface Placement {
	workspace: HyprWorkspace;
	active: boolean;
}

export function parentPid(stat: string): number | undefined {
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const ppid = Number(fields[1]);
	return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

export function ancestors(pid: number, readStat: (pid: number) => string | undefined): number[] {
	const chain: number[] = [];
	for (let current: number | undefined = pid; current && current > 1 && !chain.includes(current); ) {
		chain.push(current);
		const stat = readStat(current);
		current = stat ? parentPid(stat) : undefined;
	}
	return chain;
}

export function pickWindow(clients: readonly HyprClient[], pids: ReadonlySet<number>): HyprClient | undefined {
	return clients
		.filter((client) => pids.has(client.pid))
		.sort((a, b) => a.focusHistoryID - b.focusHistoryID)[0];
}

export function workspaceSelector(workspace: HyprWorkspace): string {
	if (workspace.name.startsWith("special:")) return workspace.name;
	return workspace.id > 0 ? String(workspace.id) : `name:${workspace.name}`;
}

export function luaString(value: string): string {
	const escaped = value.replace(/[\\"\x00-\x1f\x7f]/g, (ch) =>
		ch === "\\" || ch === '"' ? `\\${ch}` : `\\${ch.charCodeAt(0).toString().padStart(3, "0")}`,
	);
	return `"${escaped}"`;
}

// Hyprland applies exec rules to the PID it spawned, and its `sh -c` forks, so the command must
// `exec` the terminal; `silent` only when the target isn't on screen, so it never yanks the view.
export function execDispatch(shellCommand: string, placement: Placement): string {
	const rule = `${workspaceSelector(placement.workspace)}${placement.active ? "" : " silent"}`;
	return `hl.dsp.exec_cmd(${luaString(`exec ${shellCommand}`)}, { workspace = ${luaString(rule)} })`;
}

function readStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

async function output(command: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
	return stdout.trim();
}

// The parent pi usually lives in a tmux pane whose process tree never reaches the terminal, so
// the terminal is found through the tmux clients attached to the parent's session instead.
async function parentPids(env: NodeJS.ProcessEnv): Promise<Set<number>> {
	const roots = [process.pid];
	if (env.TMUX && env.TMUX_PANE) {
		const session = await output("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#{session_name}"]).catch(
			() => "",
		);
		if (session) {
			const clients = await output("tmux", ["list-clients", "-t", session, "-F", "#{client_pid}"]).catch(() => "");
			roots.push(...clients.split("\n").map(Number).filter((pid) => pid > 0));
		}
	}
	return new Set(roots.flatMap((pid) => ancestors(pid, readStat)));
}

export async function findParentPlacement(env: NodeJS.ProcessEnv = process.env): Promise<Placement | undefined> {
	if (!env.HYPRLAND_INSTANCE_SIGNATURE) return undefined;
	try {
		const clients = JSON.parse(await output("hyprctl", ["-j", "clients"])) as HyprClient[];
		const window = pickWindow(clients, await parentPids(env));
		if (!window) return undefined;
		const active = JSON.parse(await output("hyprctl", ["-j", "activeworkspace"])) as HyprWorkspace;
		return { workspace: window.workspace, active: active.id === window.workspace.id };
	} catch {
		return undefined;
	}
}

export async function execOnWorkspace(shellCommand: string, placement: Placement): Promise<void> {
	const reply = await output("hyprctl", ["dispatch", execDispatch(shellCommand, placement)]);
	if (reply !== "ok") throw new Error(`hyprctl dispatch: ${reply}`);
}
