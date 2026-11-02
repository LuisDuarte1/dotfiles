import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Fable-specific behavior: a red prompt box while a supported Fable model is
// active, plus prompt-cache timeout detection that warns before a cache miss.

const FABLE_MODEL_LABELS = new Map([
	["claude-fable-5", "Fable 5"],
	["claude-fable-5-1", "Fable 5.1"],
]);

function getFableLabel(modelId: string | undefined): string | undefined {
	return modelId ? FABLE_MODEL_LABELS.get(modelId) : undefined;
}

const FALLBACK_WIDGET_KEY = "fable-fallback-used";

// Anthropic's prompt cache has a 5 minute TTL. After this much idle time the
// cache entry expires and the next request is re-processed as a cache miss.
const CACHE_TTL_MS = 5 * 60 * 1000;

const CACHE_WIDGET_KEY = "fable-cache-miss";
const CACHE_MISS_MESSAGE = "⚠ Prompt cache expired (idle > 5m) — your next message will be a cache miss";

// True-color red foreground, resetting only the foreground afterwards so it
// does not disturb any other styling composed onto the same border line.
const redBorder = (s: string): string => `\x1b[38;2;255;0;0m${s}\x1b[39m`;

let fableActive = false;
let activeTui: TUI | undefined;
let activeUi: ExtensionUIContext | undefined;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;

// Custom editor that forces the red border every frame while Fable is active.
// When inactive it defers to whatever border color interactive mode set.
class FableEditor extends CustomEditor {
	render(width: number): string[] {
		if (fableActive) {
			this.borderColor = redBorder;
		}
		return super.render(width);
	}
}

function clearCacheTimer(): void {
	if (cacheTimer) {
		clearTimeout(cacheTimer);
		cacheTimer = undefined;
	}
}

function hideCacheWarning(): void {
	activeUi?.setWidget(CACHE_WIDGET_KEY, undefined);
}

// Drops both the pending countdown and any visible warning, e.g. when a new
// request is about to refresh the cache or Fable is switched off.
function resetCacheState(): void {
	clearCacheTimer();
	hideCacheWarning();
}

function showCacheWarning(): void {
	activeUi?.setWidget(
		CACHE_WIDGET_KEY,
		(_tui, theme) => ({
			render: (width: number) => [theme.fg("error", truncateToWidth(CACHE_MISS_MESSAGE, width))],
			invalidate: () => {},
		}),
		{ placement: "belowEditor" },
	);
	activeTui?.requestRender();
}

// Starts the 5-minute idle countdown from now. When it fires while Fable is
// still active, the cache-miss warning is shown below the prompt box.
function startCacheTimer(): void {
	clearCacheTimer();
	if (!fableActive) return;
	cacheTimer = setTimeout(() => {
		cacheTimer = undefined;
		if (fableActive) showCacheWarning();
	}, CACHE_TTL_MS);
}

function hideFallbackWidget(): void {
	activeUi?.setWidget(FALLBACK_WIDGET_KEY, undefined);
}

// Shows which model actually answered after Anthropic fell back off Fable,
// persisting under the prompt box until the next turn starts.
function showFallbackWidget(servedModel: string, requestedModel: string): void {
	activeUi?.setWidget(
		FALLBACK_WIDGET_KEY,
		(_tui, theme) => ({
			render: (width: number) => [
				theme.fg(
					"warning",
					truncateToWidth(
						`\u21aa last reply used fallback \u2192 ${servedModel} (${requestedModel} refused)`,
						width,
					),
				),
			],
			invalidate: () => {},
		}),
		{ placement: "belowEditor" },
	);
	activeTui?.requestRender();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeUi = ctx.ui;
		fableActive = getFableLabel(ctx.model?.id) !== undefined;
		resetCacheState();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new FableEditor(tui, theme, keybindings);
		});
	});

	// Drop thinking from fallback turns before replay because its signatures only
	// validate for the model that served the original response.
	pi.on("context", (_event, ctx) => {
		const active = ctx.model?.id;
		if (!active) return;
		let changed = false;
		const messages = _event.messages.map((m) => {
			if (m.role !== "assistant") return m;
			const served = (m as AssistantMessage).responseModel;
			if (!served || served === active) return m;
			const kept = (m.content as Array<{ type: string }>).filter(
				(b) => b.type !== "thinking" && b.type !== "redacted_thinking",
			);
			if (kept.length === m.content.length) return m;
			changed = true;
			const safe = kept.length > 0 ? kept : [{ type: "text", text: `[thinking omitted: served by ${served}]` }];
			return { ...m, content: safe };
		});
		return changed ? { messages } : undefined;
	});

	pi.on("model_select", (event, _ctx) => {
		fableActive = getFableLabel(event.model.id) !== undefined;
		if (!fableActive) resetCacheState();
		activeTui?.requestRender();
	});

	// A new turn is about to refresh/create the cache: drop any stale warning
	// and countdown; agent_settled restarts the timer once the turn finishes.
	pi.on("before_agent_start", (_event, _ctx) => {
		resetCacheState();
		hideFallbackWidget();
	});

	// The agent is idle and the cache is now fresh: begin the 5-minute window
	// after which the next message would miss the cache.
	pi.on("agent_settled", (_event, _ctx) => {
		hideCacheWarning();
		startCacheTimer();
	});

	// Upstream keeps the requested model on the message and records the served
	// one in responseModel, so this only has to surface the fallback.
	pi.on("message_end", (event, ctx) => {
		const requestedModelId = ctx.model?.id;
		const requestedModelLabel = getFableLabel(requestedModelId);
		if (event.message.role !== "assistant" || !requestedModelId || !requestedModelLabel) return;
		const served = (event.message as AssistantMessage).responseModel;
		if (!served || served === requestedModelId) return;
		showFallbackWidget(served, requestedModelLabel);
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		resetCacheState();
		hideFallbackWidget();
		activeUi = undefined;
		activeTui = undefined;
	});
}
