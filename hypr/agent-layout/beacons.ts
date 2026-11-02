import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { processStartTime } from "./procs.ts";
import type { Beacon } from "./types.ts";

export function beaconDir(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
	return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "pi-beacons") : path.join(tmpdir(), `pi-beacons-${uid}`);
}

export function isBeacon(value: unknown): value is Beacon {
	const b = value as Beacon;
	return (
		typeof b === "object" &&
		b !== null &&
		b.version === 1 &&
		Number.isInteger(b.pid) &&
		typeof b.startTime === "string" &&
		typeof b.cwd === "string" &&
		(b.sessionFile === null || typeof b.sessionFile === "string") &&
		Array.isArray(b.flags)
	);
}

export function readLiveBeacons(
	dir: string = beaconDir(),
	startTimeOf: (pid: number) => string | undefined = processStartTime,
	pruneStale = false,
): Beacon[] {
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const live: Beacon[] = [];
	for (const name of entries) {
		const file = path.join(dir, name);
		let beacon: unknown;
		try {
			beacon = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (isBeacon(beacon) && startTimeOf(beacon.pid) === beacon.startTime) live.push(beacon);
		else if (pruneStale) rmSync(file, { force: true });
	}
	return live;
}
