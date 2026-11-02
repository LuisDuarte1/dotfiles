import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	blockReason,
	ENTRY_TYPE,
	isInside,
	type Mode,
	promptSection,
	readOnlyHint,
	resolveMode,
	resolveRealPath,
	SLUG,
	slugify,
} from "./guard.ts";

const info = { origin: "/work/repo", root: "/tmp/pi-btw/repo-1234", createdAt: "2026-10-12T12:00:00.000Z" };
const sandboxed: Mode = { kind: "sandboxed", info };
const unsandboxed: Mode = { kind: "unsandboxed", info };
const sandboxEnv = { PI_BTW_SANDBOX: "1", PI_BTW_ORIGIN: info.origin, PI_BTW_ROOT: info.root };
const marker = { type: "custom", customType: ENTRY_TYPE, data: info };

test("isInside handles equal paths, children, siblings and dot-prefixed names", () => {
	assert.equal(isInside("/a/b", "/a/b"), true);
	assert.equal(isInside("/a/b/c", "/a/b"), true);
	assert.equal(isInside("/a/bc", "/a/b"), false);
	assert.equal(isInside("/a", "/a/b"), false);
	assert.equal(isInside("/a/b/..c", "/a/b"), true);
});

test("resolveMode: sandbox env wins, marker alone means unsandboxed, neither means off", () => {
	assert.equal(resolveMode(sandboxEnv, []).kind, "sandboxed");
	assert.equal(resolveMode(sandboxEnv, [marker]).kind, "sandboxed");
	assert.deepEqual(resolveMode({}, [{ type: "message" }, marker]), unsandboxed);
	assert.deepEqual(resolveMode({}, [{ type: "custom", customType: "other" }]), { kind: "off" });
	assert.equal(resolveMode({ PI_BTW_SANDBOX: "1" }, []).kind, "off");
});

const promotion = { worktree: "/work/repo-fix", branch: "me/fix/01", stack: "fix", base: "main", at: "t" };
const promotedMarker = { type: "custom", customType: ENTRY_TYPE, data: { ...info, promoted: promotion } };

test("resolveMode: the latest marker wins, so a promotion marker turns the session into a worktree session", () => {
	const mode = resolveMode({}, [marker, { type: "message" }, promotedMarker]);
	assert.equal(mode.kind, "promoted");
	assert.equal(mode.kind === "promoted" && mode.info.promoted.worktree, "/work/repo-fix");
	const sandboxedMode = resolveMode(sandboxEnv, [promotedMarker]);
	assert.equal(sandboxedMode.kind, "sandboxed");
	assert.equal(sandboxedMode.kind === "sandboxed" ? sandboxedMode.info.promoted : "unreachable", undefined);
});

test("promoted: bash runs freely, edits into origin are redirected to the worktree", () => {
	const promoted: Mode = { kind: "promoted", info: { ...info, promoted: promotion } };
	assert.equal(blockReason(promoted, { toolName: "bash", input: { command: "make" }, cwd: "/work/repo-fix" }), undefined);
	assert.equal(blockReason(promoted, { toolName: "write", input: { path: "a.ts" }, cwd: "/work/repo-fix" }), undefined);
	assert.match(
		blockReason(promoted, { toolName: "edit", input: { path: "/work/repo/src/a.ts" }, cwd: "/work/repo-fix" }) ?? "",
		/Your copy of this file is \/work\/repo-fix\/src\/a\.ts/,
	);
	assert.match(promptSection(promoted) ?? "", /promoted into its own git worktree \/work\/repo-fix, on gstuff stack `fix`/);
});

test("slugify turns a session name into a branch-safe name", () => {
	assert.equal(slugify("btw: Why does X do Y?"), "why-does-x-do-y");
	assert.equal(slugify("  "), "btw");
	assert.equal(slugify("a".repeat(60)).length, 40);
	for (const name of ["why-does-x-do-y", "btw", "a1"]) assert.match(name, SLUG);
	for (const name of ["-x", "X", "a b", "a;b", "a".repeat(41)]) assert.doesNotMatch(name, SLUG);
});

test("sandboxed: edit/write into origin are blocked with the matching copy path", () => {
	const reason = blockReason(sandboxed, { toolName: "write", input: { path: "/work/repo/src/a.ts" }, cwd: info.root });
	assert.match(reason ?? "", /\/work\/repo is read-only/);
	assert.match(reason ?? "", /\/tmp\/pi-btw\/repo-1234\/src\/a\.ts/);
	assert.ok(blockReason(sandboxed, { toolName: "edit", input: { path: "../../../work/repo/x" }, cwd: "/tmp/pi-btw/repo-1234" }));
});

test("sandboxed: copy paths, reads and bash pass through", () => {
	assert.equal(blockReason(sandboxed, { toolName: "write", input: { path: "src/a.ts" }, cwd: info.root }), undefined);
	assert.equal(blockReason(sandboxed, { toolName: "read", input: { path: "/work/repo/a" }, cwd: info.root }), undefined);
	assert.equal(blockReason(sandboxed, { toolName: "bash", input: { command: "rm -rf /work/repo" }, cwd: info.root }), undefined);
});

test("unsandboxed: only read-only tools run", () => {
	for (const toolName of ["read", "grep", "find", "ls", "codemode"]) {
		assert.equal(blockReason(unsandboxed, { toolName, input: {}, cwd: "/" }), undefined, toolName);
	}
	assert.equal(blockReason(unsandboxed, { toolName: "mcp_x", input: {}, cwd: "/", readOnlyHint: true }), undefined);
	for (const toolName of ["bash", "edit", "write", "bg_do", "subagent", "mcp_y"]) {
		assert.match(blockReason(unsandboxed, { toolName, input: {}, cwd: "/" }) ?? "", /outside its sandbox/, toolName);
	}
});

test("off: nothing is blocked", () => {
	assert.equal(blockReason({ kind: "off" }, { toolName: "write", input: { path: "/work/repo/a" }, cwd: "/" }), undefined);
});

test("resolveRealPath follows symlinked ancestors of not-yet-existing files", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "btw-guard-"));
	try {
		mkdirSync(path.join(dir, "real"));
		symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
		assert.equal(resolveRealPath("link/new/file.txt", dir), path.join(dir, "real", "new", "file.txt"));
		assert.equal(resolveRealPath("~/x", "/", "/home/me"), "/home/me/x");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readOnlyHint only fires for EROFS output in sandboxed mode", () => {
	assert.match(readOnlyHint(sandboxed, ["bash: /work/repo/a: Read-only file system"]) ?? "", /your copy, \/tmp/);
	assert.equal(readOnlyHint(sandboxed, ["permission denied"]), undefined);
	assert.equal(readOnlyHint(unsandboxed, ["Read-only file system"]), undefined);
});

test("promptSection names origin and copy, and is absent when off", () => {
	assert.match(promptSection(sandboxed) ?? "", /\/work\/repo.*read-only/);
	assert.match(promptSection(sandboxed) ?? "", /\/tmp\/pi-btw\/repo-1234 is a snapshot/);
	assert.match(promptSection(unsandboxed) ?? "", /outside its sandbox/);
	assert.equal(promptSection({ kind: "off" }), undefined);
});
