import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { JobInfo } from "./frames.ts";

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

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function statusIcon(job: JobInfo, theme: Theme): string {
	if (job.running) return theme.fg("warning", "⏳");
	if (job.returncode === 0) return theme.fg("success", "✓");
	if (job.returncode !== null && job.returncode < 0) return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

export function statusLabel(job: JobInfo): string {
	if (job.running) return "running";
	if (job.returncode === null) return "exited";
	return job.returncode < 0 ? `signal ${-job.returncode}` : `exit ${job.returncode}`;
}

export function notifyLabel(notify: (string | null)[]): string {
	return `on ${notify.map((p) => (p === null ? "exit" : `/${p}/`)).join(", ")}`;
}

export function elapsed(job: JobInfo, now: number): string {
	if (!job.started) return "?";
	return formatDuration(((job.ended ?? now / 1000) - job.started) * 1000);
}

export function jobHeader(job: JobInfo, theme: Theme, now: number, label = statusLabel(job)): string {
	const cmd = theme.fg("toolTitle", oneLine(job.cmd, 80));
	return `${statusIcon(job, theme)} ${theme.fg("muted", job.id)} ${cmd} ${theme.fg("muted", `[${label}] · ${elapsed(job, now)}`)}`;
}

// Lines come back untruncated: pi-tui only resolves inside pi, and keeping it out of
// this module lets the tests run it under plain node.
export function widgetLines(jobs: JobInfo[], tails: Map<string, string>, now: number, theme: Theme): string[] {
	const lines = jobs.map((job) => {
		const tail = tails.get(job.id);
		const activity = tail ? theme.fg("dim", ` · ${oneLine(tail, 200)}`) : "";
		return `${jobHeader(job, theme, now, notifyLabel(job.notify))}${activity}`;
	});
	if (lines.length > 0) lines.push(theme.fg("dim", "  /bg to list jobs"));
	return lines;
}
