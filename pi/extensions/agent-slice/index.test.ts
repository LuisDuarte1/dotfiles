import assert from "node:assert/strict";
import test from "node:test";
import { inAgentSlice, scopeArgs } from "./index.ts";

test("a pi already under agent.slice stays where it is", () => {
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/agent.slice/pi-42.scope\n"), true);
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/agent.slice\n"), true);
});

test("a pi in a terminal window or the login session gets moved", () => {
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/app.slice/kitty-1-0.scope\n"), false);
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/session-2.scope\n"), false);
	assert.equal(inAgentSlice("0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-agent.slice.scope\n"), false);
});

test("the scope adopts this pid into agent.slice and is collected even after an oomd kill", () => {
	const args = scopeArgs(42, "/work");
	const props = args.slice(args.indexOf("fail") + 2, -1);
	assert.deepEqual(props, ["PIDs", "au", "1", "42", "Slice", "s", "agent.slice", "Description", "s", "pi in /work", "CollectMode", "s", "inactive-or-failed"]);
	assert.equal(args[args.indexOf("fail") + 1], "4");
	assert.ok(args.includes("pi-42.scope"));
});
