import { createRun, type RunState } from "./run.ts";

export interface RunControls {
	steer(text: string): Promise<string | undefined>;
	followUp(text: string): Promise<string | undefined>;
	stop(): Promise<string | undefined>;
}

const MAX_FINISHED = 30;
const NOTIFY_INTERVAL_MS = 100;

// Streaming deltas arrive far faster than a terminal can usefully repaint, so
// listeners are notified at most every NOTIFY_INTERVAL_MS (leading + trailing).
export class RunRegistry {
	private runs: RunState[] = [];
	private controls = new Map<number, RunControls>();
	private listeners = new Set<() => void>();
	private nextId = 1;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;

	create(init: { task: string; agent?: string; model?: string; context?: string }): RunState {
		const run = createRun({ id: this.nextId++, ...init });
		this.runs.push(run);
		this.changed();
		return run;
	}

	attach(id: number, controls: RunControls): void {
		this.controls.set(id, controls);
	}

	detach(id: number): void {
		this.controls.delete(id);
	}

	controlsFor(id: number): RunControls | undefined {
		return this.controls.get(id);
	}

	finish(run: RunState): void {
		run.endedAt ??= Date.now();
		this.controls.delete(run.id);
		const finished = this.runs.filter((r) => r.status !== "running");
		const excess = finished.length - MAX_FINISHED;
		if (excess > 0) {
			const drop = new Set(finished.slice(0, excess));
			this.runs = this.runs.filter((r) => !drop.has(r));
		}
		this.changed();
	}

	get(id: number): RunState | undefined {
		return this.runs.find((r) => r.id === id);
	}

	live(): RunState[] {
		return this.runs.filter((r) => r.status === "running");
	}

	all(): RunState[] {
		return [...this.live(), ...this.runs.filter((r) => r.status !== "running").reverse()];
	}

	clearFinished(): void {
		this.runs = this.live();
		this.changed();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		if (this.timer) {
			this.dirty = true;
			return;
		}
		this.notify();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.dirty) {
				this.dirty = false;
				this.notify();
			}
		}, NOTIFY_INTERVAL_MS);
		this.timer.unref?.();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
