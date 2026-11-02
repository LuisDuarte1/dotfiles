import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Beacon {
	version: 1;
	pid: number;
	startTime: string;
	cwd: string;
	sessionFile: string | null;
	sessionId: string;
	sessionName: string | null;
	flags: string[];
	tmuxSession: string | null;
	updatedAt: string;
}

// Only flags that change how the process runs; model and thinking level are persisted in
// the session file, so replaying them would undo any /model switch made after launch.
const VALUE_FLAGS = new Set(["--mcp-profile"]);
const BOOLEAN_FLAGS = new Set([
	"--web-search",
	"--allow-repo-skills",
	"--approve",
	"-a",
	"--no-approve",
	"-na",
	"--no-mcp",
	"--offline",
]);

export function forwardableFlags(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		const name = arg.split("=", 1)[0];
		if (VALUE_FLAGS.has(name)) {
			if (arg.includes("=")) out.push(arg);
			else if (i + 1 < argv.length) out.push(arg, argv[++i]);
		} else if (BOOLEAN_FLAGS.has(arg)) {
			out.push(arg);
		}
	}
	return out;
}

export function beaconDir(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
	return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "pi-beacons") : path.join(tmpdir(), `pi-beacons-${uid}`);
}

export function beaconPath(dir: string, pid: number): string {
	return path.join(dir, `${pid}.json`);
}

// Field 22 of /proc/<pid>/stat; with the pid it uniquely names a process across pid reuse.
// The comm field may contain spaces or parens, so fields are counted after the last ")".
export function startTimeFromStat(stat: string): string | undefined {
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return fields[19];
}

export function processStartTime(pid: number): string | undefined {
	try {
		return startTimeFromStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return undefined;
	}
}

export function writeBeacon(dir: string, beacon: Beacon): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = beaconPath(dir, beacon.pid);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(beacon)}\n`, { mode: 0o600 });
	renameSync(tmp, target);
}

export function removeBeacon(dir: string, pid: number): void {
	rmSync(beaconPath(dir, pid), { force: true });
}
