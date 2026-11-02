import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RunRegistry } from "./registry.ts";
import { oneLine, type RunState, type RunStatus, runStats, type ToolItem, type TranscriptItem } from "./run.ts";

export interface TranscriptStyle {
	toolOutputLines: number;
	thinkingLines: number;
}

export const COMPACT: TranscriptStyle = { toolOutputLines: 3, thinkingLines: 2 };
export const DETAILED: TranscriptStyle = { toolOutputLines: 12, thinkingLines: 8 };

export function statusIcon(status: RunStatus, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "⏳");
		case "done":
			return theme.fg("success", "✓");
		case "stopped":
			return theme.fg("warning", "■");
		default:
			return theme.fg("error", "✗");
	}
}

function toolIcon(state: ToolItem["state"], theme: Theme): string {
	switch (state) {
		case "pending":
			return theme.fg("dim", "…");
		case "running":
			return theme.fg("warning", "▶");
		case "done":
			return theme.fg("success", "✓");
		default:
			return theme.fg("error", "✗");
	}
}

function wrap(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}

function itemLines(item: TranscriptItem, width: number, theme: Theme, style: TranscriptStyle): string[] {
	switch (item.kind) {
		case "text":
			return wrap(item.text.trim(), width);
		case "thinking": {
			const lines = wrap(item.text.trim(), width - 2);
			const shown = lines.slice(-style.thinkingLines);
			return shown.map((line) => theme.fg("thinkingText", theme.italic(`│ ${line}`)));
		}
		case "user":
			return wrap(item.text.trim(), width - 2).map((line, i) => theme.fg("accent", `${i === 0 ? "»" : " "} ${line}`));
		case "note": {
			const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
			return wrap(item.text, width - 2).map((line, i) => theme.fg(color, `${i === 0 ? "•" : " "} ${line}`));
		}
		case "tool": {
			const header = `${toolIcon(item.state, theme)} ${theme.fg("toolTitle", theme.bold(item.name))} ${theme.fg("dim", item.args)}`;
			const lines = [truncateToWidth(header, width)];
			const output = item.output.replace(/\s+$/, "");
			if (!output) return lines;
			const outLines = output.split("\n");
			const shown = outLines.slice(-style.toolOutputLines);
			if (outLines.length > shown.length) {
				lines.push(theme.fg("muted", `  … ${outLines.length - shown.length} earlier lines`));
			}
			const color = item.state === "error" ? "error" : "toolOutput";
			for (const line of shown) lines.push(truncateToWidth(theme.fg(color, `  ${line}`), width));
			return lines;
		}
	}
}

interface CacheEntry {
	rev: number;
	width: number;
	theme: Theme;
	style: TranscriptStyle;
	lines: string[];
}
const cache = new WeakMap<TranscriptItem, CacheEntry>();

export function transcriptLines(items: TranscriptItem[], width: number, theme: Theme, style: TranscriptStyle): string[] {
	const out: string[] = [];
	for (const item of items) {
		let entry = cache.get(item);
		if (!entry || entry.rev !== item.rev || entry.width !== width || entry.theme !== theme || entry.style !== style) {
			entry = { rev: item.rev, width, theme, style, lines: itemLines(item, width, theme, style) };
			cache.set(item, entry);
		}
		if (out.length > 0 && (item.kind === "text" || item.kind === "user")) out.push("");
		out.push(...entry.lines);
	}
	return out;
}

export function runHeader(run: RunState, theme: Theme): string {
	const name = run.agent ? theme.fg("accent", run.agent) : theme.fg("toolTitle", "subagent");
	const label = run.id > 0 ? `#${run.id}` : "earlier";
	return `${statusIcon(run.status, theme)} ${theme.fg("muted", label)} ${name} ${theme.fg("muted", `[${run.status}] · ${runStats(run)}`)}`;
}

export class Lines implements Component {
	private readonly build: (width: number) => string[];

	constructor(build: (width: number) => string[]) {
		this.build = build;
	}

	render(width: number): string[] {
		return this.build(width);
	}

	invalidate(): void {}
}

export function widgetLines(registry: RunRegistry, width: number, theme: Theme): string[] {
	const lines = registry.live().map((run) => {
		const activity = run.activity ? theme.fg("dim", ` · ${oneLine(run.activity, 200)}`) : "";
		return truncateToWidth(`${runHeader(run, theme)}${activity}`, width);
	});
	if (lines.length > 0) lines.push(theme.fg("dim", truncateToWidth("  alt+s or /subagents to inspect", width)));
	return lines;
}
