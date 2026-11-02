import { randomBytes, randomUUID } from "node:crypto";
import { ENTRY_TYPE, type BtwInfo } from "./guard.ts";

const SESSION_VERSION = 3;

interface EntryLike {
	type: string;
	id: string;
	parentId: string | null;
	message?: { role?: string };
}

export interface SideSessionInput {
	branch: readonly EntryLike[];
	cwd: string;
	parentSession: string | undefined;
	info: BtwInfo;
	name: string;
	now?: Date;
	sessionId?: string;
}

export interface SideSession {
	fileName: string;
	content: string;
	forked: boolean;
}

export function hasUserMessage(branch: readonly EntryLike[]): boolean {
	return branch.some((entry) => entry.type === "message" && entry.message?.role === "user");
}

function newEntryId(taken: Set<string>): string {
	let id: string;
	do id = randomBytes(4).toString("hex");
	while (taken.has(id));
	taken.add(id);
	return id;
}

// The branch is copied verbatim (ids, parents, compactions) because it is already a contiguous
// root-to-leaf chain; only our marker and the session name are appended after its leaf.
export function buildSideSession(input: SideSessionInput): SideSession {
	const now = input.now ?? new Date();
	const timestamp = now.toISOString();
	const sessionId = input.sessionId ?? randomUUID();
	const forked = hasUserMessage(input.branch);
	const entries: unknown[] = forked ? [...input.branch] : [];
	const taken = new Set(input.branch.map((entry) => entry.id));

	const header = {
		type: "session",
		version: SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd: input.cwd,
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
	};
	const marker = {
		type: "custom",
		id: newEntryId(taken),
		parentId: forked ? (input.branch.at(-1)?.id ?? null) : null,
		timestamp,
		customType: ENTRY_TYPE,
		data: input.info,
	};
	const sessionInfo = { type: "session_info", id: newEntryId(taken), parentId: marker.id, timestamp, name: input.name };

	const lines = [header, ...entries, marker, sessionInfo].map((entry) => JSON.stringify(entry));
	return {
		fileName: `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
		content: `${lines.join("\n")}\n`,
		forked,
	};
}

export function sessionName(question: string): string {
	const oneLine = question.replace(/\s+/g, " ").trim();
	if (!oneLine) return "btw";
	return `btw: ${oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine}`;
}
