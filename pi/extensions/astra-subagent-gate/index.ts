import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decide, ENTRY_TYPE, type GateState, INITIAL_STATE, restoreState, sameState } from "./gate.ts";

// GPT-6 Astra over-delegates, so `subagent` stays hidden until a prompt asks for
// subagents; the unlock is sticky to avoid repeated tool-list cache busts.

const STATUS_KEY = "astra-subagent-gate";

export default function (pi: ExtensionAPI) {
	let state: GateState = { ...INITIAL_STATE };

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, state.removed ? "subagent: off (astra)" : undefined);
	};

	// Pi restores the tool loadout from the transcript on resume, fork and /tree,
	// so the gate state must come from the same branch to stay consistent with it.
	const restore = (ctx: ExtensionContext) => {
		state = restoreState(ctx.sessionManager.getBranch());
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const decision = decide({
			modelId: ctx.model?.id,
			prompt: event.prompt,
			active: pi.getActiveTools(),
			state,
		});
		if (decision.tools) pi.setActiveTools(decision.tools);
		if (!sameState(state, decision.state)) {
			state = decision.state;
			pi.appendEntry(ENTRY_TYPE, state);
		}
		updateStatus(ctx);
	});
}
