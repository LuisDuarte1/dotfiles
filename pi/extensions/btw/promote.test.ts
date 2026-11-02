import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stacksDir } from "./gstuff.ts";
import type { BtwInfo } from "./guard.ts";
import { appendMarker, planPromotion, REQUEST_FILE, readRequest, runPromotion, writeRequest } from "./promote.ts";
import { createSnapshot } from "./snapshot.ts";

const hasGstuff = spawnSync("gstuff", ["--help"], { stdio: "ignore" }).status === 0;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Fixture {
	dir: string;
	origin: string;
	env: NodeJS.ProcessEnv;
	info: BtwInfo;
}

async function fixture(prepare?: (origin: string, env: NodeJS.ProcessEnv) => void): Promise<Fixture> {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "btw-promote-")));
	const origin = path.join(dir, "origin");
	const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, "config"), USER: "tester" };
	mkdirSync(origin);
	git(dir, "init", "-q", "-b", "main", origin);
	git(origin, "config", "user.email", "t@t");
	git(origin, "config", "user.name", "t");
	writeFileSync(path.join(origin, "a.txt"), "one\n");
	git(origin, "add", "-A");
	git(origin, "commit", "-qm", "init");
	prepare?.(origin, env);
	writeFileSync(path.join(origin, "wip.txt"), "main agent's uncommitted work\n");
	const snap = await createSnapshot(origin, { base: path.join(dir, "snaps") });
	writeFileSync(path.join(snap.root, "side.txt"), "made in the btw session\n");
	const info = { origin, root: snap.root, createdAt: "t0", head: snap.head, branch: snap.branch, work: snap.work };
	return { dir, origin, env, info };
}

const fingerprint = (repo: string) => ({
	head: git(repo, "rev-parse", "--symbolic-full-name", "HEAD"),
	index: createHash("sha256").update(readFileSync(path.join(repo, ".git", "index"))).digest("hex"),
	status: git(repo, "status", "--porcelain=v1"),
});

test("not on a stack: a new gstuff stack on the current branch, in a sibling worktree", { skip: !hasGstuff }, async () => {
	const f = await fixture();
	try {
		const before = fingerprint(f.origin);
		const plan = await planPromotion({ info: f.info, slug: "fix", title: "btw: fix the thing", hasGstuff: true, env: f.env });
		assert.deepEqual(plan.registration, { kind: "new", name: "fix", base: "main" });
		assert.equal(plan.worktree, `${f.origin}-fix`);
		assert.equal(plan.changedInSession, 1);

		const promotion = await runPromotion(plan, f.env);
		assert.deepEqual(fingerprint(f.origin), before);
		assert.deepEqual({ ...promotion, at: "" }, { worktree: `${f.origin}-fix`, branch: "tester/fix/01", stack: "fix", base: "main", at: "" });
		assert.equal(git(promotion.worktree, "status", "--porcelain=v1"), "");
		assert.equal(readFileSync(path.join(promotion.worktree, "wip.txt"), "utf8"), "main agent's uncommitted work\n");
		assert.equal(readFileSync(path.join(promotion.worktree, "side.txt"), "utf8"), "made in the btw session\n");
		assert.equal(git(promotion.worktree, "log", "-1", "--format=%s"), "fix the thing");
		const stack = JSON.parse(readFileSync(path.join(stacksDir(f.origin, f.env), "fix.json"), "utf8"));
		assert.equal(stack.base, "main");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("on a stack frame: a separate stack forked off that frame, the original stack untouched", { skip: !hasGstuff }, async () => {
	const f = await fixture((origin, env) => {
		execFileSync("gstuff", ["new", "feat"], { cwd: origin, env, stdio: "ignore" });
		writeFileSync(path.join(origin, "feat.txt"), "frame 1\n");
		git(origin, "add", "-A");
		git(origin, "commit", "-qm", "feat");
	});
	try {
		const stackFile = path.join(stacksDir(f.origin, f.env), "feat.json");
		const stackBefore = readFileSync(stackFile, "utf8");
		const before = fingerprint(f.origin);
		const plan = await planPromotion({ info: f.info, slug: "fix", title: "fix", hasGstuff: true, env: f.env });
		assert.deepEqual(plan.registration, { kind: "fork", stack: "feat", frame: 1, name: "feat-fix", base: "tester/feat/01" });

		const promotion = await runPromotion(plan, f.env);
		assert.equal(promotion.branch, "tester/feat-fix/01");
		assert.equal(promotion.stack, "feat-fix");
		assert.deepEqual(fingerprint(f.origin), before);
		assert.equal(readFileSync(stackFile, "utf8"), stackBefore, "the main agent's stack JSON (and pointer) is untouched");
		assert.equal(git(promotion.worktree, "rev-parse", "HEAD~1"), git(f.origin, "rev-parse", "tester/feat/01"));
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("bases on the upstream when the branch is level with it", async () => {
	const f = await fixture((origin) => {
		const remote = path.join(path.dirname(origin), "up.git");
		git(path.dirname(origin), "init", "-q", "--bare", remote);
		git(origin, "remote", "add", "up", remote);
		git(origin, "push", "-q", "-u", "up", "main");
	});
	try {
		const plan = await planPromotion({ info: f.info, slug: "fix", title: "fix", hasGstuff: true, env: f.env });
		assert.deepEqual(plan.registration, { kind: "new", name: "fix", base: "up/main" });
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("without gstuff: a plain branch; names and paths never collide", async () => {
	const f = await fixture();
	try {
		mkdirSync(`${f.origin}-fix`);
		git(f.origin, "branch", "tester/fix");
		const plan = await planPromotion({ info: f.info, slug: "fix", title: "fix", hasGstuff: false, env: f.env });
		assert.deepEqual(plan.registration, { kind: "branch", branch: "tester/fix-2", reason: "gstuff is not installed" });
		assert.equal(plan.worktree, `${f.origin}-fix-2`);
		const promotion = await runPromotion(plan, f.env);
		assert.equal(git(promotion.worktree, "symbolic-ref", "--short", "HEAD"), "tester/fix-2");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("long questions become a commit subject cut at a word boundary, without an ellipsis", async () => {
	const f = await fixture();
	try {
		const title = "Use the write tool to create fix.txt containing the word fixed and then explain why it matters";
		const plan = await planPromotion({ info: f.info, slug: "long", title, hasGstuff: false, env: f.env });
		const promotion = await runPromotion(plan, f.env);
		const subject = git(promotion.worktree, "log", "-1", "--format=%s");
		assert.equal(subject, "Use the write tool to create fix.txt containing the word fixed and then");
		assert.ok(subject.length <= 72);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("refuses when there is nothing to promote, and on bad names", async () => {
	const f = await fixture();
	try {
		rmSync(path.join(f.info.root, "side.txt"));
		rmSync(path.join(f.info.root, "wip.txt"));
		await assert.rejects(planPromotion({ info: f.info, slug: "x", title: "x", hasGstuff: false, env: f.env }), /nothing to promote/);
		await assert.rejects(planPromotion({ info: f.info, slug: "Bad;name", title: "x", hasGstuff: false, env: f.env }), /invalid name/);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("request files carry only a validated slug and are consumed on read", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "btw-req-"));
	try {
		mkdirSync(path.join(root, ".git"));
		writeRequest(root, "fix-it");
		assert.deepEqual(readRequest(root), { slug: "fix-it" });
		assert.equal(existsSync(path.join(root, ".git", REQUEST_FILE)), false);
		writeFileSync(path.join(root, ".git", REQUEST_FILE), JSON.stringify({ slug: "../../etc", worktree: "/" }));
		assert.equal(readRequest(root), undefined);
		assert.equal(readRequest(root), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("appendMarker chains a new custom entry onto the session's last entry", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "btw-marker-"));
	try {
		const file = path.join(dir, "s.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", id: "h" })}\n${JSON.stringify({ type: "message", id: "aa", parentId: null })}\n`);
		appendMarker(file, { origin: "/o", root: "/r", createdAt: "t" });
		const last = JSON.parse(readFileSync(file, "utf8").trimEnd().split("\n").at(-1) ?? "{}");
		assert.equal(last.type, "custom");
		assert.equal(last.parentId, "aa");
		assert.deepEqual(last.data, { origin: "/o", root: "/r", createdAt: "t" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
