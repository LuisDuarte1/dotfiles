export const WEB_SEARCH_TOOL_NAME = "web_search";

export type WebSearchBackend = "anthropic" | "openai";

export interface WebSearchModel {
	provider: string;
	api: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getWebSearchBackend(model: WebSearchModel | undefined): WebSearchBackend | undefined {
	if (model?.api === "anthropic-messages") return "anthropic";
	if (model?.api === "openai-responses") return "openai";
	return undefined;
}

function rewriteTool(tool: unknown, backend: WebSearchBackend): unknown {
	if (!isRecord(tool) || tool.name !== WEB_SEARCH_TOOL_NAME) return tool;

	if (backend === "anthropic" && Object.hasOwn(tool, "input_schema") && !Object.hasOwn(tool, "type")) {
		return { type: "web_search_20250305", name: WEB_SEARCH_TOOL_NAME };
	}

	if (backend === "openai" && tool.type === "function") {
		return { type: "web_search" };
	}

	return tool;
}

export function rewriteWebSearchPayload(payload: unknown, backend: WebSearchBackend): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;

	let changed = false;
	const tools = payload.tools.map((tool) => {
		const rewritten = rewriteTool(tool, backend);
		if (rewritten !== tool) changed = true;
		return rewritten;
	});

	return changed ? { ...payload, tools } : payload;
}
