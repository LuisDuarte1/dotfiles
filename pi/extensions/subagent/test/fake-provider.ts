// Offline provider for the subagent e2e tests: `fake/parent` delegates to the `subagent`
// tool and `fake/child` follows directives in its task, so no real model is ever called.

import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type Api,
	type ToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
});

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function reply(m: Model<Api>, content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}) {
	const stream = createAssistantMessageEventStream();
	const hasToolCall = content.some((part) => part.type === "toolCall");
	const output: AssistantMessage = {
		role: "assistant",
		content,
		api: m.api,
		provider: m.provider,
		model: m.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: hasToolCall ? "toolUse" : "stop",
		timestamp: Date.now(),
		...extra,
	};
	queueMicrotask(() => {
		const partial: AssistantMessage = { ...output, content: [] };
		stream.push({ type: "start", partial });
		content.forEach((block, contentIndex) => {
			partial.content.push(block);
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial });
				for (const delta of block.text.match(/.{1,8}/gs) ?? []) stream.push({ type: "text_delta", contentIndex, delta, partial });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial });
			} else if (block.type === "thinking") {
				stream.push({ type: "thinking_start", contentIndex, partial });
				stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
			} else if (block.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex, partial });
				stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
			}
		});
		if (output.stopReason === "error") {
			stream.push({ type: "error", reason: "error", error: output });
		} else {
			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
		}
		stream.end();
	});
	return stream;
}

let calls = 0;
let flakes = 0; // per process, so each subagent child fails its first FLAKY request
const call = (name: string, args: JsonObject): ToolCall => ({
	type: "toolCall",
	id: `call_${name}_${++calls}_${Date.now()}`,
	name,
	arguments: args,
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: "Ask the user a yes/no question (test helper).",
		parameters: Type.Object({ question: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const yes = await ctx.ui.confirm("Test question", params.question);
			return { content: [{ type: "text", text: yes ? "answer=yes" : "answer=no" }], details: undefined };
		},
	});

	pi.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "x",
		api: "fake-api",
		models: [model("parent"), model("child"), model("alternate")],
		streamSimple: (m, context) => {
			const messages = context.messages.filter((x) => x.role !== "system") as Message[];
			const users = messages.filter((x) => x.role === "user").map(textOf);
			const results = messages.filter((x) => x.role === "toolResult").map(textOf);
			const task = users[0] ?? "";

			if (m.id === "parent") {
				const lastUser = messages.findLastIndex((x) => x.role === "user");
				const prompt = textOf(messages[lastUser]);
				const answered = messages.slice(lastUser).filter((x) => x.role === "toolResult").map(textOf);
				if (answered.length > 0) return reply(m, [{ type: "text", text: `parent saw: ${answered.at(-1)}` }]);
				const agent = /AGENT=(\S+)/.exec(prompt)?.[1] ?? "tester";
				const override = /MODEL=(\S+)/.exec(prompt)?.[1];
				const context = prompt.includes("BIG") ? "x".repeat(200_000) : undefined;
				const subtask = prompt.replace(/^delegate\s*/, "");
				if (prompt.includes("PARALLEL")) {
					return reply(m, [
						call("subagent", { agent, task: `SLEEP3 left ${subtask}` }),
						call("subagent", { agent, task: `SLEEP3 right ${subtask}` }),
					]);
				}
				return reply(m, [call("subagent", { agent, task: subtask, ...(context ? { context } : {}), ...(override ? { model: override } : {}) })]);
			}

			const flaky = /FLAKY(\d+)/.exec(task)?.[1];
			if (flaky && flakes < Number(flaky)) {
				flakes++;
				return reply(m, [], { stopReason: "error", errorMessage: "fetch failed" });
			}
			const offline = /OFFLINE(\d+)/.exec(task)?.[1];
			if (offline && flakes < Number(offline)) {
				const errors = ["Connection error.: getaddrinfo EAI_AGAIN gateway.example", "terminated: read ECONNRESET", "Request timed out."];
				return reply(m, [], { stopReason: "error", errorMessage: errors[flakes++ % errors.length] });
			}
			if (task.includes("FAIL")) {
				return reply(m, [], { stopReason: "error", errorMessage: "boom from fake child" });
			}
			const sleep = /SLEEP(\d+)/.exec(task)?.[1];
			const wantsConfirm = task.includes("CONFIRM");
			if (results.length === 0 && sleep) {
				return reply(m, [
					{ type: "thinking", thinking: "planning a nap" },
					call("bash", { command: `sleep ${sleep}; echo slept` }),
				]);
			}
			if (wantsConfirm && !results.some((r) => r.startsWith("answer="))) {
				return reply(m, [call("ask", { question: "Proceed?" })]);
			}
			const answer = results.find((r) => r.startsWith("answer="));
			return reply(m, [
				{ type: "text", text: `child done; users=${JSON.stringify(users.slice(1))}${answer ? `; ${answer}` : ""}` },
			]);
		},
	});
}
