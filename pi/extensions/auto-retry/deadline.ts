export interface CacheTouch {
  model: string;
  at: number;
  promptTokens: number;
}

export interface DeadlineInput {
  now: number;
  model: string;
  contextTokens: number;
  cacheTtlMs: number;
  cache?: CacheTouch;
  timedOutMs?: number;
}

export interface DeadlineConfig {
  baseMs: number;
  tokensPerSec: number;
  maxMs: number;
}

// 10k tokens/s is slower than 95% of the cold 100k+ token requests in past sessions; the
// 5-minute cap is pi's default httpIdleTimeoutMs, which aborts a silent request anyway.
export const DEFAULT_DEADLINE: DeadlineConfig = { baseMs: 10_000, tokensPerSec: 10_000, maxMs: 300_000 };

const DEFAULT_CACHE_TTL_S = 300;

interface UsageLike {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface MessageLike {
  role?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
  usage?: UsageLike;
}

interface EntryLike {
  type: string;
  timestamp?: string;
  message?: MessageLike;
}

export function modelKey(provider: string | undefined, id: string | undefined): string {
  return `${provider ?? ""}/${id ?? ""}`;
}

// Pi sends long retention only when PI_CACHE_RETENTION=long; a model that declares no lifetime is
// assumed to keep the 5-minute default most providers use.
export function cacheTtlMs(promptCache: { short?: number; long?: number } | undefined, retention: string | undefined): number {
  const short = promptCache?.short ?? DEFAULT_CACHE_TTL_S;
  return (retention === "long" ? (promptCache?.long ?? short) : short) * 1000;
}

export function touchFromMessage(message: MessageLike, at: number): CacheTouch | undefined {
  if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return undefined;
  const usage = message.usage;
  const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  if (promptTokens <= 0 || !Number.isFinite(at)) return undefined;
  return { model: modelKey(message.provider, message.model), at, promptTokens };
}

// A compaction rewrites the prompt prefix, so nothing before it is still in the provider's cache.
// Entry timestamps record when the response finished, which is when its prompt was last cached.
export function lastCacheTouch(branch: readonly EntryLike[]): CacheTouch | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction") return undefined;
    if (entry.type !== "message" || !entry.message || !entry.timestamp) continue;
    const touch = touchFromMessage(entry.message, Date.parse(entry.timestamp));
    if (touch) return touch;
  }
  return undefined;
}

// An aborted prefill most likely wrote no cache, so the retry after a header timeout pays for the
// whole prompt again; a warm cache leaves only what was added since the last response.
export function uncachedTokens(input: DeadlineInput): number {
  const { cache } = input;
  const warm =
    input.timedOutMs === undefined &&
    cache !== undefined &&
    cache.model === input.model &&
    input.now - cache.at < input.cacheTtlMs;
  return warm ? Math.max(0, input.contextTokens - cache.promptTokens) : input.contextTokens;
}

// Headers arrive only after prefill, so the deadline grows with the tokens left to prefill, and
// each further timeout at least doubles it in case the rate estimate was too optimistic.
export function headerDeadline(input: DeadlineInput, config: DeadlineConfig = DEFAULT_DEADLINE): { ms: number; uncached: number } {
  const uncached = uncachedTokens(input);
  let ms = config.baseMs + (uncached / config.tokensPerSec) * 1000;
  if (input.timedOutMs !== undefined) ms = Math.max(ms, input.timedOutMs * 2);
  return { ms: Math.round(Math.min(ms, config.maxMs)), uncached };
}
