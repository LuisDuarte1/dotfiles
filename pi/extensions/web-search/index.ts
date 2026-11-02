import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WebSearchActivity } from "./activity.ts";
import {
	getWebSearchBackend,
	rewriteWebSearchPayload,
	WEB_SEARCH_TOOL_NAME,
	type WebSearchModel,
} from "./payload.ts";
import {
	isRawContentRecord,
	restoreRawAssistantContent,
	type RawContentRecord,
} from "./raw-content.ts";
import { installWebSearchStreamObserver } from "./stream.ts";

const WEB_SEARCH_ENTRY_TYPE = "web-search-activity";
const WEB_SEARCH_RAW_CONTENT_TYPE = "web-search-raw-content";

function activitySummary(activity: WebSearchActivity): string {
	if (activity.action === "open_page") return `open ${activity.url ?? "page"}`;
	if (activity.action === "find_in_page") {
		return `find ${activity.pattern ?? "text"}${activity.url ? ` in ${activity.url}` : ""}`;
	}
	return activity.query ?? activity.queries?.join(", ") ?? "search";
}

function syncWebSearchTool(pi: ExtensionAPI, model: WebSearchModel | undefined): void {
	const activeTools = pi.getActiveTools();
	const isActive = activeTools.includes(WEB_SEARCH_TOOL_NAME);
	const shouldBeActive = pi.getFlag("web-search") === true && getWebSearchBackend(model) !== undefined;

	if (isActive === shouldBeActive) return;

	pi.setActiveTools(
		shouldBeActive
			? [...activeTools, WEB_SEARCH_TOOL_NAME]
			: activeTools.filter((name) => name !== WEB_SEARCH_TOOL_NAME),
	);
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	let disposeStreamObserver: (() => void) | undefined;
	let acceptsActivities = false;
	const rawRecords = new Map<string, RawContentRecord>();

	const storeRawRecord = (record: RawContentRecord) => {
		for (const key of record.keys) rawRecords.set(key, record);
	};

	// Always loaded so old search sessions replay safely; searching itself stays opt-in
	// behind this flag because native search costs money and mutates provider payloads.
	pi.registerFlag("web-search", {
		description: "Enable provider-native web search for this run",
		type: "boolean",
		default: false,
	});

	// Raw content is replay bookkeeping, not conversation: keep it out of the transcript.
	// Registering a no-op renderer guarantees the entries stay invisible in the TUI.
	pi.registerEntryRenderer(WEB_SEARCH_RAW_CONTENT_TYPE, () => undefined);

	pi.registerEntryRenderer<WebSearchActivity>(WEB_SEARCH_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const activity: WebSearchActivity = entry.data ?? {
			id: "web_search",
			provider: "openai",
			action: "search",
		};
		const box = new Box(1, 0, (text) => theme.bg("toolSuccessBg", text));
		let text = `${theme.fg("toolTitle", theme.bold("🔎 web_search"))} ${theme.fg("muted", activitySummary(activity))}`;

		if (expanded) {
			const details = [`provider: ${activity.provider}`];
			for (const query of activity.queries ?? []) {
				if (query !== activity.query) details.push(`query: ${query}`);
			}
			for (const source of activity.sources ?? []) {
				details.push(`source: ${source.title ? `${source.title} — ` : ""}${source.url}`);
			}
			if (activity.error) details.push(`error: ${activity.error}`);
			text += `\n${theme.fg(activity.error ? "error" : "dim", details.join("\n"))}`;
		}

		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerTool({
		name: WEB_SEARCH_TOOL_NAME,
		label: "Web Search",
		description: "Search the web for current information using the selected model provider.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query." }),
		}),
		async execute() {
			throw new Error("web_search must be executed by the selected model provider");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		syncWebSearchTool(pi, ctx.model);
		acceptsActivities = true;
		rawRecords.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== WEB_SEARCH_RAW_CONTENT_TYPE) continue;
			if (isRawContentRecord(entry.data)) storeRawRecord(entry.data);
		}
		disposeStreamObserver?.();
		disposeStreamObserver = installWebSearchStreamObserver(
			(activity) => {
				if (acceptsActivities) pi.appendEntry(WEB_SEARCH_ENTRY_TYPE, activity);
			},
			(record) => {
				if (!acceptsActivities) return;
				storeRawRecord(record);
				pi.appendEntry(WEB_SEARCH_RAW_CONTENT_TYPE, record);
			},
		);
	});

	pi.on("model_select", (event) => {
		syncWebSearchTool(pi, event.model);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const backend = getWebSearchBackend(ctx.model);
		if (!backend) return;
		let payload = event.payload;
		if (backend === "anthropic") payload = restoreRawAssistantContent(payload, (key) => rawRecords.get(key));
		payload = rewriteWebSearchPayload(payload, backend);
		return payload === event.payload ? undefined : payload;
	});

	pi.on("session_shutdown", () => {
		acceptsActivities = false;
		disposeStreamObserver?.();
		disposeStreamObserver = undefined;
	});
}
