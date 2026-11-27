import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

export const AGENT_SLICE = "agent.slice";

export function inAgentSlice(cgroup: string): boolean {
	return cgroup.trim().split("/").includes(AGENT_SLICE);
}

export function scopeArgs(pid: number, cwd: string): string[] {
	return [
		"--user",
		"call",
		"org.freedesktop.systemd1",
		"/org/freedesktop/systemd1",
		"org.freedesktop.systemd1.Manager",
		"StartTransientUnit",
		"ssa(sv)a(sa(sv))",
		`pi-${pid}.scope`,
		"fail",
		"4",
		"PIDs",
		"au",
		"1",
		String(pid),
		"Slice",
		"s",
		AGENT_SLICE,
		"Description",
		"s",
		`pi in ${cwd}`,
		"CollectMode",
		"s",
		"inactive-or-failed",
		"0",
	];
}

// Moving pi before it spawns anything puts subagents, tool commands and servers it starts in the
// slice too; a child pi finds itself there already, so one top-level pi is one oomd candidate.
export default function agentSlice() {
	if (process.platform !== "linux") return;
	let cgroup: string;
	try {
		cgroup = fs.readFileSync("/proc/self/cgroup", "utf-8");
	} catch {
		return;
	}
	if (inAgentSlice(cgroup)) return;
	spawnSync("busctl", scopeArgs(process.pid, process.cwd()), { stdio: "ignore", timeout: 2000 });
}
