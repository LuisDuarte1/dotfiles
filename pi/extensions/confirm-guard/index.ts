import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findGuarded, type Hit, type Push } from "./detect.ts";
import { ALL_BRANCHES, approvalQuery, approvedUrl, isProtected, isRemoteUrl, parseRemote, pushTargets } from "./push.ts";

const PUSH_PROTECTED = "git push to main/master";
const PUSH_APPROVED = "git push to an approved MR/PR";
const LOOKUP_TIMEOUT_MS = 5000;
const ALLOW_ONCE = "Allow once";
const DENY = "Deny";
const DECLINED = "The user declined. Do not retry or work around it.";

interface Confirm {
	label: string;
	command: string;
	detail?: string;
}

function oneLine(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function title(confirms: Confirm[]): string {
	const lines = confirms.map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}\n  ${oneLine(c.command)}`);
	return `confirm-guard: this changes shared state\n\n${[...new Set(lines)].join("\n")}`;
}

// Agents deployed, merged and transferred repos on their own initiative, so these commands wait
// for the user; a push asks only where it can break main or reset approvals someone already gave.
export default function confirmGuard(pi: ExtensionAPI) {
	const allowed = new Set<string>();

	const run = async (ctx: ExtensionContext, command: string, args: string[], cwd: string) => {
		try {
			const result = await pi.exec(command, args, { cwd, timeout: LOOKUP_TIMEOUT_MS, signal: ctx.signal });
			return result.code === 0 ? result.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	};

	const approval = async (ctx: ExtensionContext, url: string, branch: string, cwd: string) => {
		const remote = parseRemote(url);
		if (!remote) return undefined;
		const query = approvalQuery(remote, branch);
		const stdout = await run(ctx, query.command, query.args, cwd);
		try {
			return stdout ? approvedUrl(query.command, stdout) : undefined;
		} catch {
			return undefined;
		}
	};

	const checkPush = async (ctx: ExtensionContext, push: Push): Promise<Omit<Confirm, "command"> | undefined> => {
		const cwd = resolve(ctx.cwd, push.cwd?.replace(/^~(?=\/|$)/, homedir()) ?? ".");
		const current = await run(ctx, "git", ["symbolic-ref", "--short", "-q", "HEAD"], cwd);
		const targets = pushTargets(push, current);
		const protectedTarget = targets.find(isProtected);
		if (protectedTarget) {
			return { label: PUSH_PROTECTED, detail: protectedTarget === ALL_BRANCHES ? "every branch" : protectedTarget };
		}
		if (targets.length === 0 || allowed.has(PUSH_APPROVED)) return undefined;
		const pushRemote = async () =>
			current && (await run(ctx, "git", ["for-each-ref", "--format=%(push:remotename)", `refs/heads/${current}`], cwd));
		const name = push.remote ?? ((await pushRemote()) || "origin");
		const url = isRemoteUrl(name) ? name : await run(ctx, "git", ["remote", "get-url", "--push", name], cwd);
		if (!url) return undefined;
		const approved = (await Promise.all(targets.map((branch) => approval(ctx, url, branch, cwd)))).find(Boolean);
		return approved ? { label: PUSH_APPROVED, detail: approved } : undefined;
	};

	const resolveHits = async (ctx: ExtensionContext, hits: Hit[]): Promise<Confirm[]> => {
		const confirms: Confirm[] = [];
		for (const hit of hits) {
			const found = hit.push ? await checkPush(ctx, hit.push) : { label: hit.label };
			if (found && !allowed.has(found.label)) confirms.push({ ...found, command: hit.command });
		}
		return confirms;
	};

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "bg_do") return undefined;
		const input = event.input as { command?: unknown; code?: unknown };
		let confirms: Confirm[];
		try {
			const text = String((event.toolName === "bash" ? input.command : input.code) ?? "");
			confirms = await resolveHits(ctx, findGuarded(text, event.toolName));
		} catch {
			return undefined;
		}
		if (confirms.length === 0) return undefined;

		const labels = [...new Set(confirms.map((c) => c.label))];
		if (!ctx.hasUI) {
			const reason = `${labels.join(", ")} changes shared state and needs the user's confirmation, but this session cannot ask.`;
			return { block: true, reason: `${reason} Do not retry or work around it.` };
		}
		const forSession = `Allow ${labels.join(", ")} for this session`;
		const choice = await ctx.ui.select(title(confirms), [ALLOW_ONCE, forSession, DENY], { signal: ctx.signal });
		if (choice === forSession) for (const label of labels) allowed.add(label);
		if (choice === ALLOW_ONCE || choice === forSession) return undefined;
		return { block: true, reason: DECLINED };
	});
}
