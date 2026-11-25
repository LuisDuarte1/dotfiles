export interface NotifyEvent {
	id: string;
	cmd: string;
	reason: "exit" | "match";
	returncode: number | null;
	line: string | null;
	tail: string[];
}

export interface JobInfo {
	id: string;
	cmd: string;
	pid: number | null;
	group: boolean;
	started: number;
	ended: number | null;
	running: boolean;
	returncode: number | null;
	log: string;
	notify: (string | null)[];
}

export type Routed =
	| { kind: "ready"; pid?: number }
	| { kind: "reply"; out: string; err: string | null }
	| { kind: "notify"; event: NotifyEvent }
	| { kind: "jobs"; running: number }
	| { kind: "table"; jobs: JobInfo[] }
	| { kind: "ignore" };

export function decodeFrame(line: string): unknown {
	try {
		return JSON.parse(Buffer.from(line, "base64").toString("utf8"));
	} catch {
		return null;
	}
}

// Events arrive between replies and must never settle the call that is waiting
// for one; an event kind this version does not know is dropped for the same reason.
export function routeFrame(frame: unknown): Routed {
	if (!frame || typeof frame !== "object") return { kind: "ignore" };
	const f = frame as Record<string, unknown>;
	if (f.ready === true) return { kind: "ready", pid: typeof f.pid === "number" ? f.pid : undefined };
	if ("event" in f) {
		if (f.event === "jobs") {
			const n = f.running;
			return Number.isInteger(n) && (n as number) >= 0 ? { kind: "jobs", running: n as number } : { kind: "ignore" };
		}
		if (f.event === "table") {
			return Array.isArray(f.jobs) ? { kind: "table", jobs: f.jobs.flatMap(jobInfo) } : { kind: "ignore" };
		}
		if (f.event !== "notify") return { kind: "ignore" };
		return {
			kind: "notify",
			event: {
				id: str(f.id) ?? "?",
				cmd: str(f.cmd) ?? "",
				reason: f.reason === "match" ? "match" : "exit",
				returncode: typeof f.returncode === "number" ? f.returncode : null,
				line: str(f.line),
				tail: Array.isArray(f.tail) ? f.tail.filter((l): l is string => typeof l === "string") : [],
			},
		};
	}
	return { kind: "reply", out: str(f.out) ?? "", err: str(f.err) };
}

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A row without an id or a log cannot be shown or opened, so it is dropped; every
// other field falls back to a value that renders as "unknown" rather than failing.
function jobInfo(raw: unknown): JobInfo[] {
	if (!raw || typeof raw !== "object") return [];
	const r = raw as Record<string, unknown>;
	const id = str(r.id);
	const log = str(r.log);
	if (!id || !log) return [];
	const pid = num(r.pid);
	return [
		{
			id,
			cmd: str(r.cmd) ?? "",
			pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
			group: r.group === true,
			started: num(r.started) ?? 0,
			ended: num(r.ended),
			running: r.running === true,
			returncode: num(r.returncode),
			log,
			notify: Array.isArray(r.notify) ? r.notify.filter((p): p is string | null => p === null || typeof p === "string") : [],
		},
	];
}

// The engine re-sends its count on every attach, so the same number can arrive
// twice; listeners are promised one call per change.
export function runningCounter(emit: (n: number) => void): (n: number) => void {
	let last: number | undefined;
	return (n) => {
		if (n === last) return;
		last = n;
		emit(n);
	};
}

export const NOTIFY_LIMITS = { cmd: 200, line: 300, tailLines: 10, tailLine: 240 };

export function clean(s: string): string {
	const noAnsi = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r+$/, "");
	return noAnsi.slice(noAnsi.lastIndexOf("\r") + 1);
}

function clip(s: string, max: number): string {
	const chars = [...s];
	return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

function exitText(rc: number | null): string {
	if (rc === null) return "exited";
	return rc < 0 ? `was killed by signal ${-rc}` : `exited with code ${rc}`;
}

export function notifyMessage(ev: NotifyEvent): string {
	const L = NOTIFY_LIMITS;
	const head =
		ev.reason === "match"
			? `bg_do notify: ${ev.id} printed a matching line (${ev.returncode === null ? "still running" : `it has since ${exitText(ev.returncode)}`}):\n  ${clip(clean(ev.line ?? ""), L.line)}`
			: `bg_do notify: ${ev.id} ${exitText(ev.returncode)}.`;
	const tail = ev.tail.slice(-L.tailLines).map((l) => `  ${clip(clean(l), L.tailLine)}`);
	return [
		head,
		`Command: ${clip(ev.cmd.replace(/\s+/g, " ").trim(), L.cmd)}`,
		tail.length ? `Last ${tail.length} line${tail.length === 1 ? "" : "s"} of output:` : "No output.",
		...tail,
	].join("\n");
}
