import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readLiveBeacons } from "./beacons.ts";
import * as hypr from "./hypr.ts";
import { tryLock } from "./lock.ts";
import { readProcTable, readTmux } from "./procs.ts";
import { notify, restoreSnapshot } from "./restore.ts";
import {
	buildSnapshot,
	defaultSnapshot,
	describeSnapshot,
	listSnapshots,
	loadSnapshot,
	type StoredSnapshot,
	saveSnapshot,
	stateDir,
} from "./snapshot.ts";
import type { Snapshot } from "./types.ts";

const execFileAsync = promisify(execFile);

const HELP = `Usage: agent-layout <command> [options]

Snapshot and restore pi agent terminals (kitty) and their hy3 layout on Hyprland.

Commands:
  snapshot              Record pi terminals, workspaces and monitors
  list [--json]         List stored snapshots, newest first
  restore [options]     Recreate the agents of a previous Hyprland session
      --snapshot FILE   Restore this snapshot instead of the default
      --pick            Choose the snapshot with rofi
      --dry-run         Print what would happen without touching anything
  help                  Show this help

The default restore source is the newest snapshot with agents from a previous
Hyprland instance. Snapshots live in $XDG_STATE_HOME/agent-layout/snapshots.
`;

const lockFile = () => path.join(stateDir(), "lock");

function logger(echo: boolean): (msg: string) => void {
	const file = path.join(stateDir(), "restore.log");
	mkdirSync(stateDir(), { recursive: true });
	return (msg) => {
		if (echo) console.error(msg);
		appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
	};
}

async function teardownInProgress(): Promise<boolean> {
	const state = await execFileAsync("systemctl", ["is-system-running"]).then(
		(r) => r.stdout.trim(),
		(e: { stdout?: string }) => String(e.stdout ?? "").trim(),
	);
	if (!["running", "degraded", "starting", "initializing"].includes(state)) return true;
	const target = await execFileAsync("systemctl", ["--user", "is-active", "hyprland-session.target"]).then(
		(r) => r.stdout.trim(),
		(e: { stdout?: string }) => String(e.stdout ?? "").trim(),
	);
	return target !== "active";
}

async function snapshotCommand(quiet: boolean): Promise<number> {
	const instance = process.env.HYPRLAND_INSTANCE_SIGNATURE;
	if (!instance) {
		console.error("agent-layout: HYPRLAND_INSTANCE_SIGNATURE is not set (not in a Hyprland session?)");
		return 1;
	}
	// Under the systemd timer a tick can land while the session is being torn down, which would
	// record agents already killed; manual runs skip the check so they always do what was asked.
	if (process.env.INVOCATION_ID && (await teardownInProgress())) return 0;
	const lock = tryLock(lockFile());
	if (!lock) {
		if (!quiet) console.error("agent-layout: restore in progress; snapshot skipped");
		return 0;
	}
	try {
		const [clients, monitors, workspaces, tmux] = await Promise.all([
			hypr.clients(),
			hypr.monitors(),
			hypr.workspaces(),
			readTmux(),
		]);
		const snapshot = buildSnapshot({
			clients,
			monitors,
			workspaces,
			beacons: readLiveBeacons(undefined, undefined, true),
			procs: readProcTable(),
			tmux,
			instance,
			bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
			now: new Date(),
		});
		const { file, created } = saveSnapshot(snapshot);
		if (!quiet) console.log(`${created ? "wrote" : "updated"} ${file}: ${describeSnapshot(snapshot)}`);
		return 0;
	} finally {
		lock.release();
	}
}

function listCommand(json: boolean): number {
	const stored = listSnapshots();
	const current = process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "";
	if (json) {
		console.log(JSON.stringify(stored.map((s) => ({ file: s.file, ...s.snapshot })), null, 2));
		return 0;
	}
	for (const { file, snapshot } of stored) {
		const mark = snapshot.instance === current ? " (this session)" : "";
		console.log(`${describeSnapshot(snapshot)}${mark}  ${path.basename(file)}`);
	}
	return 0;
}

async function pickSnapshot(stored: StoredSnapshot[]): Promise<Snapshot | undefined> {
	const current = process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "";
	const choices = stored.filter((s) => s.snapshot.agents.length > 0).slice(0, 40);
	if (choices.length === 0) return undefined;
	const lines = choices.map((s) => `${describeSnapshot(s.snapshot)}${s.snapshot.instance === current ? "  (this session)" : ""}`);
	const index = await new Promise<number | undefined>((resolve) => {
		const rofi = spawn("rofi", ["-dmenu", "-i", "-format", "i", "-p", "Restore agents from"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		let out = "";
		rofi.stdout.on("data", (chunk) => (out += chunk));
		rofi.on("error", () => resolve(undefined));
		rofi.on("exit", (code) => resolve(code === 0 && out.trim() !== "" ? Number(out.trim()) : undefined));
		rofi.stdin.end(lines.join("\n"));
	});
	return index === undefined ? undefined : choices[index]?.snapshot;
}

async function restoreCommand(opts: { file?: string; pick: boolean; dryRun: boolean }): Promise<number> {
	const interactive = Boolean(process.stderr.isTTY);
	const log = logger(interactive || opts.dryRun);
	const stored = listSnapshots();
	const snapshot = opts.file
		? loadSnapshot(opts.file)
		: opts.pick
			? await pickSnapshot(stored)
			: defaultSnapshot(stored, process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "")?.snapshot;
	if (!snapshot) {
		if (!opts.pick && !opts.dryRun) await notify("Restore Agents", "No snapshot from a previous session to restore.");
		log("no snapshot to restore");
		return opts.pick ? 0 : 1;
	}
	log(`restoring ${describeSnapshot(snapshot)} (instance ${snapshot.instance})`);
	if (opts.dryRun) {
		await restoreSnapshot(snapshot, { dryRun: true, log });
		return 0;
	}

	const lock = tryLock(lockFile());
	if (!lock) {
		await notify("Restore Agents", "A restore is already running.");
		return 1;
	}
	const id = await notify("Restoring agents…", `${snapshot.agents.length} terminals — hands off the mouse for a moment.`);
	try {
		const result = await restoreSnapshot(snapshot, { dryRun: false, log });
		for (const w of result.warnings) log(`warning: ${w}`);
		const summary =
			result.restored === 0 && result.skipped > 0
				? `All ${result.skipped} agents are already running`
				: `Restored ${result.restored} agents${result.skipped ? `, ${result.skipped} already running` : ""}`;
		await notify(summary, result.warnings.join("\n"), id);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`error: ${message}`);
		await notify("Restore Agents failed", message, id);
		return 1;
	} finally {
		lock.release();
	}
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const flag = (name: string) => rest.includes(name);
	const value = (name: string) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	switch (command) {
		case "snapshot":
			return snapshotCommand(flag("--quiet"));
		case "list":
			return listCommand(flag("--json"));
		case "restore":
			return restoreCommand({ file: value("--snapshot"), pick: flag("--pick"), dryRun: flag("--dry-run") });
		case "help":
		case "--help":
		case "-h":
		case undefined:
			console.log(HELP);
			return command === undefined ? 1 : 0;
		default:
			console.error(`agent-layout: unknown command '${command}'\n`);
			console.error(HELP);
			return 1;
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		console.error(`agent-layout: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
