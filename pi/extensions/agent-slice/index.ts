import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AGENT_SLICE = "agent.slice";
const CGROUP_FS = "/sys/fs/cgroup";
const JOB_SCRIPT = fileURLToPath(new URL("./job-cgroup.sh", import.meta.url));
const WAIT_MS = 2000;

export function inAgentSlice(cgroup: string): boolean {
	return cgroup.trim().split("/").includes(AGENT_SLICE);
}

export function cgroupPath(procSelfCgroup: string): string {
	return procSelfCgroup.trim().replace(/^0::/, "");
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
		"5",
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
		"Delegate",
		"b",
		"true",
		"0",
	];
}

// oomd only kills leaf cgroups, so pi moves to main and each bash it starts to a job leaf beside it;
// Delegate also sets OOMPolicy=continue, so a killed job no longer makes systemd stop pi's scope.
export function splitScope(scopeDir: string): boolean {
	const main = path.join(scopeDir, "main");
	try {
		fs.mkdirSync(main);
		for (const pid of fs.readFileSync(path.join(scopeDir, "cgroup.procs"), "utf-8").split("\n").filter(Boolean)) {
			fs.writeFileSync(path.join(main, "cgroup.procs"), pid);
		}
		fs.writeFileSync(path.join(scopeDir, "cgroup.subtree_control"), "+memory +pids");
		return true;
	} catch {
		// Leaves without the memory controller are invisible to oomd, which would then never kill this
		// pi at all; one candidate holding everything is the safer way to fail.
		try {
			for (const pid of fs.readFileSync(path.join(main, "cgroup.procs"), "utf-8").split("\n").filter(Boolean)) {
				fs.writeFileSync(path.join(scopeDir, "cgroup.procs"), pid);
			}
			fs.rmdirSync(main);
		} catch {}
		return false;
	}
}

export function pruneJobs(scopeDir: string): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(scopeDir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.startsWith("job-")) continue;
		try {
			fs.rmdirSync(path.join(scopeDir, name));
		} catch {}
	}
}

function waitForScope(pid: number): string | undefined {
	const deadline = Date.now() + WAIT_MS;
	const tick = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		const cgroup = cgroupPath(fs.readFileSync("/proc/self/cgroup", "utf-8"));
		if (cgroup.endsWith(`/${AGENT_SLICE}/pi-${pid}.scope`)) return cgroup;
		Atomics.wait(tick, 0, 0, 10);
	}
	return undefined;
}

// Moving pi before it spawns anything puts subagents, tool commands and servers it starts in the
// slice too; a child pi finds itself there already and inherits the parent's job cgroups.
export default function agentSlice(pi: ExtensionAPI) {
	if (process.platform !== "linux") return;
	let cgroup: string;
	try {
		cgroup = fs.readFileSync("/proc/self/cgroup", "utf-8");
	} catch {
		return;
	}
	if (inAgentSlice(cgroup)) {
		// A /reload or a subagent runs this again inside a split scope: the jobs are still there to
		// prune, but the scope must not be split twice.
		const scope = process.env.PI_AGENT_CGROUP;
		if (scope && cgroupPath(cgroup) === `${scope}/main`) pi.on("tool_execution_end", () => pruneJobs(CGROUP_FS + scope));
		return;
	}
	const started = spawnSync("busctl", scopeArgs(process.pid, process.cwd()), { stdio: "ignore", timeout: 2000 });
	if (started.status !== 0 || process.env.BASH_ENV) return;
	const scope = waitForScope(process.pid);
	if (!scope) return;
	const scopeDir = CGROUP_FS + scope;
	if (!splitScope(scopeDir)) return;
	spawnSync("python3", ["-c", "import os, sys; os.setxattr(sys.argv[1], 'user.oomd_avoid', b'1')", path.join(scopeDir, "main")], {
		stdio: "ignore",
		timeout: 2000,
	});
	process.env.PI_AGENT_CGROUP = scope;
	process.env.BASH_ENV = JOB_SCRIPT;
	pi.on("tool_execution_end", () => pruneJobs(scopeDir));
}
