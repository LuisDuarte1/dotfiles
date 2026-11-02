import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ancestors, execDispatch, luaString, parentPid, pickWindow, workspaceSelector } from "./hyprland.ts";

test("parentPid reads ppid after the comm field, even when comm has spaces and parens", () => {
	assert.equal(parentPid("74682 (tmux: client) S 74638 74682 74638 34823 0"), 74638);
	assert.equal(parentPid("9 (a) b) R 3 9 9"), 3);
	assert.equal(parentPid("garbage"), undefined);
});

test("ancestors walks to init and stops on loops or unreadable stats", () => {
	const ppid: Record<number, number> = { 74682: 74638, 74638: 68907, 68907: 68900, 68900: 68899, 68899: 1 };
	const stat = (pid: number) => (pid in ppid ? `${pid} (x) S ${ppid[pid]} 0` : undefined);
	assert.deepEqual(ancestors(74682, stat), [74682, 74638, 68907, 68900, 68899]);
	assert.deepEqual(ancestors(5, (pid) => `${pid} (x) S ${pid === 5 ? 6 : 5} 0`), [5, 6]);
	assert.deepEqual(ancestors(42, () => undefined), [42]);
});

test("pickWindow prefers the most recently focused window owned by a parent process", () => {
	const ws = (id: number) => ({ id, name: String(id) });
	const clients = [
		{ pid: 31955, workspace: ws(3), focusHistoryID: 3 },
		{ pid: 68900, workspace: ws(4), focusHistoryID: 5 },
		{ pid: 46165, workspace: ws(6), focusHistoryID: 1 },
		{ pid: 999, workspace: ws(9), focusHistoryID: 0 },
	];
	assert.equal(pickWindow(clients, new Set([68900, 46165]))?.workspace.id, 6);
	assert.equal(pickWindow(clients, new Set([1234])), undefined);
});

test("workspaceSelector handles numbered, named and special workspaces", () => {
	assert.equal(workspaceSelector({ id: 4, name: "4" }), "4");
	assert.equal(workspaceSelector({ id: -1337, name: "web" }), "name:web");
	assert.equal(workspaceSelector({ id: -98, name: "special:scratch" }), "special:scratch");
});

test("luaString escapes quotes, backslashes and control characters", () => {
	assert.equal(luaString('a "b" \\c'), '"a \\"b\\" \\\\c"');
	assert.equal(luaString("x\ny\0"), '"x\\010y\\000"');
});

test("execDispatch execs the terminal and goes silent only off-screen", () => {
	const ws = { id: 4, name: "4" };
	assert.equal(
		execDispatch("kitty -T 'btw: q'", { workspace: ws, active: false }),
		`hl.dsp.exec_cmd("exec kitty -T 'btw: q'", { workspace = "4 silent" })`,
	);
	assert.match(execDispatch("kitty", { workspace: ws, active: true }), /\{ workspace = "4" \}\)$/);
});

test("luaString output round-trips through a real Lua parser when one is available", (t) => {
	const lua = ["lua", "luajit", "lua5.4", "lua5.1"].find((bin) => {
		try {
			execFileSync(bin, ["-v"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	});
	if (!lua) return t.skip("no lua interpreter on PATH");
	const tricky = "q: \"it's\" \\ ; $(x)\n\tend";
	const out = execFileSync(lua, ["-e", `io.write(${luaString(tricky)})`], { encoding: "utf8" });
	assert.equal(out, tricky);
});
