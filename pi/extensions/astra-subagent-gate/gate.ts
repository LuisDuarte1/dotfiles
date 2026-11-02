export const GATED_MODEL_ID = "gpt-6-astra";
export const GATED_TOOL = "subagent";
export const ENTRY_TYPE = "astra-subagent-gate";

const TRIGGER = /\bsubagents?\b/i;

export interface GateState {
	unlocked: boolean;
	removed: boolean;
}

export const INITIAL_STATE: GateState = { unlocked: false, removed: false };

export interface GateInput {
	modelId: string | undefined;
	prompt: string;
	active: readonly string[];
	state: GateState;
}

export interface GateDecision {
	tools?: string[];
	state: GateState;
}

// Only re-add the tool when this gate removed it, so restricted `--tools`
// loadouts (e.g. subagent children with an agent's tool list) stay intact.
export function decide({ modelId, prompt, active, state }: GateInput): GateDecision {
	const unlocked = state.unlocked || TRIGGER.test(prompt);
	const gated = modelId === GATED_MODEL_ID && !unlocked;
	const isActive = active.includes(GATED_TOOL);

	if (gated && isActive) {
		return { tools: active.filter((name) => name !== GATED_TOOL), state: { unlocked, removed: true } };
	}
	if (!gated && state.removed) {
		return { tools: isActive ? undefined : [...active, GATED_TOOL], state: { unlocked, removed: false } };
	}
	return { state: { unlocked, removed: state.removed } };
}

export function sameState(a: GateState, b: GateState): boolean {
	return a.unlocked === b.unlocked && a.removed === b.removed;
}

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function isGateState(value: unknown): value is GateState {
	const v = value as Partial<GateState> | null;
	return typeof v === "object" && v !== null && typeof v.unlocked === "boolean" && typeof v.removed === "boolean";
}

export function restoreState(branch: readonly EntryLike[]): GateState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isGateState(entry.data)) {
			return { unlocked: entry.data.unlocked, removed: entry.data.removed };
		}
	}
	return { ...INITIAL_STATE };
}
