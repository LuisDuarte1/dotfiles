// A `pi -p` child runs on the default model, outside this session's view and cancel, and
// has exhausted RAM before; the subagent tool runs the same work as a tracked child.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { check, type Verdict } from "./detect.ts";

const REASON =
	"Do not spawn pi yourself; use the `subagent` tool (pass `model`, and `name` to resume). " +
	"A raw child is invisible to this session and is not cancelled with it.";

export default function noRawPi(pi: ExtensionAPI) {
	let hatchUses = 0;

	function onHatch(ctx: ExtensionContext) {
		hatchUses += 1;
		if (ctx.hasUI) {
			ctx.ui.notify(`no-raw-pi bypassed via guard:allow-pi (${hatchUses} this session)`, "warning");
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		let verdict: Verdict;
		try {
			if (event.toolName === "bash") {
				verdict = check(String((event.input as { command?: unknown }).command ?? ""), "bash");
			} else if (event.toolName === "bg_do") {
				verdict = check(String((event.input as { code?: unknown }).code ?? ""), "snippet");
			} else {
				return undefined;
			}
		} catch {
			return undefined; // pi blocks a call whose handler throws, and a guard bug must not block
		}

		if (verdict === "hatch") {
			onHatch(ctx);
			return undefined;
		}
		if (verdict === "allow") return undefined;
		if (ctx.hasUI) ctx.ui.notify("no-raw-pi blocked a pi launch", "warning");
		return { block: true, reason: REASON, terminate: false };
	});
}
