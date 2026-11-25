import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { JobInfo } from "./frames.ts";
import { type JobStore, lastLine, tailLines } from "./jobs.ts";
import { jobHeader, notifyLabel, oneLine } from "./render.ts";

export interface InspectorOptions {
	tui: TUI;
	theme: Theme;
	store: JobStore;
	initialId?: string;
	kill: (job: JobInfo) => string | undefined;
	done: () => void;
}

const HEIGHT_RATIO = 0.85;
const LOG_BYTES = 256 * 1024;

// Mirrors the subagent inspector: a job list, and a detail view that follows the
// job's log. Logs are reread on the 1s tick only, never on a repaint.
export class BgInspector implements Component, Focusable {
	focused = false;
	private readonly opts: InspectorOptions;
	private readonly unsubscribe: () => void;
	private readonly ticker: ReturnType<typeof setInterval>;
	private view: "list" | "detail" = "list";
	private selected = 0;
	private currentId: string | undefined;
	private scroll = 0;
	private flash = "";
	private openedDirectly = false;
	private killArmed = false;
	private tails = new Map<string, string>();
	private log: string[] = [];
	private wrapped: { src: string[]; width: number; lines: string[] } | undefined;

	constructor(opts: InspectorOptions) {
		this.opts = opts;
		if (opts.initialId && opts.store.get(opts.initialId)) {
			this.openedDirectly = true;
			this.open(opts.initialId);
		}
		this.refresh();
		this.unsubscribe = opts.store.subscribe(() => {
			this.refresh();
			opts.tui.requestRender();
		});
		this.ticker = setInterval(() => {
			this.refresh();
			opts.tui.requestRender();
		}, 1000);
		this.ticker.unref?.();
	}

	dispose(): void {
		clearInterval(this.ticker);
		this.unsubscribe();
	}

	invalidate(): void {}

	private current(): JobInfo | undefined {
		return this.currentId === undefined ? undefined : this.opts.store.get(this.currentId);
	}

	private refresh(): void {
		const job = this.view === "detail" ? this.current() : undefined;
		if (job) {
			this.log = tailLines(job.log, LOG_BYTES);
			return;
		}
		const tails = new Map<string, string>();
		for (const j of this.opts.store.all()) tails.set(j.id, lastLine(j.log));
		this.tails = tails;
	}

	private open(id: string): void {
		this.currentId = id;
		this.view = "detail";
		this.scroll = 0;
		this.flash = "";
		this.wrapped = undefined;
		this.refresh();
	}

	private back(): void {
		if (this.view === "detail" && !this.openedDirectly) {
			this.view = "list";
			this.currentId = undefined;
			this.refresh();
		} else {
			this.opts.done();
		}
	}

	handleInput(data: string): void {
		this.flash = "";
		const armed = this.killArmed;
		this.killArmed = false;
		if (matchesKey(data, "escape") || data === "q") return this.back();
		if (this.view === "list") this.handleListInput(data);
		else if (data === "x") this.requestKill(armed);
		else this.handleDetailInput(data);
		this.opts.tui.requestRender();
	}

	private handleListInput(data: string): void {
		const entries = this.opts.store.all();
		if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(entries.length - 1, this.selected + 1);
		else if (matchesKey(data, "enter")) {
			const job = entries[this.selected];
			if (job) this.open(job.id);
		}
	}

	private handleDetailInput(data: string): void {
		const page = Math.max(1, this.bodyHeight() - 2);
		if (matchesKey(data, "up") || data === "k") this.scroll += 1;
		else if (matchesKey(data, "down") || data === "j") this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "pageUp")) this.scroll += page;
		else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - page);
		else if (matchesKey(data, "home") || data === "g") this.scroll = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, "end") || data === "G") this.scroll = 0;
		else if (data === "o") this.copyTailCommand();
	}

	private requestKill(armed: boolean): void {
		const job = this.current();
		if (!job?.running) {
			this.flash = "this job is no longer running";
		} else if (!armed) {
			this.killArmed = true;
			this.flash = `press x again to kill ${job.id} (SIGTERM to its process group)`;
		} else {
			const error = this.opts.kill(job);
			this.flash = error ? `kill failed: ${error}` : `sent SIGTERM to ${job.id}`;
		}
		this.opts.tui.requestRender();
	}

	private copyTailCommand(): void {
		const job = this.current();
		if (!job) return;
		const command = `tail -f ${job.log}`;
		copyToClipboard(command).then(
			() => {
				this.flash = `copied: ${command}`;
				this.opts.tui.requestRender();
			},
			() => {
				this.flash = command;
				this.opts.tui.requestRender();
			},
		);
	}

	private height(): number {
		return Math.max(12, Math.floor(this.opts.tui.terminal.rows * HEIGHT_RATIO));
	}

	private bodyHeight(): number {
		return this.height() - 3 - this.headerLines(80).length;
	}

	private headerLines(width: number): string[] {
		const { theme } = this.opts;
		const job = this.current();
		if (this.view !== "detail" || !job) return [];
		const lines = [jobHeader(job, theme, Date.now())];
		lines.push(...wrapTextWithAnsi(theme.fg("muted", "cmd: ") + theme.fg("dim", oneLine(job.cmd, 1000)), width).slice(0, 2));
		if (job.notify.length > 0) lines.push(theme.fg("muted", "notify: ") + theme.fg("accent", notifyLabel(job.notify)));
		lines.push(theme.fg("muted", "log: ") + theme.fg("dim", job.log));
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		return lines;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const height = this.height();
		if (this.view === "detail" && !this.current()) {
			this.view = "list";
			this.currentId = undefined;
		}
		const { title, body, footer } = this.view === "detail" ? this.renderDetail(inner, height) : this.renderList(height);
		return this.frame(width, inner, title, body, footer);
	}

	private renderList(height: number): { title: string; body: string[]; footer: string } {
		const { theme } = this.opts;
		const entries = this.opts.store.all();
		const now = Date.now();
		this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
		const rows: string[] = [];
		entries.forEach((job, i) => {
			const marker = i === this.selected ? theme.fg("accent", "▸ ") : "  ";
			const notify = job.notify.length > 0 ? theme.fg("accent", ` · notify ${notifyLabel(job.notify)}`) : "";
			rows.push(marker + jobHeader(job, theme, now) + notify);
			rows.push(`    ${theme.fg("dim", oneLine(this.tails.get(job.id) || "(no output)", 500))}`);
		});
		if (rows.length === 0) rows.push(theme.fg("muted", "No bg_do jobs in this session yet."));

		const available = height - 3;
		const start = Math.max(0, Math.min(this.selected * 2 - Math.floor(available / 2), rows.length - available));
		return {
			title: "Background jobs",
			body: rows.slice(start, start + available),
			footer: theme.fg(this.flash ? "warning" : "dim", this.flash || "↑↓ select · enter open · esc close"),
		};
	}

	private renderDetail(inner: number, height: number): { title: string; body: string[]; footer: string } {
		const { theme } = this.opts;
		const job = this.current() as JobInfo;
		const header = this.headerLines(inner);
		if (this.wrapped?.src !== this.log || this.wrapped.width !== inner) {
			const lines = this.log.flatMap((line) => (line ? wrapTextWithAnsi(theme.fg("toolOutput", line), inner) : [""]));
			this.wrapped = { src: this.log, width: inner, lines };
		}
		const lines = this.wrapped.lines.length > 0 ? this.wrapped.lines : [theme.fg("muted", "(no output yet)")];

		const available = Math.max(1, height - 3 - header.length);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - available));
		const end = lines.length - this.scroll;
		const body = [...header, ...lines.slice(Math.max(0, end - available), end)];
		const position = this.scroll > 0 ? ` · ↓ ${this.scroll} more` : job.running ? " · following" : "";
		const hints = `${job.running ? "x kill · " : ""}↑↓ PgUp PgDn scroll · g/G top/end · o copy tail cmd · esc back`;
		return {
			title: `Job ${job.id}${position}`,
			body,
			footer: theme.fg(this.flash ? "warning" : "dim", this.flash || hints),
		};
	}

	private frame(width: number, inner: number, title: string, body: string[], footer: string): string[] {
		const { theme } = this.opts;
		const border = (s: string) => theme.fg("border", s);
		const pad = (s: string) => {
			const clipped = truncateToWidth(s, inner);
			return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		};
		const titleText = ` ${title} `;
		const top = border("╭─") + theme.fg("accent", titleText) + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(titleText)))}╮`);
		const rows = body.map((line) => `${border("│")} ${pad(line)} ${border("│")}`);
		const available = this.height() - 3;
		while (rows.length < available) rows.push(`${border("│")} ${pad("")} ${border("│")}`);
		const foot = `${border("│")} ${pad(footer)} ${border("│")}`;
		return [top, ...rows, foot, border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)];
	}
}
