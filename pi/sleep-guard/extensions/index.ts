// Blocks blind `sleep` in agent commands. Classification lives in sleep_guard.wasm
// (Rust + brush-parser), so this file only marshals strings and renders reasons.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Sibling is the nix-built package layout; the cargo target dir is what a local
// `pi -e ./pi/sleep-guard` run sees while iterating on the rules.
const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATHS = [
	join(HERE, "sleep_guard.wasm"),
	join(HERE, "..", "target", "wasm32-unknown-unknown", "release", "sleep_guard.wasm"),
];

const ALLOW = 0;
const R1_STALL = 1;
const R2_SLEEP_THEN_ACT = 2;
const R3_COARSE_POLL = 3;
const R4_UNBOUNDED = 4;
const UNTERMINATED_HEREDOC = 5;
const ALLOW_VIA_HATCH = 6;

const HOW_TO_WAIT =
	"Wait on the event instead: `for i in $(seq 1 60); do <check> && break; sleep 5; done`, " +
	"or start the job with bg_do and block on `bg.wait_for(id, regex, timeout=…)`. " +
	"If the wait is genuinely time-based (measuring reclaim, a rate window), re-send with " +
	"`# guard:allow-sleep <why>` in the command.";

const REASONS: Record<number, string> = {
	[R1_STALL]: `Blind sleep >15s: it stalls the session and races whatever you check next. ${HOW_TO_WAIT}`,
	[R2_SLEEP_THEN_ACT]: `Sleep-then-act (>5s before the real command): the wait is a guess, so the check can run too early. ${HOW_TO_WAIT}`,
	[R3_COARSE_POLL]: `Poll interval >30s inside the loop: poll every few seconds so the result is fresh. ${HOW_TO_WAIT}`,
	[R4_UNBOUNDED]: `Sleep with a non-numeric/suffixed duration is unbounded from here. ${HOW_TO_WAIT}`,
	[UNTERMINATED_HEREDOC]:
		"Unterminated here-document: the heredoc is opened but never closed, so bash reads to " +
		"end-of-input (`warning: here-document delimited by end-of-file`) and the command runs with " +
		"empty input. Re-send with the body and its terminator line.",
};

interface Wasm {
	buffer(): number;
	classify_bash_buf(len: number): number;
	classify_snippet_buf(len: number): number;
	memory: WebAssembly.Memory;
}

export default function sleepGuard(pi: ExtensionAPI) {
	let wasm: Wasm | null = null;
	let loadFailed = false;
	let hatchUses = 0;

	// brush-parser drags in wasm-bindgen shims through getrandom/uuid/cached; they are
	// unreachable from the parse path, so no-op stubs keep instantiation dependency-free.
	function load(): Wasm | null {
		if (wasm || loadFailed) return wasm;
		for (const path of WASM_PATHS) {
			try {
				const mod = new WebAssembly.Module(readFileSync(path));
				const imports: WebAssembly.Imports = {};
				for (const i of WebAssembly.Module.imports(mod)) {
					imports[i.module] ??= {};
					imports[i.module][i.name] = i.kind === "function" ? () => 0 : 0;
				}
				wasm = new WebAssembly.Instance(mod, imports).exports as unknown as Wasm;
				return wasm;
			} catch {}
		}
		loadFailed = true;
		return wasm;
	}

	function classify(text: string, kind: "bash" | "snippet"): number {
		const w = load();
		if (!w) return ALLOW;
		const bytes = new TextEncoder().encode(text);
		const cap = 65536;
		if (bytes.length > cap) return ALLOW;
		// memory.grow inside a call detaches older views, so take a fresh one each time.
		new Uint8Array(w.memory.buffer).set(bytes, w.buffer());
		return kind === "bash" ? w.classify_bash_buf(bytes.length) : w.classify_snippet_buf(bytes.length);
	}

	function onHatch(ctx: ExtensionContext) {
		hatchUses += 1;
		if (ctx.hasUI) {
			ctx.ui.notify(`sleep-guard bypassed via guard:allow-sleep (${hatchUses} this session)`, "warning");
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		let verdict = ALLOW;
		if (event.toolName === "bash") {
			verdict = classify(String((event.input as { command?: unknown }).command ?? ""), "bash");
		} else if (event.toolName === "bg_do") {
			verdict = classify(String((event.input as { code?: unknown }).code ?? ""), "snippet");
		} else {
			return undefined;
		}

		if (verdict === ALLOW_VIA_HATCH) {
			onHatch(ctx);
			return undefined;
		}
		const reason = REASONS[verdict];
		if (!reason) return undefined;
		if (ctx.hasUI) ctx.ui.notify("sleep-guard blocked a command", "warning");
		return { block: true, reason, terminate: false };
	});
}
