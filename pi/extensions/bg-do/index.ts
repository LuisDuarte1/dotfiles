// bg_do — xonsh code-mode tool for background-job orchestration. A persistent
// xonsh REPL (per session) runs agent code against an injected `bg` API.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Resolve sibling files relative to this module (works through the symlinked
// extensions dir). The engine is run by xonsh; USAGE.md is referenced for agents.
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = readFileSync(join(HERE, "bg_engine.xsh"), "utf8");
const USAGE_PATH = join(HERE, "USAGE.md");

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const READY_TIMEOUT_MS = 20000;

interface Frame {
	ready?: boolean;
	pid?: number;
	out?: string;
	err?: string | null;
}

// Models routinely send the bash tool's `timeout` (often as a string) instead of
// `timeout_seconds`; accept both and reject bad/oversized values loudly.
function resolveTimeoutS(params: Record<string, unknown>): number {
	const raw = params.timeout_seconds ?? params.timeout;
	if (raw === undefined || raw === null || raw === "") return DEFAULT_TIMEOUT_S;
	const n = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`invalid timeout_seconds: ${JSON.stringify(raw)} (expected 1..${MAX_TIMEOUT_S} seconds)`);
	}
	if (n > MAX_TIMEOUT_S) {
		throw new Error(
			`timeout_seconds=${n} exceeds the ${MAX_TIMEOUT_S}s cap. Do not wait that long inside one snippet: ` +
				`start the job in this call, return the job id, and poll it (bg.wait_for/bg.output) in later bg_do calls.`,
		);
	}
	return Math.max(1, n);
}

export default function bgDo(pi: ExtensionAPI) {
	let proc: ChildProcess | null = null;
	let conn: Socket | null = null;
	let ready: Promise<void> | null = null;
	let sockPath: string | null = null;
	let enginePid: number | undefined;
	let rxBuf = "";
	let pending: ((frame: Frame) => void) | null = null;
	let chain: Promise<{ out: string; err: string | null }> = Promise.resolve({ out: "", err: null });

	const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	function sessionKey(ctx: ExtensionContext): string {
		let id = "default";
		try {
			id = ctx.sessionManager.getSessionId() || "default";
		} catch {}
		return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "default";
	}

	// Signal the engine's process group (by spawned handle, or by the pid learned
	// in the ready handshake after a reattach).
	function sigEngine(sig: NodeJS.Signals) {
		const pid = proc?.pid ?? enginePid;
		if (!pid) return;
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				process.kill(pid, sig);
			} catch {}
		}
	}

	// A force-killed engine loses its job registry, so read the sidecar it appends to
	// and name the processes that outlived it instead of leaving the agent blind.
	function orphanJobs(): string {
		if (!sockPath) return "";
		const alive: string[] = [];
		try {
			for (const line of readFileSync(`${sockPath}.jobs`, "utf8").split("\n")) {
				if (!line.trim()) continue;
				const j = JSON.parse(line) as { id: string; pid: number; log: string };
				try {
					process.kill(j.pid, 0);
				} catch {
					continue;
				}
				alive.push(`${j.id} pid ${j.pid} log ${j.log}`);
			}
		} catch {
			return "";
		}
		if (!alive.length) return "";
		return ` Jobs that outlived it — tail their logs, kill with \`kill -- -<pid>\`: ${alive.join("; ")}.`;
	}

	function dropClient() {
		try {
			conn?.destroy();
		} catch {}
		conn = null;
		ready = null;
		rxBuf = "";
		const p = pending;
		pending = null;
		if (p) p({ err: `bg_do connection dropped${orphanJobs()}` });
	}

	// Parse framed messages on a connected socket. `onReady` fires on the ready
	// handshake (carrying the engine pid); other frames resolve the pending call.
	function attach(socket: Socket, onReady: (pid?: number) => void) {
		conn = socket;
		rxBuf = "";
		socket.setEncoding("utf8");
		socket.on("data", (d: string) => {
			rxBuf += d;
			let idx = rxBuf.indexOf("\n");
			while (idx >= 0) {
				const line = rxBuf.slice(0, idx);
				rxBuf = rxBuf.slice(idx + 1);
				if (line.trim()) {
					let frame: Frame | null = null;
					try {
						frame = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as Frame;
					} catch {
						frame = null;
					}
					if (frame?.ready) {
						onReady(frame.pid);
					} else if (frame) {
						const p = pending;
						pending = null;
						if (p) p(frame);
					}
				}
				idx = rxBuf.indexOf("\n");
			}
		});
		socket.on("close", () => {
			if (conn === socket) {
				conn = null;
				ready = null;
			}
			const p = pending;
			pending = null;
			if (p) p({ err: `bg_do engine connection closed, so its job ids are gone.${orphanJobs()}` });
		});
		socket.on("error", () => {});
	}

	function connectClient(path: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = netConnect(path);
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(new Error("connect timeout"));
			}, timeoutMs);
			socket.once("error", (e) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(e);
			});
			socket.once("connect", () => {
				attach(socket, (pid) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (pid) enginePid = pid;
					resolve();
				});
			});
		});
	}

	// Reattach to an already-running engine (survives /reload) or spawn a fresh
	// detached one. Lazy + reused; on failure `ready` resets so the next call retries.
	function start(ctx: ExtensionContext): Promise<void> {
		if (ready) return ready;
		const p = (async () => {
			const key = sessionKey(ctx);
			const base = join(tmpdir(), `bgdo-${key}`);
			sockPath = `${base}.sock`;
			const enginePath = `${base}.xsh`;
			const logPath = `${base}.log`;

			try {
				await connectClient(sockPath, 2500);
				return;
			} catch {}

			writeFileSync(enginePath, ENGINE_SRC);
			let logFd: number | undefined;
			try {
				logFd = openSync(logPath, "a");
			} catch {}
			proc = spawn("xonsh", ["--no-rc", enginePath], {
				cwd: ctx.cwd,
				env: { ...process.env, BG_DO_SOCK: sockPath },
				detached: true,
				stdio: ["ignore", "ignore", logFd ?? "ignore"],
			});
			proc.on("error", () => {});
			proc.unref();

			const deadline = Date.now() + READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				try {
					await connectClient(sockPath, 2000);
					return;
				} catch {
					await delay(150);
				}
			}
			let tail = "";
			try {
				tail = readFileSync(logPath, "utf8").slice(-800);
			} catch {}
			const hint = tail ? "\n" + tail : "";
			throw new Error("xonsh engine did not start (is xonsh installed and on PATH?)" + hint);
		})();
		ready = p;
		p.catch(() => {
			if (ready === p) ready = null;
		});
		return p;
	}

	// Send one snippet, serialized behind any in-flight call. On timeout, SIGINT
	// interrupts the snippet; a hard deadline force-restarts a wedged engine.
	function sendCode(
		code: string,
		timeoutMs: number,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ out: string; err: string | null }> {
		const task = () =>
			start(ctx).then(
				() =>
					new Promise<{ out: string; err: string | null }>((resolve, reject) => {
						if (!conn) return reject(new Error("no xonsh connection"));
						let done = false;
						const t1 = setTimeout(() => sigEngine("SIGINT"), timeoutMs);
						const t2 = setTimeout(() => {
							if (done) return;
							done = true;
							pending = null;
							sigEngine("SIGKILL");
							dropClient();
							proc = null;
							enginePid = undefined;
							reject(
								new Error(
									`bg_do timed out after ${Math.round(timeoutMs / 1000)}s; engine restarted, so job ids are gone.${orphanJobs()}`,
								),
							);
						}, timeoutMs + 5000);
						const onAbort = () => sigEngine("SIGINT");
						signal?.addEventListener("abort", onAbort, { once: true });
						pending = (frame: Frame) => {
							if (done) return;
							done = true;
							clearTimeout(t1);
							clearTimeout(t2);
							signal?.removeEventListener("abort", onAbort);
							resolve({ out: frame.out ?? "", err: frame.err ?? null });
						};
						conn.write(`${Buffer.from(JSON.stringify({ code }), "utf8").toString("base64")}\n`);
					}),
			);
		chain = chain.then(task, task);
		return chain;
	}

	// Reload keeps the engine (and its jobs) alive — just detach. Any other reason
	// (quit/new/resume/fork) tells the engine to kill its jobs and exit.
	async function cleanup(reason?: string) {
		if (reason === "reload") {
			try {
				conn?.destroy();
			} catch {}
			conn = null;
			ready = null;
			proc = null;
			rxBuf = "";
			pending = null;
			return;
		}
		try {
			conn?.write(`${Buffer.from(JSON.stringify({ shutdown: true }), "utf8").toString("base64")}\n`);
		} catch {}
		await delay(200);
		sigEngine("SIGKILL");
		try {
			conn?.destroy();
		} catch {}
		conn = null;
		ready = null;
		proc = null;
		enginePid = undefined;
		rxBuf = "";
		pending = null;
		try {
			if (sockPath) unlinkSync(`${sockPath}.jobs`);
		} catch {}
	}

	function truncateOut(text: string): string {
		const t = truncateTail(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		if (!t.truncated) return text;
		return `${t.content}\n[output truncated: ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}]`;
	}

	pi.registerTool({
		name: "bg_do",
		label: "Background Do",
		description: [
			"LONG-RUNNING / non-terminating commands only (servers, watchers, `tail -f`, builds): xonsh",
			"code-mode with an injected `bg` API. One-shot commands: use the `bash` tool.",
			`Full usage + API, read first: ${USAGE_PATH}`,
		].join("\n"),
		promptSnippet: "Background long-running commands (`bg` API).",
		parameters: Type.Object({
			code: Type.String({
				description: "xonsh code (`bg` API in scope); see USAGE.md",
			}),
			timeout_seconds: Type.Optional(
				Type.Number({
					description: `Max wall-clock seconds for the snippet (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Exceeding the max is an error, not a clamp — poll across calls instead.`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const timeoutMs = resolveTimeoutS(params as unknown as Record<string, unknown>) * 1000;
			const { out, err } = await sendCode(params.code, timeoutMs, ctx, signal);
			if (err) {
				// Make the interrupt self-explanatory: the snippet was cut, the jobs were not.
				const detail =
					err.trim() === "Interrupted (timeout)"
						? `Interrupted: snippet hit the ${Math.round(timeoutMs / 1000)}s bg_do timeout. Background jobs are still running — poll them (bg.list/bg.output/bg.wait_for) in another call, and pass timeout_seconds to wait longer.`
						: err;
				const combined = (out ? `${out}\n` : "") + detail;
				throw new Error(truncateOut(combined));
			}
			const text = out.trim() ? truncateOut(out) : "(bg_do completed with no output)";
			return { content: [{ type: "text", text }], details: {} };
		},
		renderCall(args, theme, context) {
			// Show the whole snippet, not just the first line. Collapsed view caps at
			// COLLAPSED_MAX lines with a hint; ctrl+e (expanded) shows everything.
			const lines = (args.code ?? "").toString().split("\n");
			while (lines.length && lines[0].trim() === "") lines.shift();
			while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

			let title = theme.fg("toolTitle", theme.bold("bg_do"));
			if (lines.length === 0) return new Text(title, 0, 0);
			if (lines.length > 1) title += theme.fg("dim", ` (${lines.length} lines)`);

			const COLLAPSED_MAX = 15;
			const showAll = context.expanded || lines.length <= COLLAPSED_MAX;
			const shown = showAll ? lines : lines.slice(0, COLLAPSED_MAX);
			// Style each line separately: TUI resets SGR per line, so styles set on
			// one line never carry to the next.
			const body = shown.map((l) => theme.fg("dim", `  ${l}`));
			if (!showAll) {
				const rest = lines.length - shown.length;
				body.push(theme.fg("dim", `  … +${rest} more line${rest === 1 ? "" : "s"} (ctrl+e to expand)`));
			}
			return new Text([title, ...body].join("\n"), 0, 0);
		},
	});

	// Human helper: list background jobs from the TUI (not an LLM tool).
	// Runs a tiny snippet through the same engine.
	pi.registerCommand("bg", {
		description: "List background jobs started by bg_do",
		handler: async (_args, ctx) => {
			try {
				const { out, err } = await sendCode(
					"import json as _j; print(_j.dumps(bg.list(), indent=2))",
					10000,
					ctx,
				);
				ctx.ui.notify(err ? `bg error: ${err}` : out.trim() || "No background jobs.", err ? "error" : "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	// The engine kills its jobs after 30 idle minutes without a client, and a reload drops the client, so
	// reattach at once instead of waiting for the next bg_do call; with no engine, stay lazy.
	pi.on("session_start", (_event, ctx) => {
		if (existsSync(join(tmpdir(), `bgdo-${sessionKey(ctx)}.sock`))) start(ctx).catch(() => {});
	});

	// Tear down the xonsh engine (and its job process groups) when the session ends.
	// killpg leaves no orphaned background processes behind.
	pi.on("session_shutdown", async (event) => {
		await cleanup((event as { reason?: string })?.reason);
	});
}
