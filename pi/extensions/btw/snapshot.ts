import { randomBytes } from "node:crypto";
import { copyFile, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { git, tryGit } from "./git.ts";
import { isInside } from "./guard.ts";

export const SNAPSHOT_BASE = "/tmp/pi-btw";

export interface Snapshot {
	id: string;
	origin: string;
	root: string;
	cwd: string;
	head: string;
	branch: string | undefined;
	work: string;
	protect: string[];
}

export async function currentTree(root: string): Promise<string> {
	const index = path.join(root, ".git", `btw-tree-index-${process.pid}`);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	try {
		await copyFile(path.join(root, ".git", "index"), index).catch(() => undefined);
		await git(["-C", root, "add", "-A"], env);
		return await git(["-C", root, "write-tree"], env);
	} finally {
		await rm(index, { force: true });
	}
}

// Every write goes to the clone (objects, temp index, checkout) and git reads origin only
// through --work-tree and alternates, so the busy checkout is never touched, not even .git.
export async function createSnapshot(
	cwd: string,
	options: { base?: string; refuseInside?: string[] } = {},
): Promise<Snapshot> {
	const base = options.base ?? SNAPSHOT_BASE;
	const top = await tryGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (!top) throw new Error(`not inside a git repository: ${cwd}`);
	const origin = await realpath(top);
	for (const dir of [base, ...(options.refuseInside ?? [])]) {
		if (isInside(dir, origin)) throw new Error(`${origin} contains ${dir}; mounting it read-only would break pi`);
	}

	const head = await tryGit(["-C", origin, "rev-parse", "--verify", "-q", "HEAD"]);
	if (!head) throw new Error(`${origin} has no commits yet`);
	const branch = await tryGit(["-C", origin, "symbolic-ref", "-q", "--short", "HEAD"]);
	const gitDir = await realpath(await git(["-C", origin, "rev-parse", "--absolute-git-dir"]));
	const commonDir = await realpath(
		await git(["-C", origin, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
	);
	const originIndex = await git(["-C", origin, "rev-parse", "--path-format=absolute", "--git-path", "index"]);

	await mkdir(base, { recursive: true });
	const id = randomBytes(4).toString("hex");
	const root = path.join(base, `${path.basename(origin)}-${id}`);
	await git(["clone", "-q", "--shared", "--no-checkout", origin, root]);

	const index = path.join(root, ".git", "btw-snapshot-index");
	const env = { ...process.env, GIT_INDEX_FILE: index };
	const against = [`--git-dir=${path.join(root, ".git")}`, `--work-tree=${origin}`];
	const copied = await copyFile(originIndex, index).then(
		() => true,
		() => false,
	);
	let staged = copied ? await tryGit([...against, "write-tree"], env) : undefined;
	if (!staged) {
		await git([...against, "read-tree", head], env);
		staged = await git(["-C", root, "rev-parse", `${head}^{tree}`]);
	}
	await git([...against, "add", "-A"], env);
	const work = await git([...against, "write-tree"], env);

	if (branch) {
		await git(["-C", root, "update-ref", `refs/heads/${branch}`, head]);
		await git(["-C", root, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
	} else {
		await git(["-C", root, "update-ref", "--no-deref", "HEAD", head]);
	}
	await git(["-C", root, "read-tree", "-u", "--reset", work]);
	await git(["-C", root, "read-tree", staged]);
	await tryGit(["-C", root, "update-index", "-q", "--refresh"]);
	await rm(index, { force: true });

	const protect = [origin, ...new Set([gitDir, commonDir])].filter(
		(dir, i) => i === 0 || !isInside(dir, origin),
	);
	const rel = path.relative(origin, await realpath(cwd));
	return { id, origin, root, cwd: path.join(root, rel), head, branch, work, protect };
}
