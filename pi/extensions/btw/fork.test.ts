import assert from "node:assert/strict";
import test from "node:test";
import { buildSideSession, sessionName } from "./fork.ts";
import { ENTRY_TYPE } from "./guard.ts";

const info = { origin: "/work/repo", root: "/tmp/pi-btw/repo-1", createdAt: "2026-10-12T12:00:00.000Z" };
const now = new Date("2026-10-12T12:00:00.000Z");

const system = { type: "message", id: "s0", parentId: null, message: { role: "system" } };
const user1 = { type: "message", id: "u1", parentId: "s0", message: { role: "user" } };
const asst1 = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant" } };
const compaction = { type: "compaction", id: "c1", parentId: "a1", firstKeptEntryId: "u1", summary: "…" };

function parse(content: string) {
	assert.ok(content.endsWith("\n"));
	return content.trimEnd().split("\n").map((line) => JSON.parse(line));
}

test("forks the branch verbatim and chains the marker and name after its leaf", () => {
	const side = buildSideSession({
		branch: [system, user1, asst1, compaction],
		cwd: "/tmp/pi-btw/repo-1/sub",
		parentSession: "/s/parent.jsonl",
		info,
		name: "btw: why?",
		now,
		sessionId: "abc",
	});
	const [header, ...entries] = parse(side.content);
	assert.equal(side.forked, true);
	assert.equal(side.fileName, "2026-10-12T12-00-00-000Z_abc.jsonl");
	assert.deepEqual(header, {
		type: "session",
		version: 3,
		id: "abc",
		timestamp: now.toISOString(),
		cwd: "/tmp/pi-btw/repo-1/sub",
		parentSession: "/s/parent.jsonl",
	});
	assert.deepEqual(entries.slice(0, 4), [system, user1, asst1, compaction]);
	const [marker, name] = entries.slice(4);
	assert.equal(marker.type, "custom");
	assert.equal(marker.customType, ENTRY_TYPE);
	assert.equal(marker.parentId, "c1");
	assert.deepEqual(marker.data, info);
	assert.deepEqual({ type: name.type, parentId: name.parentId, name: name.name }, {
		type: "session_info",
		parentId: marker.id,
		name: "btw: why?",
	});
	assert.equal(new Set(entries.map((e: { id: string }) => e.id)).size, entries.length);
});

test("starts fresh when the fork point has no user message yet", () => {
	const side = buildSideSession({ branch: [system], cwd: "/c", parentSession: undefined, info, name: "btw", now });
	const [header, marker, name] = parse(side.content);
	assert.equal(side.forked, false);
	assert.equal("parentSession" in header, false);
	assert.equal(marker.parentId, null);
	assert.equal(name.parentId, marker.id);
	assert.equal(buildSideSession({ branch: [], cwd: "/c", parentSession: undefined, info, name: "btw", now }).forked, false);
});

test("sessionName collapses whitespace and truncates", () => {
	assert.equal(sessionName("  "), "btw");
	assert.equal(sessionName("what\n does   X do?"), "btw: what does X do?");
	assert.equal(sessionName("x".repeat(80)), `btw: ${"x".repeat(59)}…`);
});
