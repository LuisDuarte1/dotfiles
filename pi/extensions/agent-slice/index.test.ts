import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cgroupPath, inAgentSlice, pruneJobs, scopeArgs } from "./index.ts";

test("a pi already under agent.slice stays where it is", () => {
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/agent.slice/pi-42.scope\n"), true);
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/agent.slice\n"), true);
});

test("a pi in a terminal window or the login session gets moved", () => {
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/app.slice/kitty-1-0.scope\n"), false);
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/session-2.scope\n"), false);
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-agent.slice.scope\n"), false);
});

test("the scope adopts this pid into agent.slice, is delegated to pi, and is collected after an oomd kill", () => {
	const args = scopeArgs(42, "/work");
	const props = args.slice(args.indexOf("fail") + 2, -1);
	assert.deepEqual(props, ["PIDs", "au", "1", "42", "Slice", "s", "agent.slice", "Description", "s", "pi in /work", "CollectMode", "s", "inactive-or-failed", "Delegate", "b", "true"]);
	assert.equal(args[args.indexOf("fail") + 1], "5");
	assert.ok(args.includes("pi-42.scope"));
});

test("the cgroup path is read from the unified hierarchy line", () => {
	assert.equal(cgroupPath("0::/user.slice/agent.slice/pi-42.scope/main\n"), "/user.slice/agent.slice/pi-42.scope/main");
});

test("pruning removes finished job cgroups and leaves running ones and pi's own", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-slice-"));
	for (const d of ["main", "job-1-100", "job-2-100"]) fs.mkdirSync(path.join(dir, d));
	fs.writeFileSync(path.join(dir, "job-2-100", "cgroup.procs"), "2\n");
	pruneJobs(dir);
	assert.deepEqual(fs.readdirSync(dir).sort(), ["job-2-100", "main"]);
	fs.rmSync(dir, { recursive: true });
});
