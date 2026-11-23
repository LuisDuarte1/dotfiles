import assert from "node:assert/strict";
import test from "node:test";
import { cacheTtlMs, type DeadlineInput, headerDeadline, lastCacheTouch, promptSplit } from "./deadline.ts";

const MODEL = "anthropic/claude-opus-5-5";
const NOW = Date.parse("2026-11-23T11:12:44Z");
const MINUTE = 60_000;

const input = (overrides: Partial<DeadlineInput>): DeadlineInput => ({
  now: NOW,
  model: MODEL,
  contextTokens: 900_000,
  cacheTtlMs: 5 * MINUTE,
  cache: { model: MODEL, at: NOW - MINUTE, promptTokens: 897_000 },
  ...overrides,
});

test("a warm cache prefills only the new tokens, but still budgets reading the cached prefix", () => {
  assert.deepEqual(promptSplit(input({})), { cached: 897_000, uncached: 3_000 });
  assert.deepEqual(headerDeadline(input({})), { ms: 40_200, cached: 897_000, uncached: 3_000 });
});

test("a 725k-token warm prompt gets well past the median 10s cache read", () => {
  const warm = input({ contextTokens: 726_000, cache: { model: MODEL, at: NOW - 10_000, promptTokens: 725_000 } });
  assert.equal(headerDeadline(warm).ms, 34_267);
});

test("an expired cache prefills the whole context", () => {
  const cold = input({ cache: { model: MODEL, at: NOW - 12 * 24 * 60 * MINUTE, promptTokens: 897_365 } });
  assert.deepEqual(headerDeadline(cold), { ms: 100_000, cached: 0, uncached: 900_000 });
});

test("no prior response, or one from another model, counts as cold", () => {
  assert.deepEqual(promptSplit(input({ cache: undefined })), { cached: 0, uncached: 900_000 });
  const other = input({ cache: { model: "openai/gpt-5.6-sol", at: NOW, promptTokens: 897_000 } });
  assert.deepEqual(promptSplit(other), { cached: 0, uncached: 900_000 });
});

test("a header timeout keeps the cache estimate and at least doubles the deadline", () => {
  assert.deepEqual(headerDeadline(input({ timedOutMs: 40_200 })), { ms: 80_400, cached: 897_000, uncached: 3_000 });
  assert.equal(headerDeadline(input({ timedOutMs: 10_000 })).ms, 40_200);
});

test("the deadline never exceeds pi's idle timeout", () => {
  assert.equal(headerDeadline(input({ timedOutMs: 200_000 })).ms, 300_000);
  assert.equal(headerDeadline(input({ cache: undefined, contextTokens: 5_000_000 })).ms, 300_000);
});

test("a context smaller than the cached prompt never goes negative", () => {
  assert.deepEqual(promptSplit(input({ contextTokens: 10_000 })), { cached: 10_000, uncached: 0 });
  assert.equal(headerDeadline(input({ contextTokens: 10_000 })).ms, 10_333);
});

test("cache lifetime follows the retention pi requests", () => {
  const promptCache = { short: 300, long: 3600 };
  assert.equal(cacheTtlMs(promptCache, undefined), 300_000);
  assert.equal(cacheTtlMs(promptCache, "long"), 3_600_000);
  assert.equal(cacheTtlMs({ short: 300 }, "long"), 300_000);
  assert.equal(cacheTtlMs(undefined, undefined), 300_000);
});

test("the last cache touch is the newest successful response with usage", () => {
  const usage = { input: 2, cacheRead: 897_365, cacheWrite: 376 };
  const branch = [
    { type: "message", timestamp: "2026-11-11T15:22:51.379Z", message: { role: "assistant", stopReason: "stop", provider: "anthropic", model: "claude-opus-5-5", usage } },
    { type: "message", timestamp: "2026-11-23T11:12:44.397Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-11-23T11:12:54.485Z", message: { role: "assistant", stopReason: "error", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } },
    { type: "custom_message", timestamp: "2026-11-23T11:12:56.508Z" },
  ];
  assert.deepEqual(lastCacheTouch(branch), { model: MODEL, at: Date.parse("2026-11-11T15:22:51.379Z"), promptTokens: 897_743 });
});

test("a compaction after the last response leaves no cache touch", () => {
  const branch = [
    { type: "message", timestamp: "2026-11-23T11:00:00Z", message: { role: "assistant", stopReason: "stop", usage: { input: 10, cacheRead: 500_000 } } },
    { type: "compaction", timestamp: "2026-11-23T11:01:00Z" },
  ];
  assert.equal(lastCacheTouch(branch), undefined);
});
