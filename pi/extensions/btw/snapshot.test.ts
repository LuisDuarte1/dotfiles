import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSnapshot } from "./snapshot.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function scratchRepo(dir: string): string {
	const repo = path.join(dir, "origin");
	mkdirSync(path.join(repo, "sub"), { recursive: true });
	git(dir, "init", "-q", "-b", "main", repo);
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	writeFileSync(path.join(repo, "a.txt"), "one\n");
	writeFileSync(path.join(repo, "sub", "b.txt"), "keep\n");
	writeFileSync(path.join(repo, "del.txt"), "gone\n");
	writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	writeFileSync(path.join(repo, "a.txt"), "one\nstaged\n");
	git(repo, "add", "a.txt");
	writeFileSync(path.join(repo, "a.txt"), "one\nstaged\nunstaged\n");
	writeFileSync(path.join(repo, "untracked.txt"), "new\n");
	rmSync(path.join(repo, "del.txt"));
	mkdirSync(path.join(repo, "node_modules"));
	writeFileSync(path.join(repo, "node_modules", "m.js"), "x\n");
	return repo;
}

const fingerprint = (repo: string) => ({
	index: createHash("sha256").update(readFileSync(path.join(repo, ".git", "index"))).digest("hex"),
	objects: git(repo, "count-objects", "-v"),
	refs: git(repo, "for-each-ref"),
	worktrees: git(repo, "worktree", "list", "--porcelain"),
});

test("snapshot mirrors status, diffs and branch without writing to origin", async () => {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "btw-snap-")));
	try {
		const repo = scratchRepo(dir);
		const before = fingerprint(repo);
		const snap = await createSnapshot(path.join(repo, "sub"), { base: path.join(dir, "snaps") });

		assert.deepEqual(fingerprint(repo), before);
		assert.equal(snap.origin, repo);
		assert.equal(snap.branch, "main");
		assert.equal(snap.cwd, path.join(snap.root, "sub"));
		assert.deepEqual(snap.protect, [repo]);
		assert.equal(git(snap.root, "status", "--porcelain=v1"), git(repo, "status", "--porcelain=v1"));
		assert.equal(git(snap.root, "diff"), git(repo, "diff"));
		assert.equal(git(snap.root, "diff", "--cached"), git(repo, "diff", "--cached"));
		assert.equal(git(snap.root, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
		assert.equal(git(snap.root, "symbolic-ref", "--short", "HEAD").trim(), "main");
		assert.equal(existsSync(path.join(snap.root, "node_modules")), false);
		assert.equal(existsSync(path.join(snap.root, ".git", "btw-snapshot-index")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a linked-worktree origin also protects its out-of-tree git dirs", async () => {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "btw-snap-")));
	try {
		const repo = scratchRepo(dir);
		const linked = path.join(dir, "linked");
		git(repo, "worktree", "add", "-q", "--detach", linked);
		writeFileSync(path.join(linked, "a.txt"), "linked change\n");
		const snap = await createSnapshot(linked, { base: path.join(dir, "snaps") });

		assert.equal(snap.branch, undefined);
		assert.deepEqual(snap.protect, [linked, path.join(repo, ".git", "worktrees", "linked"), path.join(repo, ".git")]);
		assert.equal(git(snap.root, "status", "--porcelain=v1"), git(linked, "status", "--porcelain=v1"));
		assert.equal(readFileSync(path.join(snap.root, "a.txt"), "utf8"), "linked change\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses non-repos and origins that contain pi's own directories", async () => {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "btw-snap-")));
	try {
		await assert.rejects(createSnapshot(dir, { base: path.join(dir, "snaps") }), /not inside a git repository/);
		const repo = scratchRepo(dir);
		await assert.rejects(createSnapshot(repo, { base: path.join(repo, "snaps") }), /mounting it read-only would break pi/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
