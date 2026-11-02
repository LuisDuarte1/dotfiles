// Anthropic validates the latest assistant message verbatim, but pi-ai drops server-side
// blocks (server_tool_use/web_search_tool_result), so we record raw content and replay it.

export interface RawContentRecord {
	keys: string[];
	content: Record<string, unknown>[];
}

const SERVER_BLOCK_TYPES = new Set(["server_tool_use", "web_search_tool_result"]);

interface PendingBlock {
	block: Record<string, unknown>;
	partialJson: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRawContentRecord(value: unknown): value is RawContentRecord {
	if (!isRecord(value) || !Array.isArray(value.keys) || !Array.isArray(value.content)) return false;
	return value.keys.every((key) => typeof key === "string") && value.content.every(isRecord);
}

// Keys must survive pi-ai's lossy round-trip, so only blocks pi re-serializes qualify:
// thinking signatures and client tool_use ids (text is a fallback for tool-less turns).
export function collectContentKeys(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const keys: string[] = [];
	let textKey: string | undefined;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) {
			keys.push(`sig:${block.signature}`);
		} else if (block.type === "tool_use" && typeof block.id === "string") {
			keys.push(`tool:${block.id}`);
		} else if (!textKey && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			textKey = `text:${block.text}`;
		}
	}
	if (textKey) keys.push(textKey);
	return keys;
}

export class AnthropicRawContentRecorder {
	private blocks = new Map<number, PendingBlock>();

	push(event: unknown): RawContentRecord | undefined {
		if (!isRecord(event)) return undefined;

		if (event.type === "message_start") {
			this.blocks.clear();
			return undefined;
		}

		if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
			this.blocks.set(event.index, { block: structuredClone(event.content_block), partialJson: "" });
			return undefined;
		}

		if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
			const pending = this.blocks.get(event.index);
			if (pending) applyDelta(pending, event.delta);
			return undefined;
		}

		if (event.type === "message_stop") return this.finish();
		return undefined;
	}

	private finish(): RawContentRecord | undefined {
		const entries = [...this.blocks.entries()].sort(([a], [b]) => a - b);
		this.blocks.clear();

		const content = entries.map(([, pending]) => {
			if (pending.partialJson) {
				try {
					pending.block.input = JSON.parse(pending.partialJson);
				} catch {
					// keep the input from content_block_start
				}
			}
			return pending.block;
		});

		if (!content.some((block) => SERVER_BLOCK_TYPES.has(String(block.type)))) return undefined;
		const keys = collectContentKeys(content);
		return keys.length > 0 ? { keys, content } : undefined;
	}
}

function applyDelta(pending: PendingBlock, delta: Record<string, unknown>): void {
	const block = pending.block;
	if (delta.type === "text_delta" && typeof delta.text === "string") {
		block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
	} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
		block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
	} else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
		block.signature = `${typeof block.signature === "string" ? block.signature : ""}${delta.signature}`;
	} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
		pending.partialJson += delta.partial_json;
	} else if (delta.type === "citations_delta" && isRecord(delta.citation)) {
		const citations = Array.isArray(block.citations) ? block.citations : [];
		citations.push(delta.citation);
		block.citations = citations;
	}
}

export function restoreRawAssistantContent(
	payload: unknown,
	lookup: (key: string) => RawContentRecord | undefined,
): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;

	let changed = false;
	const messages = payload.messages.map((message) => {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
		let record: RawContentRecord | undefined;
		for (const key of collectContentKeys(message.content)) {
			record = lookup(key);
			if (record) break;
		}
		if (!record) return message;
		changed = true;
		return { ...message, content: structuredClone(record.content) };
	});

	return changed ? { ...payload, messages } : payload;
}
