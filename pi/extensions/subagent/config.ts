import * as fs from "node:fs";

// Fable parents must not delegate onto pricier Fable models, but other agent
// pins (e.g. security-review on Opus 4.8) are deliberate and must survive.
const FABLE_MODEL_IDS = new Set(["claude-fable-5", "claude-fable-5-1"]);
export const DEFAULT_SUBAGENT_MODEL = "anthropic/claude-opus-5-5";

export interface SubagentConfig {
	defaultModel?: string;
	agentModels: Record<string, string>;
}

export function isFableModel(ref: string | undefined): boolean {
	return ref ? FABLE_MODEL_IDS.has(ref.slice(ref.lastIndexOf("/") + 1)) : false;
}

function stringRecord(value: unknown, where: string): Record<string, string> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
	for (const [key, model] of Object.entries(value)) {
		if (typeof model !== "string" || !model.trim()) throw new Error(`${where}.${key} must be a provider/model-id string`);
	}
	return value as Record<string, string>;
}

// ~/.pi/agent/subagent.json lets an overlay repin models (e.g. onto another provider) without
// editing agent files. A broken file fails the call rather than silently running another model.
export function loadConfig(file: string): SubagentConfig {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return { agentModels: {} };
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${file}: ${(error as Error).message}`);
	}
	const defaultModel = parsed.defaultModel;
	if (defaultModel !== undefined && (typeof defaultModel !== "string" || !defaultModel.trim())) {
		throw new Error(`${file}: defaultModel must be a provider/model-id string`);
	}
	return { defaultModel, agentModels: stringRecord(parsed.agentModels, `${file}: agentModels`) };
}

export function resolveSubagentModel(input: {
	override?: string;
	agent?: { name: string; model?: string };
	parentModelId?: string;
	config: SubagentConfig;
}): string {
	const fallback = input.config.defaultModel ?? DEFAULT_SUBAGENT_MODEL;
	const pinned = input.agent ? (input.config.agentModels[input.agent.name] ?? input.agent.model) : undefined;
	const requested = input.override ?? pinned;
	if (!requested) return fallback;
	return isFableModel(input.parentModelId) && isFableModel(requested) ? fallback : requested;
}
