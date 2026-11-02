import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Layout } from "./tree.ts";
import type { HyprClient, HyprMonitor, HyprWorkspace } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function hyprctl(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("hyprctl", args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

export async function hyprJson<T>(what: string, ...args: string[]): Promise<T> {
	return JSON.parse(await hyprctl(["-j", what, ...args])) as T;
}

export const clients = () => hyprJson<HyprClient[]>("clients");
export const monitors = () => hyprJson<HyprMonitor[]>("monitors");
export const workspaces = () => hyprJson<HyprWorkspace[]>("workspaces");

export function luaString(value: string): string {
	const escaped = value.replace(/[\\"\x00-\x1f\x7f]/g, (ch) =>
		ch === "\\" || ch === '"' ? `\\${ch}` : `\\${ch.charCodeAt(0).toString().padStart(3, "0")}`,
	);
	return `"${escaped}"`;
}

export async function dispatch(lua: string): Promise<void> {
	const reply = await hyprctl(["dispatch", lua]);
	if (reply !== "ok") throw new Error(`hyprctl dispatch ${lua}: ${reply}`);
}

export async function evalLua(lua: string): Promise<void> {
	let reply: string;
	try {
		reply = await hyprctl(["eval", lua]);
	} catch (error) {
		const out = (error as { stdout?: string }).stdout?.trim();
		throw new Error(`hyprctl eval failed: ${out || (error as Error).message}`);
	}
	if (reply !== "ok" && reply !== "") throw new Error(`hyprctl eval: ${reply}`);
}

// One eval runs atomically in the compositor, so a focus and the action that depends on it
// cannot be split by user input; any failed dispatcher aborts the rest of the batch.
export function batchLua(calls: string[]): string {
	return [
		"local function run(d) local r = hl.dispatch(d) if r and r.ok == false then error(r.error or \"dispatch failed\", 0) end end",
		...calls.map((call) => `run(${call})`),
	].join("\n");
}

export async function run(...calls: string[]): Promise<void> {
	await evalLua(batchLua(calls));
}

export async function option(name: string): Promise<{ int?: number; bool?: boolean; css?: string } | undefined> {
	try {
		return await hyprJson(`getoption`, name);
	} catch {
		return undefined;
	}
}

export function workspaceSelector(ws: { id: number; name: string }): string {
	return ws.id > 0 ? String(ws.id) : `name:${ws.name}`;
}

const win = (address: string) => luaString(`address:${address}`);

export const dsp = {
	focusMonitor: (name: string) => `hl.dsp.focus({ monitor = ${luaString(name)} })`,
	focusWorkspace: (selector: string, onCurrentMonitor: boolean) =>
		`hl.dsp.focus({ workspace = ${luaString(selector)}, on_current_monitor = ${onCurrentMonitor} })`,
	focusWindow: (address: string) => `hl.dsp.focus({ window = ${win(address)} })`,
	makeGroup: (layout: Layout) => `hl.plugin.hy3.make_group(${luaString(layout)})`,
	changeGroup: (layout: Layout) => `hl.plugin.hy3.change_group(${luaString(layout)})`,
	resize: (address: string, w: number, h: number) =>
		`hl.dsp.window.resize({ x = ${Math.round(w)}, y = ${Math.round(h)}, relative = false, window = ${win(address)} })`,
	move: (address: string, x: number, y: number) =>
		`hl.dsp.window.move({ x = ${Math.round(x)}, y = ${Math.round(y)}, relative = false, window = ${win(address)} })`,
	float: (address: string) => `hl.dsp.window.float({ action = "enable", window = ${win(address)} })`,
	fullscreen: (address: string, mode: "maximized" | "fullscreen") =>
		`hl.dsp.window.fullscreen({ mode = ${luaString(mode)}, action = "set", window = ${win(address)} })`,
	exec: (command: string, workspace: string) =>
		`hl.dsp.exec_cmd(${luaString(command)}, { workspace = ${luaString(workspace)} })`,
	moveToWorkspace: (address: string, selector: string) =>
		`hl.dsp.window.move({ workspace = ${luaString(selector)}, follow = false, window = ${win(address)} })`,
};

export function autotileLua(enable: boolean): string {
	return `hl.config({ plugin = { hy3 = { autotile = { enable = ${enable} } } } })`;
}
