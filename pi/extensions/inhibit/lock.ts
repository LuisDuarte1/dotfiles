export const GRACE_MS = 60_000;

export interface LockState {
	turn: boolean;
	jobs: number;
	held: boolean;
	grace: boolean;
	off: boolean;
}

export const INITIAL_STATE: LockState = { turn: false, jobs: 0, held: false, grace: false, off: false };

export type LockEvent =
	| { type: "turn_start" }
	| { type: "turn_settled" }
	| { type: "jobs"; running: number }
	| { type: "grace_expired" }
	| { type: "lock_exited"; missing: boolean }
	| { type: "shutdown" };

export type LockAction = "acquire" | "release" | "arm_grace" | "cancel_grace";

function apply(state: LockState, event: LockEvent): LockState {
	switch (event.type) {
		case "turn_start":
			return { ...state, turn: true };
		case "turn_settled":
			return { ...state, turn: false };
		case "jobs":
			return { ...state, jobs: event.running };
		case "grace_expired":
			return { ...state, grace: false };
		case "lock_exited":
			return { ...state, held: false, off: state.off || event.missing };
		case "shutdown":
			return { ...state, off: true };
	}
}

// A lock that dies on its own is retried only on the next agent_start or job count, so a
// systemd-inhibit that fails at once cannot respawn in a loop; a missing one is never retried.
export function step(state: LockState, event: LockEvent): { state: LockState; actions: LockAction[] } {
	const next = apply(state, event);
	const actions: LockAction[] = [];
	const busy = !next.off && (next.turn || next.jobs > 0);
	if (busy && !next.held && event.type !== "lock_exited") {
		next.held = true;
		actions.push("acquire");
	} else if (!busy && next.held && (next.off || event.type === "grace_expired")) {
		next.held = false;
		actions.push("release");
	}
	const grace = next.held && !busy;
	if (grace !== next.grace) {
		next.grace = grace;
		actions.push(grace ? "arm_grace" : "cancel_grace");
	}
	return { state: next, actions };
}

export function runningJobs(data: unknown): number | undefined {
	return typeof data === "number" && Number.isFinite(data) ? Math.max(0, Math.floor(data)) : undefined;
}

export function lockWhy(session: { name?: string; id: string; cwd: string }, state: LockState): string {
	const reason = state.turn ? "agent turn" : `${state.jobs} background job${state.jobs === 1 ? "" : "s"}`;
	return `${session.name || session.id.slice(0, 8)} (${session.cwd}): ${reason}`;
}

export function inhibitArgs(why: string): string[] {
	return ["--what=idle:sleep:shutdown", "--mode=block", "--who=pi", `--why=${why}`, "cat"];
}
