import type { WebSearchBackend } from "./payload.ts";

export interface WebSearchSource {
	title?: string;
	url: string;
	pageAge?: string;
}

export interface WebSearchActivity {
	id: string;
	provider: WebSearchBackend;
	action: "find_in_page" | "open_page" | "search";
	query?: string;
	queries?: string[];
	url?: string;
	pattern?: string;
	sources?: WebSearchSource[];
	error?: string;
}

interface AnthropicCall {
	id: string;
	input: Record<string, unknown>;
	partialJson: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((item): item is string => typeof item === "string");
	return values.length > 0 ? values : undefined;
}

function readAnthropicInput(call: AnthropicCall): Record<string, unknown> {
	if (!call.partialJson) return call.input;
	try {
		const parsed = JSON.parse(call.partialJson);
		return isRecord(parsed) ? parsed : call.input;
	} catch {
		return call.input;
	}
}

function readAnthropicResult(content: unknown): Pick<WebSearchActivity, "error" | "sources"> {
	if (Array.isArray(content)) {
		const sources = content.flatMap((item): WebSearchSource[] => {
			if (!isRecord(item) || typeof item.url !== "string") return [];
			return [
				{
					url: item.url,
					...(typeof item.title === "string" ? { title: item.title } : {}),
					...(typeof item.page_age === "string" ? { pageAge: item.page_age } : {}),
				},
			];
		});
		return sources.length > 0 ? { sources } : {};
	}

	if (isRecord(content) && typeof content.error_code === "string") {
		return { error: content.error_code };
	}

	return {};
}

export class WebSearchActivityParser {
	private readonly anthropicBlocks = new Map<number, AnthropicCall>();
	private readonly anthropicCalls = new Map<string, AnthropicCall>();
	private readonly backend: WebSearchBackend;

	constructor(backend: WebSearchBackend) {
		this.backend = backend;
	}

	push(event: unknown): WebSearchActivity[] {
		if (!isRecord(event)) return [];
		return this.backend === "openai" ? this.pushOpenAi(event) : this.pushAnthropic(event);
	}

	private pushOpenAi(event: Record<string, unknown>): WebSearchActivity[] {
		if (event.type !== "response.output_item.done" || !isRecord(event.item)) return [];
		const item = event.item;
		if (item.type !== "web_search_call" || !isRecord(item.action)) return [];
		const action = item.action;
		const id = typeof item.id === "string" ? item.id : "web_search";

		if (action.type === "open_page") {
			return [
				{
					id,
					provider: "openai",
					action: "open_page",
					...(typeof action.url === "string" ? { url: action.url } : {}),
				},
			];
		}

		if (action.type === "find_in_page") {
			return [
				{
					id,
					provider: "openai",
					action: "find_in_page",
					...(typeof action.url === "string" ? { url: action.url } : {}),
					...(typeof action.pattern === "string" ? { pattern: action.pattern } : {}),
				},
			];
		}

		if (action.type !== "search") return [];
		const queries = strings(action.queries);
		return [
			{
				id,
				provider: "openai",
				action: "search",
				...(typeof action.query === "string" ? { query: action.query } : {}),
				...(queries ? { queries } : {}),
			},
		];
	}

	private pushAnthropic(event: Record<string, unknown>): WebSearchActivity[] {
		if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
			const block = event.content_block;
			if (block.type === "server_tool_use" && block.name === "web_search" && typeof block.id === "string") {
				this.anthropicBlocks.set(event.index, {
					id: block.id,
					input: isRecord(block.input) ? block.input : {},
					partialJson: "",
				});
				return [];
			}

			if (block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
				const call = this.anthropicCalls.get(block.tool_use_id);
				if (!call) return [];
				this.anthropicCalls.delete(block.tool_use_id);
				return [this.anthropicActivity(call, readAnthropicResult(block.content))];
			}
		}

		if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
			const call = this.anthropicBlocks.get(event.index);
			if (call && event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
				call.partialJson += event.delta.partial_json;
			}
			return [];
		}

		if (event.type === "content_block_stop" && typeof event.index === "number") {
			const call = this.anthropicBlocks.get(event.index);
			if (!call) return [];
			this.anthropicBlocks.delete(event.index);
			this.anthropicCalls.set(call.id, call);
			return [];
		}

		if (event.type === "message_stop" && this.anthropicCalls.size > 0) {
			const activities = [...this.anthropicCalls.values()].map((call) => this.anthropicActivity(call));
			this.anthropicCalls.clear();
			return activities;
		}

		return [];
	}

	private anthropicActivity(
		call: AnthropicCall,
		result: Pick<WebSearchActivity, "error" | "sources"> = {},
	): WebSearchActivity {
		const input = readAnthropicInput(call);
		return {
			id: call.id,
			provider: "anthropic",
			action: "search",
			...(typeof input.query === "string" ? { query: input.query } : {}),
			...result,
		};
	}
}
