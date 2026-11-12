import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { isContextOverflow } from "@earendil-works/pi-ai";

// Drop-in replacement for pi's built-in auto-retry. Retries indefinitely with
// capped exponential backoff (default 2s..2min) on all transient provider errors.

// Requires `retry.enabled: false` in settings.json so pi's built-in retry
// (uncapped exponential, max 3 attempts) does not race with this extension.

// Mirror of pi's _isRetryableError regex (overloaded, rate-limit, 5xx, network,
// websocket, fetch-failed, timeout, etc.) plus Anthropic/OpenAI SSE stream-cutoff variants.
const TRANSIENT_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay|stream ended before message_stop|stream ended before content_block_stop|stream ended before a terminal response event|stream ended unexpectedly|unexpected end of stream|premature close/i;

// Backoff config. attempt N delay = min(BASE * 2^(N-1), MAX). Infinite attempts.
// 2s, 4s, 8s, 16s, 32s, 64s, 120s, 120s, ... — caps at 2 min as requested.
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 120_000;

// The Anthropic SSE "stream ended before message_stop" cutoff retries on a flat
// 2s backoff plus up to +3s of random jitter, ignoring the attempt count.
const STREAM_STOP_PATTERN = /stream ended before message_stop/i;
const STREAM_STOP_BASE_MS = 2_000;
const STREAM_STOP_JITTER_MS = 3_000;

// This machine's own network failing (DNS, no route, resets) says nothing about provider load, so
// these retry on the flat base delay and pick up again as soon as the link is back.
const LOCAL_NETWORK_PATTERN =
  /\b(EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL|ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT)\b/;

// A dead connection otherwise hangs until pi's 5-minute idle timeout. Headers arrive only after
// prefill, so each consecutive header timeout adds 10s to the deadline, up to 30s.
const HEADERS_TIMEOUT_MS = Number(process.env.PI_AUTO_RETRY_HEADERS_TIMEOUT_MS) || 10_000;
const MAX_HEADERS_TIMEOUT_MS = 30_000;

const RETRY_CUSTOM_TYPE = "auto-retry-kick";
const STATUS_KEY = "auto-retry";
const WIDGET_KEY = "auto-retry";

// Other extensions hook retries over pi.events: a `scheduled` listener may call waitFor() so the
// retry request waits for its work (e.g. fetching a header value) after the backoff elapses.
export const AUTO_RETRY_SCHEDULED = "auto-retry:scheduled";
export const AUTO_RETRY_RETRYING = "auto-retry:retrying";
export const AUTO_RETRY_RESET = "auto-retry:reset";

export interface AutoRetryScheduled {
  attempt: number;
  delayMs: number;
  error: string;
  provider: string | undefined;
  modelId: string | undefined;
  ctx: ExtensionContext;
  waitFor(work: Promise<unknown>): void;
}

export interface AutoRetryEvent {
  attempt: number;
  ctx: ExtensionContext;
}

function computeDelayMs(attempt: number, errorMessage: string): number {
  if (LOCAL_NETWORK_PATTERN.test(errorMessage)) return BASE_DELAY_MS;
  // Flat 2s + jitter (0..3s) for the message_stop cutoff, regardless of attempt.
  if (STREAM_STOP_PATTERN.test(errorMessage)) {
    return STREAM_STOP_BASE_MS + Math.floor(Math.random() * STREAM_STOP_JITTER_MS);
  }
  // attempt is 1-indexed (first retry is attempt=1).
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(exp, MAX_DELAY_MS);
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

interface HeaderDeadline {
  baseUrl: string;
  ms: number;
  onTimeout(): void;
  onHeaders(): void;
}

// SDK clients capture globalThis.fetch when built and /reload re-runs the factory, so fetch is
// wrapped once per process and serves whichever instance armed the next provider request.
const SLOT = Symbol.for("pi.auto-retry.header-deadline");

function headerDeadlineSlot(): { armed?: HeaderDeadline } {
  const g = globalThis as typeof globalThis & { [SLOT]?: { armed?: HeaderDeadline } };
  if (g[SLOT]) return g[SLOT];
  const slot: { armed?: HeaderDeadline } = {};
  g[SLOT] = slot;
  const inner = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const deadline = slot.armed;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!deadline || !url.startsWith(deadline.baseUrl)) return inner(input, init);
    slot.armed = undefined;
    const timer = new AbortController();
    const outer = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const id = setTimeout(() => {
      deadline.onTimeout();
      timer.abort(new Error(`no response headers within ${fmtSeconds(deadline.ms)} (timed out)`));
    }, deadline.ms);
    const signal = outer ? AbortSignal.any([outer, timer.signal]) : timer.signal;
    return inner(input, { ...init, signal }).then(
      (response) => {
        clearTimeout(id);
        deadline.onHeaders();
        return response;
      },
      (error: unknown) => {
        clearTimeout(id);
        throw error;
      },
    );
  };
  return slot;
}

// Decide whether this failed assistant message should be auto-retried.
// Mirrors pi's gating: error + matches transient regex + NOT a context overflow.
function isRetryable(message: {
  stopReason?: string;
  errorMessage?: string;
  usage?: { input: number; cacheRead: number };
}, contextWindow?: number): boolean {
  if (message.stopReason !== "error") return false;
  if (!message.errorMessage) return false;
  // Context overflow needs compaction, not retry — never loop on it.
  if (isContextOverflow(message as any, contextWindow)) return false;
  return TRANSIENT_PATTERN.test(message.errorMessage) || LOCAL_NETWORK_PATTERN.test(message.errorMessage);
}

interface RetryState {
  attempt: number;
  lastError: string;
  pending: boolean;
  wake: ((proceed: boolean) => void) | null;
}

// pi emits no event when a message is queued mid-run, so a prompt typed during
// the backoff is noticed by polling instead.
const QUEUE_POLL_MS = 250;


export default function (pi: ExtensionAPI) {
  let state: RetryState | null = null;
  const headerSlot = headerDeadlineSlot();
  let headerTimeouts = 0;
  let headerTimeoutMs: number | undefined;

  pi.on("before_provider_request", (_event, ctx) => {
    const baseUrl = ctx.model?.baseUrl;
    if (!baseUrl) return;
    const ms = Math.min(HEADERS_TIMEOUT_MS * (headerTimeouts + 1), MAX_HEADERS_TIMEOUT_MS);
    headerSlot.armed = {
      baseUrl,
      ms,
      onTimeout: () => {
        headerTimeouts += 1;
        headerTimeoutMs = ms;
      },
      onHeaders: () => {
        headerTimeouts = 0;
      },
    };
  });

  const resetUi = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const fullReset = (ctx: ExtensionContext) => {
    const s = state;
    s?.wake?.(false);
    state = null;
    headerTimeouts = 0;
    resetUi(ctx);
    if (s) pi.events.emit(AUTO_RETRY_RESET, { attempt: s.attempt, ctx } satisfies AutoRetryEvent);
  };

  // Resolves true once the delay elapses or the user queues a message (retry now),
  // false when fullReset cancels the chain.
  const backoff = (s: RetryState, ms: number, hasQueued: () => boolean) =>
    new Promise<boolean>((resolve) => {
      const finish = (proceed: boolean) => {
        clearTimeout(timer);
        clearInterval(poll);
        s.wake = null;
        resolve(proceed);
      };
      const timer = setTimeout(() => finish(true), ms);
      const poll = setInterval(() => hasQueued() && finish(true), QUEUE_POLL_MS);
      s.wake = finish;
    });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    headerSlot.armed = undefined; // a WebSocket request never consumes it
    const timedOutAfterMs = headerTimeoutMs;
    headerTimeoutMs = undefined;

    // Successful assistant turn after one or more retries → announce recovery.
    // Any stopReason other than "error" counts as success (stop, toolUse, etc.).
    if (event.message.stopReason !== "error") {
      if (state) {
        const n = state.attempt;
        ctx.ui.notify(
          `Recovered after ${n} retr${n === 1 ? "y" : "ies"}.`,
          "success",
        );
        fullReset(ctx);
      }
      return;
    }

    const errorMessage = event.message.errorMessage ?? "";
    const contextWindow = ctx.model?.contextWindow;
    if (!isRetryable(event.message as any, contextWindow)) {
      if (state) {
        ctx.ui.notify(
          `Stopping auto-retry: error is not transient (${errorMessage || "unknown"}).`,
          "error",
        );
        fullReset(ctx);
      }
      return;
    }

    if (!state) {
      state = { attempt: 0, lastError: "", pending: false, wake: null };
    }
    state.attempt += 1;
    state.lastError = timedOutAfterMs ? `no response headers within ${fmtSeconds(timedOutAfterMs)}` : errorMessage;
    state.pending = true;
  });

  // Waiting inside the run, not on a detached timer, keeps agent_settled from
  // firing early; RPC hosts such as the subagent tool exit on it and kill the retry.
  pi.on("agent_before_settle", async (event, ctx) => {
    const s = state;
    if (!s?.pending) return;
    s.pending = false;

    const delayMs = computeDelayMs(s.attempt, s.lastError);
    const capped = delayMs >= MAX_DELAY_MS;

    const waits: Promise<unknown>[] = [];
    pi.events.emit(AUTO_RETRY_SCHEDULED, {
      attempt: s.attempt,
      delayMs,
      error: s.lastError,
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      ctx,
      waitFor: (work) => waits.push(work),
    } satisfies AutoRetryScheduled);

    ctx.ui.notify(
      `Transient error: ${s.lastError}. Retrying in ${fmtSeconds(delayMs)} (attempt ${s.attempt}${capped ? ", capped" : ""}).`,
      "warning",
    );
    ctx.ui.setStatus(
      STATUS_KEY,
      `↻ retry #${s.attempt} in ${fmtSeconds(delayMs)}${capped ? " (capped)" : ""}`,
    );
    ctx.ui.setWidget(WIDGET_KEY, [
      `↻ Transient provider error — auto-retry`,
      `   attempt ${s.attempt} · waiting ${fmtSeconds(delayMs)}${capped ? " (max)" : ""} · ${s.lastError}`,
    ]);

    if (!(await backoff(s, delayMs, () => ctx.hasPendingMessages())) || state !== s) return;

    if (waits.length > 0) {
      await Promise.allSettled(waits);
      if (state !== s) return;
    }

    ctx.ui.setStatus(
      STATUS_KEY,
      `↻ retrying… (#${s.attempt})`,
    );
    ctx.ui.setWidget(WIDGET_KEY, [
      `↻ Transient provider error — retrying`,
      `   attempt ${s.attempt} · ${s.lastError}`,
    ]);
    pi.events.emit(AUTO_RETRY_RETRYING, { attempt: s.attempt, ctx } satisfies AutoRetryEvent);

    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: RETRY_CUSTOM_TYPE,
          content: "",
          display: false,
          details: {
            attempt: s.attempt,
            lastError: s.lastError,
          },
        },
      ],
      continue: true,
    };
  });

  // Strip our retry-kick and our failed assistant messages from LLM context so
  // the model sees a clean conversation, exactly like pi's built-in retry does.
  pi.on("context", async (event, ctx) => {
    const contextWindow = ctx.model?.contextWindow;
    const messages = event.messages.filter((m) => {
      if (m.role === "custom" && (m as { customType?: string }).customType === RETRY_CUSTOM_TYPE) {
        return false;
      }
      if (m.role === "assistant" && isRetryable(m as any, contextWindow)) return false;
      return true;
    });
    return { messages };
  });

  // A chain left over from an aborted run must not leak into the next prompt's
  // recovery notice, nor into the state of extensions hooked on its events.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (state) fullReset(ctx);
  });

  // Consume Esc only while a backoff is pending; otherwise return undefined so
  // pi's normal Esc handling (abort, autocomplete dismiss, ...) still runs.
  let unsubscribeInput: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (!state?.wake) return undefined;
      if (!matchesKey(data, "escape")) return undefined;
      ctx.ui.notify("Auto-retry cancelled.", "info");
      fullReset(ctx);
      return { consume: true };
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribeInput?.();
    unsubscribeInput = null;
    fullReset(ctx);
  });
}
