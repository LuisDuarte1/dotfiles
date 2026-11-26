// Transports for the subagent e2e tests: the child still runs locally, but through the transport
// hooks, so defaults, named follow-ups and footers are checked offline.

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RpcChild } from "../rpc.ts";
import { SUBAGENT_TRANSPORTS_EVENT, type TransportRegistry } from "../transport.ts";

interface Value {
	ws: string;
	run: number;
	from?: number;
}

export default function (pi: ExtensionAPI) {
	pi.events.on(SUBAGENT_TRANSPORTS_EVENT, (data) => {
		const registry = data as TransportRegistry;
		registry.register({
			param: "remote",
			schema: Type.Object({ ws: Type.Optional(Type.String()) }),
			label: (value, agent) => `${agent ?? "subagent"} @${(value as Value).ws}`,
			resolve(value, { cwd, prior }) {
				const ws = (value as { ws?: string } | undefined)?.ws;
				if (!prior) return { ws: ws ?? path.basename(cwd), run: 1 };
				const last = prior.value as Value;
				if (ws && ws !== last.ws) throw new Error(`runs in ${last.ws}, not ${ws}`);
				return { ws: last.ws, run: last.run + 1, ...(prior.continues ? { from: last.run } : {}) };
			},
			describe: (value) => `run ${(value as Value).run} in ${(value as Value).ws}`,
			createChild: (options) => new RpcChild(options),
		});
		registry.register({
			param: "plain",
			schema: Type.Object({}),
			label: (_value, agent) => agent ?? "subagent",
			createChild: (options) => new RpcChild(options),
		});
	});
}
