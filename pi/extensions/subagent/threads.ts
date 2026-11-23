import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}$/;

export interface ThreadDetails {
	name: string;
	agent?: string;
	prompt: number;
	after?: string;
}

export interface ThreadRef {
	sessionFile: string;
	agent?: string;
	model?: string;
	prompts: number;
}

type BranchEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

// The parent branch is the thread index: forks and clones of the parent copy it, and
// /tree back to before a name existed forgets it, exactly like the parent's own context.
export function findThread(branch: readonly BranchEntry[], name: string): ThreadRef | undefined {
	let found: ThreadRef | undefined;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") continue;
		const details = entry.message.details as { thread?: ThreadDetails; sessionFile?: string; model?: string } | undefined;
		if (details?.thread?.name !== name || !details.sessionFile) continue;
		found = { sessionFile: details.sessionFile, agent: details.thread.agent, model: details.model, prompts: details.thread.prompt };
	}
	return found;
}

export function threadFooter(thread: ThreadDetails, expired: boolean): string {
	if (expired) return `[subagent "${thread.name}" · its earlier session is gone, so this started a new one]`;
	if (thread.prompt === 1) return `[subagent "${thread.name}" · new]`;
	return `[subagent "${thread.name}" · continued, prompt ${thread.prompt}]`;
}
