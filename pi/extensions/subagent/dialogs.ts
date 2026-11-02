import type { ExtensionContext, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { UiResponseBody } from "./rpc.ts";
import type { RunState } from "./run.ts";

// A child extension's dialog blocks that child until answered, so it is shown in the
// parent UI, labelled with the run, and dismissed if the parent aborts the tool call.
export async function forwardDialog(
	ctx: ExtensionContext,
	run: RunState,
	request: RpcExtensionUIRequest,
	signal: AbortSignal | undefined,
): Promise<UiResponseBody> {
	const label = `[subagent #${run.id}${run.agent ? ` ${run.agent}` : ""}]`;
	const title = "title" in request ? `${label} ${request.title}` : label;
	const opts = { signal, timeout: "timeout" in request ? request.timeout : undefined };
	switch (request.method) {
		case "select": {
			const value = await ctx.ui.select(title, request.options, opts);
			return value === undefined ? { cancelled: true } : { value };
		}
		case "confirm":
			return { confirmed: await ctx.ui.confirm(title, request.message, opts) };
		case "input": {
			const value = await ctx.ui.input(title, request.placeholder, opts);
			return value === undefined ? { cancelled: true } : { value };
		}
		case "editor": {
			const value = await ctx.ui.editor(title, request.prefill);
			return value === undefined ? { cancelled: true } : { value };
		}
		default:
			return { cancelled: true };
	}
}
