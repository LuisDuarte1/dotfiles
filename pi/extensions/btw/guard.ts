import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENTRY_TYPE = "pi-btw";
export const ENV = {
	sandbox: "PI_BTW_SANDBOX",
	origin: "PI_BTW_ORIGIN",
	root: "PI_BTW_ROOT",
	createdAt: "PI_BTW_CREATED_AT",
	promotable: "PI_BTW_PROMOTABLE",
	openSocket: "PI_BTW_OPEN_SOCKET",
	node: "PI_BTW_NODE",
} as const;

export interface Promotion {
	worktree: string;
	branch: string;
	stack?: string;
	base?: string;
	at: string;
	note?: string;
}

export interface BtwInfo {
	origin: string;
	root: string;
	createdAt: string;
	parentSession?: string;
	head?: string;
	branch?: string;
	work?: string;
	promoted?: Promotion;
}

export type Mode =
	| { kind: "off" }
	| { kind: "sandboxed"; info: BtwInfo }
	| { kind: "unsandboxed"; info: BtwInfo }
	| { kind: "promoted"; info: BtwInfo & { promoted: Promotion } };

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "codemode"]);

export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// The env marks a process that really runs inside bwrap; the session entry alone only says the
// session was a btw fork, which is how a hand-opened or post-reboot resume is told apart.
export function resolveMode(env: NodeJS.ProcessEnv, entries: readonly EntryLike[]): Mode {
	const entry = entries.findLast((e) => e.type === "custom" && e.customType === ENTRY_TYPE)?.data as
		| BtwInfo
		| undefined;
	const origin = env[ENV.origin];
	const root = env[ENV.root];
	if (env[ENV.sandbox] === "1" && origin && root) {
		const createdAt = env[ENV.createdAt] ?? entry?.createdAt ?? "";
		return { kind: "sandboxed", info: { ...entry, origin, root, createdAt, promoted: undefined } };
	}
	if (entry?.promoted) return { kind: "promoted", info: { ...entry, promoted: entry.promoted } };
	if (entry) return { kind: "unsandboxed", info: entry };
	return { kind: "off" };
}

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/^btw:\s*/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "btw";
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function resolveRealPath(target: string, cwd: string, home = os.homedir()): string {
	const expanded = target === "~" ? home : target.startsWith("~/") ? path.join(home, target.slice(2)) : target;
	let current = path.resolve(cwd, expanded);
	const rest: string[] = [];
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		rest.unshift(path.basename(current));
		current = parent;
	}
	try {
		current = realpathSync(current);
	} catch {
		return path.join(current, ...rest); // unreadable ancestor; bwrap still enforces the mount
	}
	return path.join(current, ...rest);
}

export interface ToolCall {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	readOnlyHint?: boolean;
}

export function blockReason(mode: Mode, call: ToolCall): string | undefined {
	if (mode.kind === "off") return undefined;
	const { origin, root } = mode.info;
	if (mode.kind === "unsandboxed") {
		if (READ_ONLY_TOOLS.has(call.toolName) || call.readOnlyHint === true) return undefined;
		return (
			`${call.toolName} is disabled: this btw side session runs outside its sandbox, so ${origin} ` +
			"is not protected. Only read-only tools work here; start a new /btw from the main session to make changes."
		);
	}
	if (call.toolName !== "edit" && call.toolName !== "write") return undefined;
	if (typeof call.input.path !== "string") return undefined;
	const target = resolveRealPath(call.input.path, call.cwd);
	if (!isInside(target, origin)) return undefined;
	const mine = mode.kind === "promoted" ? mode.info.promoted.worktree : root;
	const copy = path.join(mine, path.relative(origin, target));
	return `${origin} is read-only: another agent is working there. Your copy of this file is ${copy}.`;
}

export function readOnlyHint(mode: Mode, texts: readonly string[]): string | undefined {
	if (mode.kind !== "sandboxed") return undefined;
	if (!texts.some((text) => text.includes("Read-only file system"))) return undefined;
	const { origin, root } = mode.info;
	return `[btw] ${origin} and its git metadata are mounted read-only because another agent is working there. Make changes in your copy, ${root}.`;
}

export function promptSection(mode: Mode): string | undefined {
	if (mode.kind === "off") return undefined;
	const { origin, root, createdAt } = mode.info;
	if (mode.kind === "promoted") {
		const { worktree, branch, stack, base } = mode.info.promoted;
		const where = stack ? `gstuff stack \`${stack}\` (branch ${branch}, base ${base})` : `branch ${branch}`;
		return [
			`This session started as a btw side session and was promoted into its own git worktree ${worktree}, on ${where}.`,
			`- You work normally in ${worktree} now; there is no sandbox. Use gstuff commit instead of git commit on stack branches.`,
			`- Another agent may still be working in ${origin}: never modify it. Paths under ${origin} or ${root} in earlier messages map to ${worktree}.`,
		].join("\n");
	}
	if (mode.kind === "unsandboxed") {
		return [
			"This was a btw side session, but it is now running outside its sandbox.",
			`Only read-only tools work. Another agent may be working in ${origin}; do not try to change anything there.`,
			"If the user wants changes, tell them to start a new /btw from the main session.",
		].join("\n");
	}
	const when = createdAt ? ` taken at ${createdAt}` : "";
	return [
		"This is a btw side session: a fork of another pi session, so the user can ask questions while another agent keeps working.",
		`- Another agent is actively changing ${origin}. It is mounted read-only for you; never try to modify it.`,
		`- Your working directory ${root} is a snapshot of ${origin}${when}: same git HEAD, same staged, unstaged and untracked changes.`,
		"- Ignored files (dependencies, build output, .env) and submodule contents are NOT in the snapshot; install or build in your copy if needed.",
		`- Paths under ${origin} in earlier messages refer to the same files under ${root}. Reading ${origin} shows the other agent's live, in-progress state.`,
		"- The desktop is out of reach, except that `open`/`xdg-open` of an http://127.0.0.1 or localhost URL opens it in the user's browser.",
		"- Answer the user's questions. Do not resume the earlier task unless asked.",
	].join("\n");
}
