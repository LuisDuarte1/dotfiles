import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listProfiles, loadProfile, parseProfileFlag } from "./profiles.ts";

function profilesDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-profiles-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

test("parses comma-separated profiles, trimming and deduplicating", () => {
	assert.deepEqual(parseProfileFlag(" work, local,,work "), ["work", "local"]);
});

test("treats a missing or boolean flag as no profiles", () => {
	assert.deepEqual(parseProfileFlag(undefined), []);
	assert.deepEqual(parseProfileFlag(true), []);
	assert.deepEqual(parseProfileFlag(""), []);
});

test("loads the servers of a profile", () => {
	const dir = profilesDir({ "a.json": '{"mcpServers":{"x":{"url":"https://x.example/mcp"}}}' });
	assert.deepEqual(loadProfile(dir, "a"), { servers: { x: { url: "https://x.example/mcp" } } });
});

test("names the available profiles when one is unknown", () => {
	const dir = profilesDir({ "b.json": '{"mcpServers":{}}', "a.json": '{"mcpServers":{}}', "notes.md": "" });
	assert.deepEqual(loadProfile(dir, "nope"), { error: 'Unknown MCP profile "nope" (available: a, b)' });
});

test("rejects names that could leave the profiles directory", () => {
	assert.deepEqual(loadProfile(profilesDir({}), "../mcp"), { error: 'Invalid MCP profile name "../mcp"' });
});

test("reports malformed profile files", () => {
	const dir = profilesDir({
		"bad.json": "{",
		"flat.json": '{"x":{"url":"https://x.example/mcp"}}',
		"scalar.json": '{"mcpServers":{"x":"https://x.example/mcp"}}',
	});
	assert.match((loadProfile(dir, "bad") as { error: string }).error, /bad\.json: /);
	assert.match((loadProfile(dir, "flat") as { error: string }).error, /expected an object with an "mcpServers" object/);
	assert.match((loadProfile(dir, "scalar") as { error: string }).error, /server "x" must be an object/);
});

test("a missing profiles dir lists nothing and names no profile", () => {
	assert.deepEqual(listProfiles("/nonexistent/mcp-profiles"), []);
	assert.deepEqual(loadProfile("/nonexistent/mcp-profiles", "x"), { error: 'Unknown MCP profile "x" (available: none)' });
});
