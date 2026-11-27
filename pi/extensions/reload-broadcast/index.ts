import { type FSWatcher, mkdirSync, watch } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INITIAL_STATE, type Mode, modeFor, REQUEST_FILE, type ReloadAction, type ReloadEvent, requestDir, STATUS_KEY, step } from "./state.ts";

const COMMAND = "reload-external";
const RESUME = Symbol.for("pi.reload-broadcast.resume");
const CONTINUE_TEXT =
	"pi was reloaded mid-run to pick up changed extensions, skills and context files. Continue where you left off.";

interface Handoff {
	continue?: () => void;
}
type Slot = { [RESUME]?: Handoff };

function attempt(fn: (() => void) | undefined): boolean {
	if (!fn) return false;
	try {
		fn();
		return true;
	} catch {
		return false;
	}
}

// `pi-reload-all` writes the request file; every pi watching it runs /reload, and one caught mid-run
// aborts after its current tool turn, reloads, and continues. Signals would kill a pi without a handler.
export default function reloadBroadcast(pi: ExtensionAPI): void {
	let mode: Mode | undefined;
	let ctx: ExtensionContext | undefined;
	let state = INITIAL_STATE;
	let watcher: FSWatcher | undefined;
	let continueNext = false;

	const continuation = (c: ExtensionContext) => () => {
		c.ui.setStatus(STATUS_KEY, undefined);
		pi.sendMessage({ customType: "reload-broadcast", content: CONTINUE_TEXT, display: true }, { triggerTurn: true });
	};

	const perform = (action: ReloadAction) => {
		if (action === "notify_queued") {
			ctx?.ui.notify("Reload requested; it runs after the current turn", "info");
		} else if (action === "abort") {
			ctx?.ui.setStatus(STATUS_KEY, "reloading");
			ctx?.abort();
		} else {
			continueNext = action === "reload_and_continue";
			pi.sendUserMessage(`/${COMMAND}`, { expandPromptTemplates: true });
		}
	};

	const send = (event: ReloadEvent) => {
		if (!mode) return;
		const result = step(mode, state, event);
		state = result.state;
		for (const action of result.actions) perform(action);
	};

	// The old pi and ctx are stale once ctx.reload() returns, so the new instance leaves the continuation
	// in a process-wide slot; the old frame runs it only after the reload has fully finished.
	pi.registerCommand(COMMAND, {
		description: "Reload like /reload; pi-reload-all sends it to every open pi",
		handler: async (_args, commandCtx) => {
			const slot = globalThis as Slot;
			const wantsContinue = continueNext;
			const reloadMode = mode;
			continueNext = false;
			if (wantsContinue) slot[RESUME] = {};
			let failure: unknown;
			try {
				await commandCtx.reload();
			} catch (error) {
				failure = error;
			}
			const handoff = slot[RESUME];
			delete slot[RESUME];
			const refused = mode !== undefined; // no session_shutdown, so this instance is still the live one
			if (wantsContinue && !attempt(handoff?.continue) && !(refused && ctx && attempt(continuation(ctx)))) {
				if (reloadMode === "rpc") process.kill(process.pid, "SIGTERM"); // the parent would wait forever
			}
			send({ type: "reload_done" });
			if (failure) throw failure;
		},
	});

	pi.on("session_start", (event, c) => {
		mode = modeFor(c.mode);
		if (!mode) return;
		ctx = c;
		const handoff = (globalThis as Slot)[RESUME];
		if (event.reason === "reload" && handoff) handoff.continue = continuation(c);
		const dir = requestDir();
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			watcher = watch(dir, { persistent: false }, (_type, file) => {
				if (file === REQUEST_FILE) send({ type: "request", idle: c.isIdle() });
			});
			watcher.on("error", () => watcher?.close());
		} catch {}
	});

	pi.on("turn_end", (event, c) => {
		ctx = c;
		send({ type: "turn_end", hasToolResults: event.toolResults.length > 0 });
	});

	pi.on("agent_settled", (_event, c) => {
		ctx = c;
		send({ type: "settled" });
	});

	pi.on("session_shutdown", () => {
		watcher?.close();
		watcher = undefined;
		mode = undefined;
	});
}
