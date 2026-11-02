import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

// Valid pi thinking levels per `pi --help`.
// Anything outside this set is dropped so we don't pass garbage to the subprocess.
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeThinking(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const level = value.trim().toLowerCase();
	return THINKING_LEVELS.has(level) ? level : undefined;
}

// Opencode → pi tool-name aliases.
// Lets opencode-style frontmatter work without manual translation; unknown tools get filtered out by pi anyway.
const TOOL_ALIASES: Record<string, string> = {
	glob: "find",
	list: "ls",
	task: "subagent",
};

function normalizeTools(value: unknown): string[] | undefined {
	const collect = (raw: string[]): string[] | undefined => {
		const out: string[] = [];
		const seen = new Set<string>();
		for (const item of raw) {
			const name = (TOOL_ALIASES[item] ?? item).trim();
			if (name && !seen.has(name)) {
				seen.add(name);
				out.push(name);
			}
		}
		return out.length ? out : undefined;
	};

	if (!value) return undefined;
	if (typeof value === "string") {
		return collect(value.split(",").map((t) => t.trim()).filter(Boolean));
	}
	if (Array.isArray(value)) {
		return collect(value.map((t) => String(t).trim()).filter(Boolean));
	}
	if (typeof value === "object") {
		const enabled = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v === true || v === "true")
			.map(([k]) => k.trim())
			.filter(Boolean);
		return collect(enabled);
	}
	return undefined;
}

// Preserve provider-qualified model references so duplicate IDs do not resolve
// ambiguously across providers that serve the same model (e.g. an API and a proxy).
function normalizeModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
		if (!description) continue;
		const explicitName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const name = explicitName || entry.name.replace(/\.md$/, "");
		agents.push({
			name,
			description,
			model: normalizeModel(frontmatter.model),
			thinking: normalizeThinking(frontmatter.thinking),
			tools: normalizeTools(frontmatter.tools),
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not a directory or doesn't exist; keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function discoverAgents(cwd: string): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);
	const map = new Map<string, AgentConfig>();
	for (const a of loadAgentsFromDir(userDir, "user")) map.set(a.name, a);
	if (projectDir) {
		for (const a of loadAgentsFromDir(projectDir, "project")) map.set(a.name, a);
	}
	return Array.from(map.values());
}
