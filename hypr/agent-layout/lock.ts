import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { processStartTime } from "./procs.ts";

export interface Lock {
	release(): void;
}

// A write that failed with ENOSPC once left the lock empty, which read as a live owner and
// blocked every snapshot and restore for good; linking a written file makes it all-or-nothing.
function create(file: string, owner: string): void {
	const tmp = `${file}.${process.pid}`;
	try {
		writeFileSync(tmp, owner);
		linkSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
}

// The owner's pid and start time are stored so a lock left by a crashed run can be taken
// over, instead of blocking every later snapshot until someone deletes the file.
export function tryLock(file: string, pid = process.pid): Lock | undefined {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const owner = `${pid} ${processStartTime(pid) ?? ""}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			create(file, owner);
			return { release: () => rmSync(file, { force: true }) };
		} catch {
			let held = "";
			try {
				held = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const [heldPid, heldStart] = held.split(" ");
			if (heldStart && processStartTime(Number(heldPid)) === heldStart) return undefined;
			rmSync(file, { force: true });
		}
	}
	return undefined;
}
