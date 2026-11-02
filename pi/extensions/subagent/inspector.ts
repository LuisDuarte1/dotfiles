import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RunRegistry } from "./registry.ts";
import { DETAILED, runHeader, transcriptLines } from "./render.ts";
import { oneLine, type RunState } from "./run.ts";

export interface InspectorOptions {
	tui: TUI;
	theme: Theme;
	registry: RunRegistry;
	pastRuns: RunState[];
	loadPast: (run: RunState) => void;
	initialRunId?: number;
	done: () => void;
}

const HEIGHT_RATIO = 0.85;

export class SubagentInspector implements Component, Focusable {
	focused = false;
	private readonly opts: InspectorOptions;
	private readonly unsubscribe: () => void;
	private view: "list" | "detail" = "list";
	private selected = 0;
	private current: RunState | undefined;
	private scroll = 0;
	private flash = "";
	private openedDirectly = false;
	private input: Input | undefined;
	private stopArmed = false;

	constructor(opts: InspectorOptions) {
		this.opts = opts;
		this.unsubscribe = opts.registry.subscribe(() => opts.tui.requestRender());
		const initial = opts.initialRunId === undefined ? undefined : opts.registry.get(opts.initialRunId);
		if (initial) {
			this.openedDirectly = true;
			this.open(initial);
		}
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	private entries(): RunState[] {
		const current = this.opts.registry.all();
		const known = new Set(current.map((run) => run.sessionFile).filter(Boolean));
		return [...current, ...this.opts.pastRuns.filter((run) => !known.has(run.sessionFile))];
	}

	private open(run: RunState): void {
		if (run.id === 0) this.opts.loadPast(run);
		this.current = run;
		this.view = "detail";
		this.scroll = 0;
		this.flash = "";
	}

	private back(): void {
		if (this.view === "detail" && !this.openedDirectly) {
			this.view = "list";
			this.current = undefined;
		} else {
			this.opts.done();
		}
	}

	handleInput(data: string): void {
		if (this.input) {
			if (matchesKey(data, "escape")) this.input = undefined;
			else this.input.handleInput(data);
			this.opts.tui.requestRender();
			return;
		}
		this.flash = "";
		const armed = this.stopArmed;
		this.stopArmed = false;
		if (matchesKey(data, "escape") || data === "q") return this.back();
		if (this.view === "detail" && data === "x") {
			this.requestStop(armed);
			this.opts.tui.requestRender();
			return;
		}
		if (this.view === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
		this.opts.tui.requestRender();
	}

	private handleListInput(data: string): void {
		const entries = this.entries();
		if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(entries.length - 1, this.selected + 1);
		else if (matchesKey(data, "enter")) {
			const run = entries[this.selected];
			if (run) this.open(run);
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
		else if (data === "o") this.copySessionCommand();
		else if (data === "s") this.startInput("steer");
		else if (data === "f") this.startInput("follow-up");
	}

	private controls() {
		return this.current ? this.opts.registry.controlsFor(this.current.id) : undefined;
	}

	private report(action: Promise<string | undefined>, success: string): void {
		action.then(
			(error) => {
				this.flash = error ? `failed: ${error}` : success;
				this.opts.tui.requestRender();
			},
			(error: Error) => {
				this.flash = `failed: ${error.message}`;
				this.opts.tui.requestRender();
			},
		);
	}

	private startInput(mode: "steer" | "follow-up"): void {
		const controls = this.controls();
		if (!controls) {
			this.flash = "this subagent is no longer running";
			return;
		}
		const input = new Input({ prompt: `${mode} › ` });
		input.onSubmit = (value) => {
			this.input = undefined;
			const text = value.trim();
			if (!text) return;
			if (mode === "steer") this.report(controls.steer(text), "steer queued; delivered after the current step");
			else this.report(controls.followUp(text), "follow-up queued; delivered when it would otherwise finish");
		};
		this.input = input;
	}

	private requestStop(armed: boolean): void {
		const controls = this.controls();
		if (!controls) {
			this.flash = "this subagent is no longer running";
		} else if (!armed) {
			this.stopArmed = true;
			this.flash = "press x again to stop this subagent (the parent gets its partial output)";
		} else {
			this.report(controls.stop(), "stopped");
		}
	}

	private copySessionCommand(): void {
		const file = this.current?.sessionFile;
		if (!file) {
			this.flash = "no session file yet (written after the first reply)";
			return;
		}
		const command = `pi --session ${file}`;
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
		return this.height() - 2 - this.headerLines(80).length - 1;
	}

	private headerLines(width: number): string[] {
		const { theme } = this.opts;
		const run = this.current;
		if (this.view !== "detail" || !run) return [];
		const lines = [runHeader(run, theme)];
		lines.push(...wrapTextWithAnsi(theme.fg("muted", "task: ") + theme.fg("dim", oneLine(run.task, 1000)), width).slice(0, 2));
		if (run.sessionFile) lines.push(theme.fg("muted", "session: ") + theme.fg("dim", run.sessionFile));
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		return lines;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const height = this.height();
		const { title, body, footer } = this.view === "detail" && this.current ? this.renderDetail(inner, height) : this.renderList(inner, height);
		return this.frame(width, inner, title, body, footer);
	}

	private renderList(inner: number, height: number): { title: string; body: string[]; footer: string } {
		const { theme } = this.opts;
		const entries = this.entries();
		this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
		const rows: string[] = [];
		entries.forEach((run, i) => {
			const marker = i === this.selected ? theme.fg("accent", "▸ ") : "  ";
			const activity = run.status === "running" && run.activity ? theme.fg("dim", ` · ${oneLine(run.activity, 200)}`) : "";
			rows.push(marker + runHeader(run, theme) + activity);
			rows.push(`    ${theme.fg("dim", oneLine(run.task, 500))}`);
		});
		if (rows.length === 0) rows.push(theme.fg("muted", "No subagent runs in this session yet."));

		const available = height - 3;
		const start = Math.max(0, Math.min(this.selected * 2 - Math.floor(available / 2), rows.length - available));
		return {
			title: "Subagents",
			body: rows.slice(start, start + available),
			footer: theme.fg("dim", "↑↓ select · enter open · esc close"),
		};
	}

	private renderDetail(inner: number, height: number): { title: string; body: string[]; footer: string } {
		const { theme } = this.opts;
		const run = this.current as RunState;
		const header = this.headerLines(inner);
		const lines = transcriptLines(run.transcript, inner, theme, DETAILED);
		if (run.status === "error" && run.stderr.trim()) {
			lines.push("", ...wrapTextWithAnsi(theme.fg("error", run.stderr.trim().split("\n").slice(-8).join("\n")), inner));
		}
		for (const queued of run.pending) lines.push(theme.fg("warning", `⧗ queued: ${oneLine(queued, 500)}`));
		if (lines.length === 0) lines.push(theme.fg("muted", run.status === "running" ? "waiting for the first event…" : "(empty transcript)"));

		const available = Math.max(1, height - 3 - header.length);
		const maxScroll = Math.max(0, lines.length - available);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = lines.length - this.scroll;
		const body = [...header, ...lines.slice(Math.max(0, end - available), end)];
		const position = this.scroll > 0 ? ` · ↓ ${this.scroll} more` : run.status === "running" ? " · following" : "";
		const actions = this.controls() ? "s steer · f follow-up · x stop · " : "";
		const hints = `${actions}↑↓ PgUp PgDn scroll · g/G top/end · o copy session cmd · esc back`;
		let footer = theme.fg(this.flash ? "warning" : "dim", this.flash || hints);
		if (this.input) {
			this.input.focused = this.focused;
			footer = this.input.render(inner)[0] ?? "";
		}
		return {
			title: `Subagent ${run.id > 0 ? `#${run.id}` : "(earlier)"}${position}`,
			body,
			footer,
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
