import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type RunStatus = "running" | "done" | "error" | "aborted" | "stopped";

interface ItemBase {
	rev: number;
}
export interface TextItem extends ItemBase {
	kind: "text" | "thinking";
	text: string;
}
export interface ToolItem extends ItemBase {
	kind: "tool";
	id: string;
	name: string;
	args: string;
	output: string;
	state: "pending" | "running" | "done" | "error";
}
export interface UserItem extends ItemBase {
	kind: "user";
	text: string;
}
export interface NoteItem extends ItemBase {
	kind: "note";
	text: string;
	level: "info" | "warning" | "error";
}
export type TranscriptItem = TextItem | ToolItem | UserItem | NoteItem;

export interface RunState {
	id: number;
	agent?: string;
	model?: string;
	task: string;
	context?: string;
	startedAt: number;
	endedAt?: number;
	status: RunStatus;
	turns: number;
	usage: Usage;
	activity: string;
	transcript: TranscriptItem[];
	pending: string[];
	steers: string[];
	lastAssistant?: AssistantMessage;
	sessionFile?: string;
	stderr: string;
	sawPrompt: boolean;
	blocks?: Map<number, TranscriptItem>;
}

const MAX_ITEMS = 400;
const MAX_TEXT = 20_000;
const MAX_TOOL_OUTPUT = 4_000;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(total: Usage, usage: Usage | undefined): void {
	if (!usage) return;
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

export function createRun(init: { id: number; task: string; agent?: string; model?: string; context?: string }): RunState {
	return {
		...init,
		startedAt: Date.now(),
		status: "running",
		turns: 0,
		usage: emptyUsage(),
		activity: "starting",
		transcript: [],
		pending: [],
		steers: [],
		stderr: "",
		sawPrompt: false,
	};
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const clipTail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

export function summarizeArgs(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : undefined);
	let summary: string | undefined;
	switch (name) {
		case "bash":
			summary = str("command");
			break;
		case "read":
		case "write":
		case "edit":
			summary = str("path") ?? str("file_path");
			break;
		case "grep":
			summary = [str("pattern"), str("path")].filter(Boolean).join(" in ");
			break;
		case "find":
		case "ls":
			summary = str("pattern") ?? str("path");
			break;
		case "subagent":
			summary = str("task");
			break;
		case "web_search":
			summary = str("query");
			break;
	}
	return oneLine(summary ?? JSON.stringify(a), 160);
}

export function lastText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	for (let i = message.content.length - 1; i >= 0; i--) {
		const part = message.content[i];
		if (part.type === "text" && part.text.trim()) return part.text;
	}
	return "";
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function push<T extends TranscriptItem>(run: RunState, item: T): T {
	run.transcript.push(item);
	if (run.transcript.length > MAX_ITEMS) run.transcript.splice(0, run.transcript.length - MAX_ITEMS);
	return item;
}

function findTool(run: RunState, id: string): ToolItem | undefined {
	for (let i = run.transcript.length - 1; i >= 0; i--) {
		const item = run.transcript[i];
		if (item.kind === "tool" && item.id === id) return item;
	}
	return undefined;
}

function toolFor(run: RunState, id: string, name: string, args: unknown): ToolItem {
	return (
		findTool(run, id) ??
		push(run, { kind: "tool", id, name, args: summarizeArgs(name, args), output: "", state: "pending", rev: 0 })
	);
}

function toolResultText(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
	return Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
}

function itemsFromMessage(run: RunState, message: AssistantMessage): void {
	for (const part of message.content) {
		if (part.type === "text" && part.text.trim()) push(run, { kind: "text", text: part.text, rev: 0 });
		else if (part.type === "thinking" && part.thinking.trim()) push(run, { kind: "thinking", text: part.thinking, rev: 0 });
		else if (part.type === "toolCall") toolFor(run, part.id, part.name, part.arguments);
	}
}

// Mutates `run` in place: the inspector and tool row re-read it on every render, so
// copying a transcript of hundreds of items per streamed delta would be wasted work.
export function applyEvent(run: RunState, event: JsonAgentSessionEvent): RunState {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") {
				run.blocks = new Map();
				run.activity = "waiting for model";
			}
			break;
		case "message_update": {
			const e = event.assistantMessageEvent;
			const blocks = (run.blocks ??= new Map());
			if (e.type === "text_start" || e.type === "thinking_start") {
				const kind = e.type === "text_start" ? "text" : "thinking";
				blocks.set(e.contentIndex, push(run, { kind, text: "", rev: 0 }));
				run.activity = kind === "text" ? "writing" : "thinking";
			} else if (e.type === "text_delta" || e.type === "thinking_delta") {
				const item = blocks.get(e.contentIndex);
				if (item && (item.kind === "text" || item.kind === "thinking")) {
					item.text = clipTail(item.text + e.delta, MAX_TEXT);
					item.rev++;
				}
			} else if (e.type === "text_end" || e.type === "thinking_end") {
				const item = blocks.get(e.contentIndex);
				if (item && (item.kind === "text" || item.kind === "thinking")) {
					item.text = clipTail(e.content, MAX_TEXT);
					item.rev++;
				}
			} else if (e.type === "toolcall_start") {
				blocks.set(e.contentIndex, toolFor(run, e.id, e.toolName, {}));
				run.activity = `calling ${e.toolName}`;
			} else if (e.type === "toolcall_end") {
				const item = toolFor(run, e.toolCall.id, e.toolCall.name, e.toolCall.arguments);
				item.args = summarizeArgs(e.toolCall.name, e.toolCall.arguments);
				item.rev++;
			}
			break;
		}
		case "message_end": {
			const message = event.message as Message;
			if (message.role === "assistant") {
				if (!run.blocks || run.blocks.size === 0) itemsFromMessage(run, message);
				run.blocks = undefined;
				run.lastAssistant = message;
				addUsage(run.usage, message.usage);
				if (message.stopReason === "error") {
					push(run, { kind: "note", level: "error", text: message.errorMessage ?? "model error", rev: 0 });
				} else if (message.stopReason === "aborted") {
					push(run, { kind: "note", level: "warning", text: "aborted", rev: 0 });
				}
			} else if (message.role === "user") {
				if (!run.sawPrompt) {
					run.sawPrompt = true;
				} else {
					const text = messageText(message);
					run.steers.push(text);
					push(run, { kind: "user", text, rev: 0 });
				}
			} else if (message.role === "toolResult") {
				const item = toolFor(run, message.toolCallId, message.toolName, {});
				item.output = clipTail(messageText(message), MAX_TOOL_OUTPUT);
				item.state = message.isError ? "error" : "done";
				item.rev++;
			}
			break;
		}
		case "tool_execution_start": {
			const item = toolFor(run, event.toolCallId, event.toolName, event.args);
			item.state = "running";
			item.rev++;
			run.activity = `${event.toolName}: ${summarizeArgs(event.toolName, event.args)}`;
			break;
		}
		case "tool_execution_update": {
			const item = toolFor(run, event.toolCallId, event.toolName, event.args);
			item.output = clipTail(toolResultText(event.partialResult), MAX_TOOL_OUTPUT);
			item.rev++;
			break;
		}
		case "tool_execution_end": {
			const item = toolFor(run, event.toolCallId, event.toolName, {});
			item.output = clipTail(toolResultText(event.result), MAX_TOOL_OUTPUT);
			item.state = event.isError ? "error" : "done";
			item.rev++;
			run.activity = "waiting for model";
			break;
		}
		case "turn_end":
			if ((event.message as Partial<AssistantMessage>).stopReason !== "aborted") run.turns++;
			break;
		case "queue_update":
			run.pending = [...event.steering, ...event.followUp];
			break;
		case "auto_retry_start":
			push(run, {
				kind: "note",
				level: "warning",
				text: `retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
				rev: 0,
			});
			break;
		case "compaction_start":
			push(run, { kind: "note", level: "info", text: `compacting context (${event.reason})`, rev: 0 });
			break;
		case "compaction_end":
			if (event.errorMessage) push(run, { kind: "note", level: "error", text: event.errorMessage, rev: 0 });
			break;
		case "agent_settled":
			run.activity = "settled";
			break;
	}
	return run;
}

export function addNote(run: RunState, level: NoteItem["level"], text: string): void {
	push(run, { kind: "note", level, text, rev: 0 });
}

// Rebuilds a finished run from its session file, so runs from before a restart
// can still be inspected with the same transcript view as live ones.
export function replaySession(run: RunState, jsonl: string): RunState {
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: Message; summary?: string };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "compaction") {
			addNote(run, "info", "context compacted");
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "assistant") {
			applyEvent(run, { type: "message_start", message });
			applyEvent(run, { type: "message_end", message });
			run.turns++;
		} else if (message.role === "user" || message.role === "toolResult") {
			applyEvent(run, { type: "message_end", message });
		}
	}
	run.activity = "";
	return run;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(n: number): string {
	return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function shortModel(model: string | undefined): string | undefined {
	return model?.slice(model.lastIndexOf("/") + 1);
}

export function runStats(run: RunState, now = Date.now()): string {
	const parts = [
		shortModel(run.model),
		formatDuration((run.endedAt ?? now) - run.startedAt),
		`${run.turns} turn${run.turns === 1 ? "" : "s"}`,
		`${formatTokens(run.usage.totalTokens)} tok`,
		run.usage.cost.total > 0 ? formatCost(run.usage.cost.total) : undefined,
	];
	return parts.filter(Boolean).join(" · ");
}

// The parent model only sees this text, so it must learn about user steering or a
// user stop here; otherwise it may "fix" a deliberate change of direction.
export function resultText(run: RunState): string {
	const output = lastText(run.lastAssistant);
	let text: string;
	if (run.status === "done") {
		text = output || "(no output)";
	} else if (run.status === "stopped") {
		const turns = `${run.turns} turn${run.turns === 1 ? "" : "s"}`;
		text = `Stopped by the user after ${turns}.${output ? ` Partial output:\n\n${output}` : " No output yet."}`;
	} else {
		text = `Subagent ${run.status}: ${run.lastAssistant?.errorMessage || run.stderr.trim() || output || "no output"}`;
	}
	if (run.steers.length === 0) return text;
	const steers = run.steers.map((steer) => `- ${oneLine(steer, 500)}`).join("\n");
	return `${text}\n\n---\nThe user sent this subagent extra instructions while it ran:\n${steers}`;
}
