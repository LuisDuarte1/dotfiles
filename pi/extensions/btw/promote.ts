import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, run, tryGit } from "./git.ts";
import { findFrame, stackExists, stacksDir, username } from "./gstuff.ts";
import { type BtwInfo, ENTRY_TYPE, type Promotion, SLUG } from "./guard.ts";
import { currentTree } from "./snapshot.ts";

export const REQUEST_FILE = "btw-promote.json";
const GSTUFF_SESSION_ENV = ["GSTUFF_SESSION", "GSTUFF_EPHEMERAL", "GSTUFF_FRAME", "GSTUFF_STACK", "GSTUFF_BRANCH"];

export type Registration =
	| { kind: "fork"; stack: string; frame: number; name: string; base: string }
	| { kind: "new"; name: string; base: string }
	| { kind: "branch"; branch: string; reason: string };

export interface PromotionPlan {
	info: BtwInfo;
	title: string;
	head: string;
	tree: string;
	worktree: string;
	user: string;
	fallbackBranch: string;
	registration: Registration;
	sideCommits: string[];
	changedInSession: number | undefined;
}

export interface PlanInput {
	info: BtwInfo;
	slug: string;
	title: string;
	hasGstuff: boolean;
	env?: NodeJS.ProcessEnv;
}

const exists = (dir: string) => (ref: string) => tryGit(["-C", dir, "show-ref", "--verify", "-q", ref]).then((r) => r !== undefined);

async function unique(base: string, taken: (candidate: string) => Promise<boolean> | boolean): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? base : `${base}-${n}`;
		if (!(await taken(candidate))) return candidate;
	}
}

async function snapshotBase(info: BtwInfo): Promise<{ head: string; branch: string | undefined }> {
	if (info.head) return { head: info.head, branch: info.branch };
	const branch = await tryGit(["-C", info.root, "symbolic-ref", "-q", "--short", "HEAD"]);
	const head = branch && (await tryGit(["-C", info.root, "rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`]));
	if (!head) throw new Error("this btw session predates promotion support and its fork point can't be recovered");
	return { head, branch };
}

async function isAncestor(repo: string, ancestor: string, ref: string): Promise<boolean> {
	return (await tryGit(["-C", repo, "merge-base", "--is-ancestor", ancestor, ref])) !== undefined;
}

// Joining the main agent's stack would move gstuff's shared pointer and let its cascades rewrite
// our branch, so a stack frame gets a separate stack based on that frame instead ("fork").
async function register(
	plan: Omit<PromotionPlan, "registration">,
	branch: string | undefined,
	slug: string,
	hasGstuff: boolean,
	env: NodeJS.ProcessEnv,
): Promise<Registration> {
	const { origin } = plan.info;
	const plainBranch = (reason: string): Registration => ({ kind: "branch", branch: plan.fallbackBranch, reason });
	if (!hasGstuff) return plainBranch("gstuff is not installed");
	if (!branch) return plainBranch(`${origin} was on a detached HEAD`);
	if (!(await isAncestor(origin, plan.head, branch))) return plainBranch(`${branch} was rewritten since the fork`);

	const commonDir = await git(["-C", origin, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const dir = stacksDir(realpathSync(path.dirname(commonDir)), env);
	const taken = async (name: string) => stackExists(dir, name) || (await exists(origin)(`refs/heads/${plan.user}/${name}/01`));
	const frame = findFrame(dir, branch);
	if (frame) {
		return { kind: "fork", ...frame, name: await unique(`${frame.stack}-${slug}`, taken), base: branch };
	}
	const upstream = await tryGit(["-C", origin, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
	const upstreamTip = upstream && (await tryGit(["-C", origin, "rev-parse", upstream]));
	return { kind: "new", name: await unique(slug, taken), base: upstreamTip === plan.head ? upstream! : branch };
}

export async function planPromotion(input: PlanInput): Promise<PromotionPlan> {
	const { info, slug } = input;
	const env = input.env ?? process.env;
	if (!SLUG.test(slug)) throw new Error(`invalid name "${slug}": use lowercase letters, digits and dashes`);
	if (!existsSync(path.join(info.root, ".git"))) throw new Error(`the btw copy ${info.root} no longer exists`);
	const { head, branch } = await snapshotBase(info);
	const tree = await currentTree(info.root);
	if (tree === (await git(["-C", info.root, "rev-parse", `${head}^{tree}`]))) {
		throw new Error(`nothing to promote: the copy is identical to ${info.origin}'s HEAD`);
	}
	const changed = info.work ? await git(["-C", info.root, "diff", "--name-only", info.work, tree]) : undefined;
	const log = await tryGit(["-C", info.root, "log", "--format=%s", `${head}..HEAD`]);
	const user = username(env);
	if (!user) throw new Error("can't tell your username: set $USER or [user] name in gstuff's config.toml");
	const worktree = await unique(path.join(path.dirname(info.origin), `${path.basename(info.origin)}-${slug}`), existsSync);
	const fallbackBranch = await unique(`${user}/${slug}`, (name) => exists(info.origin)(`refs/heads/${name}`));
	const partial = {
		info,
		title: input.title,
		head,
		tree,
		worktree,
		user,
		fallbackBranch,
		sideCommits: log ? log.split("\n").reverse() : [],
		changedInSession: changed === undefined ? undefined : changed ? changed.split("\n").length : 0,
	};
	return { ...partial, registration: await register(partial, branch, slug, input.hasGstuff, env) };
}

export function describePlan(plan: PromotionPlan): string[] {
	const r = plan.registration;
	const target =
		r.kind === "fork"
			? `new gstuff stack "${r.name}", forked from stack "${r.stack}" frame ${r.frame} (base ${r.base})`
			: r.kind === "new"
				? `new gstuff stack "${r.name}" on ${r.base}`
				: `plain branch ${r.branch} (${r.reason})`;
	return [
		`worktree   ${plan.worktree}`,
		`registers  ${target}`,
		`carries    everything in ${plan.info.root}, including ${plan.info.origin}'s uncommitted changes at fork time`,
		...(plan.changedInSession !== undefined ? [`changed    ${plan.changedInSession} file(s) during the btw session`] : []),
		...(plan.sideCommits.length ? [`squashes   ${plan.sideCommits.length} commit(s) made in the copy`] : []),
		`then       pi continues there without the sandbox`,
	];
}

function commitMessage(plan: PromotionPlan): string[] {
	const text = plan.title.replace(/^btw:\s*/, "").replace(/\s+/g, " ").trim();
	const cut = text.length <= 72 ? text : text.slice(0, 72).replace(/\s+\S*$/, "");
	const subject = cut || "btw";
	const body = [
		`Promoted from a btw side session forked at ${plan.info.createdAt}; it includes the uncommitted changes ${plan.info.origin} had then.`,
	];
	if (plan.sideCommits.length) body.push(`Squashed from the side session:\n${plan.sideCommits.map((s) => `- ${s}`).join("\n")}`);
	return ["-m", subject, ...body.flatMap((paragraph) => ["-m", paragraph])];
}

export async function runPromotion(plan: PromotionPlan, env: NodeJS.ProcessEnv = process.env): Promise<Promotion> {
	const { origin, root } = plan.info;
	const commit = await git(["-C", root, "commit-tree", plan.tree, "-p", plan.head, ...commitMessage(plan)]);
	await git(["-C", root, "update-ref", "refs/btw/promote", commit]);
	const quiet = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];
	await git(["-C", origin, ...quiet, "fetch", "-q", "--no-tags", "--no-write-fetch-head", root, "refs/btw/promote"]);
	await git(["-C", origin, ...quiet, "worktree", "add", "-q", "--detach", plan.worktree, commit]);

	const r = plan.registration;
	const at = new Date().toISOString();
	let note: string | undefined;
	if (r.kind !== "branch") {
		const ahead = await git(["-C", plan.worktree, "rev-list", "--count", `${r.base}..${commit}`]);
		const gstuffEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !GSTUFF_SESSION_ENV.includes(key)));
		try {
			if (ahead !== "1") throw new Error(`expected 1 commit on top of ${r.base}, found ${ahead}`);
			await run("gstuff", ["new", r.name, r.base], { cwd: plan.worktree, env: gstuffEnv, timeout: 120_000 });
			const branch = await git(["-C", plan.worktree, "symbolic-ref", "--short", "HEAD"]);
			return { worktree: plan.worktree, branch, stack: r.name, base: r.base, at };
		} catch (error) {
			note = `gstuff new failed, so this is a plain branch: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	await git(["-C", plan.worktree, "switch", "-q", "-c", plan.fallbackBranch]);
	return { worktree: plan.worktree, branch: plan.fallbackBranch, at, ...(note ? { note } : {}) };
}

export function appendMarker(sessionFile: string, data: BtwInfo): void {
	const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
	const ids = new Set(lines.map((line) => (JSON.parse(line) as { id?: string }).id));
	let id: string;
	do id = randomBytes(4).toString("hex");
	while (ids.has(id));
	const last = JSON.parse(lines.at(-1) ?? "{}") as { type?: string; id?: string };
	const entry = {
		type: "custom",
		id,
		parentId: last.type === "session" ? null : (last.id ?? null),
		timestamp: new Date().toISOString(),
		customType: ENTRY_TYPE,
		data,
	};
	appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

export function writeRequest(root: string, slug: string): void {
	writeFileSync(path.join(root, ".git", REQUEST_FILE), JSON.stringify({ slug }), { mode: 0o600 });
}

// The sandboxed agent can write this file too, so only the slug is read from it and the pane
// runner still demands a keypress on the terminal before acting on it.
export function readRequest(root: string): { slug: string } | undefined {
	const file = path.join(root, ".git", REQUEST_FILE);
	if (!existsSync(file)) return undefined;
	try {
		const { slug } = JSON.parse(readFileSync(file, "utf8")) as { slug?: unknown };
		return typeof slug === "string" && SLUG.test(slug) ? { slug } : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(file, { force: true });
	}
}
