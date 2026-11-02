import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { loadProfile, parseProfileFlag } from "./profiles.ts";

// Profiles live outside this extension so any repo can link its own <name>.json in;
// each file is an mcp.json-style {"mcpServers": {...}} object.
const PROFILES_DIR = join(getAgentDir(), "mcp-profiles");

export default function mcpProfilesExtension(pi: ExtensionAPI): void {
	pi.registerFlag("mcp-profile", {
		description: "Add the MCP servers of these comma-separated profiles for this run (files in ~/.pi/agent/mcp-profiles/, e.g. work,local)",
		type: "string",
	});

	// CLI flag values only land after extensions load, so registration waits for the
	// session; re-registering the same config on /new, /resume or fork is a no-op.
	pi.on("session_start", (_event, ctx) => {
		for (const name of parseProfileFlag(pi.getFlag("mcp-profile"))) {
			const profile = loadProfile(PROFILES_DIR, name);
			if ("error" in profile) {
				ctx.ui.notify(profile.error, "error");
				continue;
			}
			for (const [server, config] of Object.entries(profile.servers)) {
				try {
					pi.registerMcpServer(server, config as unknown as McpServerConfig);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`MCP profile "${name}": ${message}`, "error");
				}
			}
		}
	});
}
