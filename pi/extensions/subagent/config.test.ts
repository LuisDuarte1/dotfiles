import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SUBAGENT_MODEL, loadConfig, resolveSubagentModel } from "./config.ts";
import { collectTransports, SUBAGENT_TRANSPORTS_EVENT, type TransportRegistry } from "./transport.ts";

const none = { agentModels: {} };

function configFile(content: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "subagent-config-")), "subagent.json");
	writeFileSync(file, content);
	return file;
}

test("a missing config file means no overrides", () => {
	assert.deepEqual(loadConfig("/nonexistent/subagent.json"), none);
});

test("a broken config fails instead of silently picking another model", () => {
	assert.throws(() => loadConfig(configFile("{")), /subagent\.json/);
	assert.throws(() => loadConfig(configFile('{"agentModels":{"x":1}}')), /agentModels\.x/);
	assert.throws(() => loadConfig(configFile('{"defaultModel":""}')), /defaultModel/);
});

test("precedence: call override, then config pin, then agent frontmatter, then default", () => {
	const config = loadConfig(configFile('{"defaultModel":"p/default","agentModels":{"sec":"p/pinned"}}'));
	const sec = { name: "sec", model: "p/frontmatter" };
	assert.equal(resolveSubagentModel({ override: "p/call", agent: sec, config }), "p/call");
	assert.equal(resolveSubagentModel({ agent: sec, config }), "p/pinned");
	assert.equal(resolveSubagentModel({ agent: { name: "other", model: "p/frontmatter" }, config }), "p/frontmatter");
	assert.equal(resolveSubagentModel({ agent: { name: "other" }, config }), "p/default");
	assert.equal(resolveSubagentModel({ config: none }), DEFAULT_SUBAGENT_MODEL);
});

test("a Fable parent never delegates onto a Fable model", () => {
	const input = { override: "x/claude-fable-5-1", config: none };
	assert.equal(resolveSubagentModel({ ...input, parentModelId: "claude-fable-5" }), DEFAULT_SUBAGENT_MODEL);
	assert.equal(resolveSubagentModel({ ...input, parentModelId: "claude-opus-5-5" }), "x/claude-fable-5-1");
});

test("transports answer the collection event; reserved and duplicate params are dropped", () => {
	const listeners: ((data: unknown) => void)[] = [];
	const events = { emit: (channel: string, data: unknown) => channel === SUBAGENT_TRANSPORTS_EVENT && listeners.forEach((l) => l(data)) };
	const transport = (param: string) => ({ param, schema: {} as never, label: () => "", createChild: () => ({}) as never });
	listeners.push((r) => (r as TransportRegistry).register(transport("remote")));
	listeners.push((r) => (r as TransportRegistry).register(transport("remote")));
	listeners.push((r) => assert.throws(() => (r as TransportRegistry).register(transport("task")), /reserved/));
	assert.deepEqual(collectTransports(events).map((t) => t.param), ["remote"]);
});
