import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { processStartTime } from "./procs.ts";

export interface Lock {
	release(): void;
}

// The owner's pid and start time are stored so a lock left by a crashed run can be taken
// over, instead of blocking every later snapshot until someone deletes the file.
export function tryLock(file: string, pid = process.pid): Lock | undefined {
	mkdirSync(path.dirname(file), { recursive: true });
	const owner = `${pid} ${processStartTime(pid) ?? ""}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, owner, { flag: "wx" });
			return { release: () => rmSync(file, { force: true }) };
		} catch {
			let held = "";
			try {
				held = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const [heldPid, heldStart] = held.split(" ");
			if (processStartTime(Number(heldPid)) === heldStart) return undefined;
			rmSync(file, { force: true });
		}
	}
	return undefined;
}
