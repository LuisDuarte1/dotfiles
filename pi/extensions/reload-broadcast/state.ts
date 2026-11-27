import { tmpdir } from "node:os";
import path from "node:path";

export const REQUEST_FILE = "request";
export const STATUS_KEY = "reload-broadcast";

export type Mode = "tui" | "rpc";

export interface ReloadState {
	requested: boolean;
	aborting: boolean;
	inFlight: boolean;
}

export const INITIAL_STATE: ReloadState = { requested: false, aborting: false, inFlight: false };

export type ReloadEvent =
	| { type: "request"; idle: boolean }
	| { type: "turn_end"; hasToolResults: boolean }
	| { type: "settled" }
	| { type: "reload_done" };

export type ReloadAction = "notify_queued" | "abort" | "reload" | "reload_and_continue";

// An RPC client that reads each agent_settled as the end would drop a child that reloads mid-run,
// so RPC opts in through the env; the subagent's local child sets it and knows the reload status.
export function modeFor(mode: string, env: NodeJS.ProcessEnv = process.env): Mode | undefined {
	if (mode === "tui") return "tui";
	if (mode === "rpc" && env.PI_RELOAD_BROADCAST === "1") return "rpc";
	return undefined;
}

export function requestDir(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
	return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "pi-reload") : path.join(tmpdir(), `pi-reload-${uid}`);
}

// Aborting only after a turn whose tool results are in loses no work, and a turn without tool results
// is the final answer, so it is left to settle. An idle RPC child has either just started or is exiting.
export function step(mode: Mode, state: ReloadState, event: ReloadEvent): { state: ReloadState; actions: ReloadAction[] } {
	switch (event.type) {
		case "request":
			if (state.requested || state.aborting || state.inFlight) return { state, actions: [] };
			if (!event.idle) return { state: { ...state, requested: true }, actions: ["notify_queued"] };
			if (mode === "rpc") return { state, actions: [] };
			return { state: { ...state, inFlight: true }, actions: ["reload"] };
		case "turn_end":
			if (!state.requested || !event.hasToolResults) return { state, actions: [] };
			return { state: { ...state, requested: false, aborting: true }, actions: ["abort"] };
		case "settled":
			if (state.aborting) return { state: { ...state, aborting: false, inFlight: true }, actions: ["reload_and_continue"] };
			if (!state.requested) return { state, actions: [] };
			if (mode === "rpc") return { state: { ...state, requested: false }, actions: [] };
			return { state: { ...state, requested: false, inFlight: true }, actions: ["reload"] };
		case "reload_done":
			return { state: { ...state, inFlight: false }, actions: [] };
	}
}
