import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { clean, type JobInfo } from "./frames.ts";

const jobNumber = (job: JobInfo) => Number(job.id.slice(job.id.lastIndexOf("-") + 1)) || 0;

// The engine owns the job table and pushes it on every change; this is only the
// extension's latest copy, which the widget and the inspector render from.
export class JobStore {
	private jobs: JobInfo[] = [];
	private listeners = new Set<() => void>();

	set(jobs: JobInfo[]): void {
		if (jobs.length === 0 && this.jobs.length === 0) return;
		this.jobs = [...jobs].sort((a, b) => jobNumber(a) - jobNumber(b));
		for (const listener of this.listeners) listener();
	}

	get(id: string): JobInfo | undefined {
		return this.jobs.find((job) => job.id === id);
	}

	all(): JobInfo[] {
		return [...this.jobs.filter((job) => job.running), ...this.jobs.filter((job) => !job.running).reverse()];
	}

	pending(): JobInfo[] {
		return this.jobs.filter((job) => job.notify.length > 0);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export function tailLines(path: string, maxBytes: number): string[] {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes - 1); // one byte early: a cut at a line start keeps that line
		const buf = Buffer.alloc(size - start);
		const read = readSync(fd, buf, 0, buf.length, start);
		const lines = buf.subarray(0, read).toString("utf8").split("\n");
		if (start > 0) lines.shift();
		if (lines.at(-1) === "") lines.pop();
		return lines.map(clean);
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function lastLine(path: string): string {
	const lines = tailLines(path, 4096);
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim();
	return "";
}
