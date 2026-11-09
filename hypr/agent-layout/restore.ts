import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authHook, runHook } from "./auth.ts";
import { readLiveBeacons } from "./beacons.ts";
import { type BuildOp, planBuild } from "./build.ts";
import * as hypr from "./hypr.ts";
import { processStartTime, readTmux, type TmuxState } from "./procs.ts";
import { runtimeDir } from "./snapshot.ts";
import { boundingBox, describeTree, inferTree, isEvenlySplit, leaves, type Node, targetRects } from "./tree.ts";
import type { Agent, Beacon, HyprClient, HyprMonitor, MonitorInfo, Rect, Snapshot } from "./types.ts";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STRIPPED_ENV = /^(TMUX|TMUX_PANE|LUISD_.*|KITTY_.*|PI_BTW_.*|WINDOWID)$/;

export interface Reconciled {
	restore: Agent[];
	running: Agent[];
	orphans: { agent: Agent; beacon: Beacon }[];
}

// A session still open in a detached pi-* tmux session has no window, but its pi keeps
// writing the file; it is stopped and relaunched rather than run twice on one file.
export function reconcile(agents: Agent[], beacons: Beacon[], tmux: TmuxState): Reconciled {
	const live = new Map(beacons.filter((b) => b.sessionFile).map((b) => [b.sessionFile as string, b]));
	const out: Reconciled = { restore: [], running: [], orphans: [] };
	for (const agent of agents) {
		const beacon = live.get(agent.sessionFile);
		if (!beacon) out.restore.push(agent);
		else if (beacon.tmuxSession && tmux.attached.get(beacon.tmuxSession) === 0) out.orphans.push({ agent, beacon });
		else out.running.push(agent);
	}
	return out;
}

export function shellQuote(args: readonly string[]): string {
	return args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)).join(" ");
}

export interface SpawnSpec {
	argv: string[];
	cwd: string;
	warnings: string[];
}

// Interactive bash is what makes `pi` the bashrc function (an overlay's auth refresh, say),
// and `kitten run-shell` leaves a shell with kitty integration once pi exits.
export function spawnSpec(agent: Agent, exists: (path: string) => boolean, home: string): SpawnSpec {
	const warnings: string[] = [];
	let cwd = agent.cwd;
	if (!exists(cwd)) {
		warnings.push(`${agent.cwd} is gone; opened in ~`);
		cwd = home;
	}
	const resume = exists(agent.sessionFile);
	if (!resume) warnings.push(`${agent.sessionFile} is missing; started a new session`);
	const piArgs = [...(resume ? ["--session", agent.sessionFile] : []), ...agent.flags];
	const script = `${shellQuote(["pi", ...piArgs])}; exec kitten run-shell`;
	return { argv: ["kitty", "--directory", cwd, "bash", "-ic", script], cwd, warnings };
}

export function rootLayoutFor(monitor: MonitorInfo | undefined): "h" | "v" {
	if (!monitor) return "h";
	const rotated = monitor.transform % 2 === 1;
	const width = rotated ? monitor.height : monitor.width;
	const height = rotated ? monitor.width : monitor.height;
	return height > width ? "v" : "h";
}

type MonitorGeometry = Pick<MonitorInfo, "x" | "y" | "width" | "height" | "scale" | "transform">;

function logicalSize(m: MonitorGeometry): { w: number; h: number } {
	const rotated = m.transform % 2 === 1;
	return { w: (rotated ? m.height : m.width) / m.scale, h: (rotated ? m.width : m.height) / m.scale };
}

// Floating windows keep absolute layout coordinates, which point off-screen once their monitor
// is gone or moved, so they are mapped proportionally onto the monitor actually used.
export function translateRect(rect: Rect, from: MonitorGeometry | undefined, to: MonitorGeometry | undefined): Rect {
	if (!from || !to) return rect;
	const a = logicalSize(from);
	const b = logicalSize(to);
	const sx = b.w / a.w;
	const sy = b.h / a.h;
	return { x: to.x + (rect.x - from.x) * sx, y: to.y + (rect.y - from.y) * sy, w: rect.w * sx, h: rect.h * sy };
}

export interface WorkspacePlan {
	workspace: Agent["workspace"];
	tiled: Agent[];
	floating: Agent[];
	fullscreen: Agent[];
	tree: Node | undefined;
}

export function planWorkspaces(snapshot: Snapshot, agents: Agent[]): WorkspacePlan[] {
	const byWorkspace = new Map<number, Agent[]>();
	for (const agent of agents) {
		const list = byWorkspace.get(agent.workspace.id);
		if (list) list.push(agent);
		else byWorkspace.set(agent.workspace.id, [agent]);
	}
	const monitorOrder = snapshot.monitors.map((m) => m.name);
	return [...byWorkspace.values()]
		.map((list) => {
			const workspace = list[0].workspace;
			const tiled = list.filter((a) => !a.floating && a.fullscreen === 0);
			const monitor = snapshot.monitors.find((m) => m.name === workspace.monitor);
			const items = tiled.map((a, id) => ({ id, rect: a.rect, hidden: a.hidden }));
			return {
				workspace,
				tiled,
				floating: list.filter((a) => a.floating && a.fullscreen === 0),
				fullscreen: list.filter((a) => a.fullscreen !== 0),
				tree: inferTree(items, rootLayoutFor(monitor)),
			};
		})
		.sort(
			(a, b) =>
				monitorOrder.indexOf(a.workspace.monitor) - monitorOrder.indexOf(b.workspace.monitor) ||
				a.workspace.id - b.workspace.id,
		);
}

export function agentLabel(agent: Agent): string {
	const base = agent.sessionName || agent.cwd.replace(os.homedir(), "~");
	return `${base} (${agent.sessionId.slice(-8)})`;
}

export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !STRIPPED_ENV.test(key)) out[key] = value;
	}
	return out;
}

export async function notify(summary: string, body = "", replaceId?: string): Promise<string | undefined> {
	const args = ["-a", "Restore Agents", "-i", "view-restore", "-p"];
	if (replaceId) args.push("-r", replaceId);
	try {
		const { stdout } = await execFileAsync("notify-send", [...args, summary, body], { timeout: 3000 });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 100): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== undefined) return value;
		await sleep(intervalMs);
	}
	return undefined;
}

async function waitForClient(pid: number): Promise<HyprClient> {
	const client = await waitFor(async () => (await hypr.clients()).find((c) => c.pid === pid && c.mapped), 20000);
	if (!client) throw new Error(`kitty (pid ${pid}) never mapped a window`);
	return client;
}

async function stopOrphan(beacon: Beacon): Promise<boolean> {
	const alive = async () => (processStartTime(beacon.pid) === beacon.startTime ? true : undefined);
	if (beacon.tmuxSession) await execFileAsync("tmux", ["kill-session", "-t", beacon.tmuxSession]).catch(() => {});
	if (!(await waitFor(async () => ((await alive()) ? undefined : true), 10000))) {
		try {
			process.kill(beacon.pid, "SIGTERM");
		} catch {}
	}
	return (await waitFor(async () => ((await alive()) ? undefined : true), 5000)) === true;
}

async function ensureAuth(log: (msg: string) => void): Promise<boolean> {
	const hook = authHook();
	if (!hook || (await runHook(hook, ["check"]))) return true;
	log("credentials expired; running the pi-auth hook's login once");
	await notify("Restore Agents", "Log in once in the terminal that just opened; agents start afterwards.");
	await new Promise<void>((resolve) => {
		const child = spawn("kitty", [hook, "login"], { env: cleanEnv(process.env), stdio: "ignore" });
		child.on("exit", () => resolve());
		child.on("error", () => resolve());
	});
	return runHook(hook, ["check"]);
}

async function layoutMetrics(): Promise<{ gap: number; tabBar: number }> {
	const [gapsIn, border, tabHeight, tabPadding] = await Promise.all([
		hypr.option("general:gaps_in"),
		hypr.option("general:border_size"),
		hypr.option("plugin:hy3:tabs:height"),
		hypr.option("plugin:hy3:tabs:padding"),
	]);
	const gaps = Number((gapsIn?.css ?? String(gapsIn?.int ?? 5)).split(/\s+/)[0]) || 0;
	return { gap: 2 * gaps + 2 * (border?.int ?? 2), tabBar: (tabHeight?.int ?? 22) + (tabPadding?.int ?? 5) };
}

interface RestoreContext {
	runtimeDir: string;
	log: (msg: string) => void;
	warnings: string[];
	addresses: Map<Agent, string>;
	liveMonitors: HyprMonitor[];
	snapshotMonitors: MonitorInfo[];
	focusedMonitor: string;
}

let spawnCounter = 0;

// The exec rule pins the window to its workspace even if focus wanders, and `exec` keeps the
// pid Hyprland spawned; the shell writes that pid first so the new client can be matched.
export function execCommand(spec: SpawnSpec, pidFile: string): string {
	return `echo $$ > ${shellQuote([pidFile])}; exec ${shellQuote(spec.argv)}`;
}

async function spawnAgent(agent: Agent, ctx: RestoreContext, focus: string[], workspace: string): Promise<string> {
	const spec = spawnSpec(agent, existsSync, os.homedir());
	ctx.warnings.push(...spec.warnings.map((w) => `${agentLabel(agent)}: ${w}`));
	const pidFile = path.join(ctx.runtimeDir, `spawn-${process.pid}-${++spawnCounter}.pid`);
	rmSync(pidFile, { force: true });
	await hypr.run(...focus, hypr.dsp.exec(execCommand(spec, pidFile), workspace));
	const pid = await waitFor(async () => {
		try {
			const value = Number(readFileSync(pidFile, "utf8").trim());
			return value > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}, 10000);
	rmSync(pidFile, { force: true });
	if (!pid) throw new Error(`terminal for ${agentLabel(agent)} never started`);
	const client = await waitForClient(pid);
	ctx.addresses.set(agent, client.address);
	ctx.log(`  spawned ${agentLabel(agent)} -> ${client.address} on ws ${client.workspace.name}`);
	return client.address;
}

async function runOps(ops: BuildOp[], tiled: Agent[], ctx: RestoreContext, hy3: boolean, enter: string[], workspace: string) {
	for (const op of ops) {
		if (op.op === "spawn") {
			const anchor = op.anchor === null ? undefined : ctx.addresses.get(tiled[op.anchor]);
			await spawnAgent(tiled[op.item], ctx, anchor ? [hypr.dsp.focusWindow(anchor)] : enter, workspace);
		} else if (hy3) {
			const target = ctx.addresses.get(tiled[op.target]);
			if (!target) continue;
			const group = op.mode === "make" ? hypr.dsp.makeGroup(op.layout) : hypr.dsp.changeGroup(op.layout);
			await hypr.run(hypr.dsp.focusWindow(target), group);
		}
	}
}

async function applyRatios(plan: WorkspacePlan, ctx: RestoreContext): Promise<void> {
	if (!plan.tree || isEvenlySplit(plan.tree)) return;
	const metrics = await layoutMetrics();
	for (let pass = 0; pass < 2; pass++) {
		const live = new Map((await hypr.clients()).map((c) => [c.address, c]));
		const rects = plan.tiled.flatMap((a) => {
			const c = live.get(ctx.addresses.get(a) ?? "");
			return c ? [{ x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1] }] : [];
		});
		if (rects.length === 0) return;
		const targets = targetRects(plan.tree, boundingBox(rects), metrics);
		for (const item of leaves(plan.tree)) {
			const address = ctx.addresses.get(plan.tiled[item]);
			const target = targets.get(item);
			if (!address || !target || live.get(address)?.hidden) continue;
			await hypr.dispatch(hypr.dsp.resize(address, target.w, target.h)).catch(() => {});
		}
	}
}

async function restoreWorkspace(plan: WorkspacePlan, ctx: RestoreContext): Promise<void> {
	const { workspace } = plan;
	if (workspace.id < 0) {
		ctx.warnings.push(`skipped special workspace ${workspace.name}`);
		return;
	}
	const monitor = ctx.liveMonitors.some((m) => m.name === workspace.monitor) ? workspace.monitor : ctx.focusedMonitor;
	if (monitor !== workspace.monitor) ctx.warnings.push(`ws ${workspace.name}: ${workspace.monitor} is gone; used ${monitor}`);
	const selector = hypr.workspaceSelector(workspace);
	const enter = [hypr.dsp.focusMonitor(monitor), hypr.dsp.focusWorkspace(selector, true)];
	await hypr.run(...enter);

	const live = (await hypr.workspaces()).find((w) => w.id === workspace.id);
	const empty = !live || live.windows === 0;
	const hy3 = (live?.tiledLayout ?? "hy3") === "hy3";
	ctx.log(`ws ${workspace.name} on ${monitor}: ${plan.tree ? describeTree(plan.tree, (i) => agentLabel(plan.tiled[i])) : "-"}`);

	if (plan.tree) await runOps(planBuild(plan.tree, empty), plan.tiled, ctx, hy3, enter, selector);
	for (const agent of plan.floating) {
		const address = await spawnAgent(agent, ctx, enter, selector);
		const rect = translateRect(
			agent.rect,
			ctx.snapshotMonitors.find((m) => m.name === agent.monitor),
			ctx.liveMonitors.find((m) => m.name === monitor),
		);
		await hypr.dispatch(hypr.dsp.float(address));
		await hypr.dispatch(hypr.dsp.resize(address, rect.w, rect.h));
		await hypr.dispatch(hypr.dsp.move(address, rect.x, rect.y));
	}
	if (hy3) await applyRatios(plan, ctx);
	for (const agent of plan.fullscreen) {
		const address = await spawnAgent(agent, ctx, enter, selector);
		await hypr.dispatch(hypr.dsp.fullscreen(address, agent.fullscreen === 1 ? "maximized" : "fullscreen"));
	}
	for (const [agent, address] of ctx.addresses) {
		if (agent.workspace.id !== workspace.id) continue;
		const client = (await hypr.clients()).find((c) => c.address === address);
		if (client && client.workspace.id !== workspace.id) {
			ctx.warnings.push(`${agentLabel(agent)} opened on ws ${client.workspace.name}; moved it`);
			await hypr.dispatch(hypr.dsp.moveToWorkspace(address, selector));
		}
	}
}

async function restoreFocus(snapshot: Snapshot, ctx: RestoreContext): Promise<void> {
	const liveWorkspaces = await hypr.workspaces();
	const ordered = [...snapshot.monitors].sort((a, b) => Number(a.focused) - Number(b.focused));
	for (const monitor of ordered) {
		if (!ctx.liveMonitors.some((m) => m.name === monitor.name)) continue;
		const ws = liveWorkspaces.find((w) => w.name === monitor.activeWorkspace);
		if (!ws) continue;
		await hypr.dispatch(hypr.dsp.focusMonitor(monitor.name)).catch(() => {});
		await hypr.dispatch(hypr.dsp.focusWorkspace(hypr.workspaceSelector(ws), false)).catch(() => {});
	}
	const focused = snapshot.monitors.find((m) => m.focused);
	const recent = [...ctx.addresses.entries()]
		.filter(([agent]) => agent.workspace.name === focused?.activeWorkspace)
		.sort(([a], [b]) => a.focusHistoryID - b.focusHistoryID)[0];
	if (recent) await hypr.dispatch(hypr.dsp.focusWindow(recent[1])).catch(() => {});
}

export interface RestoreResult {
	restored: number;
	skipped: number;
	warnings: string[];
}

export async function restoreSnapshot(
	snapshot: Snapshot,
	opts: { dryRun: boolean; log: (msg: string) => void },
): Promise<RestoreResult> {
	const { log } = opts;
	const tmux = await readTmux();
	const plan = reconcile(snapshot.agents, readLiveBeacons(), tmux);
	for (const agent of plan.running) log(`already running: ${agentLabel(agent)}`);
	for (const { agent, beacon } of plan.orphans) log(`orphaned in detached ${beacon.tmuxSession}: ${agentLabel(agent)}`);

	const warnings: string[] = [];
	if (opts.dryRun) {
		const toRestore = [...plan.restore, ...plan.orphans.map((o) => o.agent)];
		for (const ws of planWorkspaces(snapshot, toRestore)) {
			log(`ws ${ws.workspace.name} (${ws.workspace.monitor}):`);
			if (ws.tree) {
				log(`  tree ${describeTree(ws.tree, (i) => agentLabel(ws.tiled[i]))}`);
				for (const op of planBuild(ws.tree, true)) {
					log(
						op.op === "spawn"
							? `  spawn ${agentLabel(ws.tiled[op.item])}${op.anchor === null ? "" : ` after ${agentLabel(ws.tiled[op.anchor])}`}`
							: `  ${op.mode}_group ${op.layout} on ${agentLabel(ws.tiled[op.target])}`,
					);
				}
			}
			for (const a of ws.floating) log(`  floating ${agentLabel(a)}`);
			for (const a of ws.fullscreen) log(`  fullscreen ${agentLabel(a)}`);
		}
		for (const agent of toRestore) log(`  $ ${shellQuote(spawnSpec(agent, existsSync, os.homedir()).argv)}`);
		return { restored: 0, skipped: plan.running.length, warnings };
	}

	const toRestore = [...plan.restore];
	for (const { agent, beacon } of plan.orphans) {
		if (await stopOrphan(beacon)) {
			warnings.push(`${agentLabel(agent)}: stopped detached ${beacon.tmuxSession}`);
			toRestore.push(agent);
		} else {
			warnings.push(`${agentLabel(agent)}: could not stop ${beacon.tmuxSession}; skipped`);
		}
	}
	if (toRestore.length === 0) return { restored: 0, skipped: plan.running.length, warnings };

	if (!(await ensureAuth(log))) throw new Error("authentication is still expired; run `pi` once to log in");

	const monitors = await hypr.monitors();
	const runtime = runtimeDir();
	mkdirSync(runtime, { recursive: true, mode: 0o700 });
	const ctx: RestoreContext = {
		runtimeDir: runtime,
		log,
		warnings,
		addresses: new Map(),
		liveMonitors: monitors,
		snapshotMonitors: snapshot.monitors,
		focusedMonitor: monitors.find((m) => m.focused)?.name ?? monitors[0]?.name ?? "",
	};
	const autotile = (await hypr.option("plugin:hy3:autotile:enable"))?.bool;
	if (autotile) await hypr.evalLua(hypr.autotileLua(false));
	try {
		for (const ws of planWorkspaces(snapshot, toRestore)) await restoreWorkspace(ws, ctx);
	} finally {
		if (autotile) await hypr.evalLua(hypr.autotileLua(true));
	}
	await restoreFocus(snapshot, ctx);
	return { restored: ctx.addresses.size, skipped: plan.running.length, warnings };
}
