import type { TSchema } from "typebox";
import type { RpcChannel, RpcChildOptions } from "./rpc.ts";

// Other extensions add ways to run a subagent (e.g. in a remote container) by answering this
// event at session start; the tool then gains each transport's optional parameter.
export const SUBAGENT_TRANSPORTS_EVENT = "subagent:transports";

export interface ChildSpec {
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt?: string;
}

export interface SubagentTransport {
	param: string;
	schema: TSchema;
	label(value: unknown, agent: string | undefined): string;
	createChild(options: RpcChildOptions, value: unknown, spec: ChildSpec): RpcChannel;
	durable?: boolean;
}

export interface TransportRegistry {
	register(transport: SubagentTransport): void;
}

const RESERVED = new Set(["task", "agent", "model", "context"]);

export function collectTransports(events: { emit(channel: string, data: unknown): void }): SubagentTransport[] {
	const transports: SubagentTransport[] = [];
	const registry: TransportRegistry = {
		register(transport) {
			if (RESERVED.has(transport.param)) throw new Error(`subagent transport param "${transport.param}" is reserved`);
			if (!transports.some((t) => t.param === transport.param)) transports.push(transport);
		},
	};
	events.emit(SUBAGENT_TRANSPORTS_EVENT, registry);
	return transports;
}
