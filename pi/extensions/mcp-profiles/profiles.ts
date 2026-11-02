import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Profile names become file names, so anything beyond a bare identifier could
// escape the profiles directory.
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

export type ProfileServers = Record<string, Record<string, unknown>>;
export type ProfileResult = { servers: ProfileServers } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProfileFlag(value: string | boolean | undefined): string[] {
	if (typeof value !== "string") return [];
	return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}

export function listProfiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -".json".length))
		.sort();
}

export function loadProfile(dir: string, name: string): ProfileResult {
	if (!PROFILE_NAME.test(name)) return { error: `Invalid MCP profile name "${name}"` };
	const path = join(dir, `${name}.json`);
	if (!existsSync(path)) {
		const available = listProfiles(dir).join(", ") || "none";
		return { error: `Unknown MCP profile "${name}" (available: ${available})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		return { error: `${path}: expected an object with an "mcpServers" object` };
	}
	for (const [server, config] of Object.entries(parsed.mcpServers)) {
		if (!isRecord(config)) return { error: `${path}: server "${server}" must be an object` };
	}
	return { servers: parsed.mcpServers as ProfileServers };
}
