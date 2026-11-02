import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Override the built-in `bash` tool to make `timeout` a required parameter.
// All other behavior (renderer, streaming, truncation, etc.) is delegated unchanged.

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Number({ description: "Timeout in seconds (required, must be > 0)" }),
});

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	// Rewrite the trailing "Optionally provide a timeout..." sentence so the LLM
	// sees that timeout is now mandatory. The rest of the description is kept verbatim.
	const description = (bashTool.description ?? "").replace(
		/Optionally provide a timeout in seconds\.?$/,
		"You must provide a timeout in seconds.",
	);

	pi.registerTool({
		...bashTool,
		parameters: bashSchema,
		description,
		execute: (id, params, signal, onUpdate) =>
			bashTool.execute(id, params, signal, onUpdate),
	});
}
