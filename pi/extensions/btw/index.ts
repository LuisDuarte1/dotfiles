import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { buildSideSession, sessionName } from "./fork.ts";
import { git } from "./git.ts";
import {
	type BtwInfo,
	blockReason,
	ENV,
	type Mode,
	promptSection,
	readOnlyHint,
	resolveMode,
	SLUG,
	slugify,
} from "./guard.ts";
import {
	forwardedFlags,
	openSideWindow,
	PANE_SCRIPT,
	pickOpener,
	piFlags,
	piInvocation,
	runtimeDir,
	sandboxArgv,
	sandboxHides,
	shellQuote,
} from "./launch.ts";
import { DISABLE_PASTE_EVENTS, ENABLE_PASTE_EVENTS, type PasteResult, PasteReader } from "./paste.ts";
import { planPromotion, writeRequest } from "./promote.ts";
import { createSnapshot, currentTree, SNAPSHOT_BASE } from "./snapshot.ts";

const STATUS_KEY = "btw";
const PASTE_STALL_MS = 5000;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

function saveImage(mime: string, bytes: Buffer): string {
	const file = path.join(os.tmpdir(), `pi-clipboard-${randomUUID()}.${IMAGE_EXTENSIONS[mime]}`);
	writeFileSync(file, bytes, { mode: 0o600 });
	return file;
}

function onPath(bin: string): boolean {
	return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, bin)));
}

const promotable = () => process.env[ENV.promotable] === "1";

function statusText(mode: Mode, changed?: number): string | undefined {
	const nudge = changed && promotable() ? ` · ${changed} changed · /btw promote` : "";
	if (mode.kind === "sandboxed") return `btw: origin read-only${nudge}`;
	if (mode.kind === "unsandboxed") return "btw: unsandboxed, read-only tools";
	if (mode.kind === "promoted") return `btw → ${mode.info.promoted.branch}`;
	return undefined;
}

async function changedSinceFork(info: BtwInfo): Promise<number | undefined> {
	if (!info.work) return undefined;
	const names = await git(["-C", info.root, "diff", "--name-only", info.work, await currentTree(info.root)]);
	return names ? names.split("\n").length : 0;
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = { kind: "off" };
	let idleLeaf: string | null = null;

	const refresh = (ctx: ExtensionContext) => {
		mode = resolveMode(process.env, ctx.sessionManager.getEntries());
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, statusText(mode));
		if (mode.kind !== "sandboxed") return;
		const current = mode;
		changedSinceFork(current.info).then(
			(changed) => mode === current && ctx.ui.setStatus(STATUS_KEY, statusText(current, changed)),
			() => undefined,
		);
	};

	let stopPaste: (() => void) | undefined;
	// A finished paste is handed back to pi as bracketed-paste input, so it reaches whatever has
	// focus and renders like a real one; an image becomes its saved path, as Ctrl+V does outside.
	const startPaste = (ctx: ExtensionContext) => {
		stopPaste?.();
		const reader = new PasteReader((data) => process.stdout.write(data));
		const pasted = (result: PasteResult | undefined): TerminalInputResult => {
			if (result?.kind === "error") ctx.ui.notify(`btw paste: ${result.message}`, "warning");
			if (result?.kind !== "text" && result?.kind !== "image") return { consume: true };
			const text = result.kind === "text" ? result.text : saveImage(result.mime, result.bytes);
			return { data: `\x1b[200~${text}\x1b[201~` };
		};
		let stall: NodeJS.Timeout | undefined;
		const unsubscribe = ctx.ui.onTerminalInput((data) => {
			const outcome = reader.input(data);
			if (outcome.consume) {
				clearTimeout(stall);
				if (reader.busy) stall = setTimeout(() => pasted(reader.abort("kitty stopped answering mid-paste")), PASTE_STALL_MS);
				return pasted(outcome.result);
			}
			if (!matchesKey(data, "ctrl+v") || isKeyRelease(data)) return undefined;
			const how = reader.supported ? "Ctrl+Shift+V (images too)" : "your terminal's paste shortcut (text only)";
			ctx.ui.notify(`btw: the sandbox can't read the clipboard; paste with ${how}`, "info");
			return { consume: true };
		});
		process.stdout.write(ENABLE_PASTE_EVENTS);
		stopPaste = () => {
			clearTimeout(stall);
			unsubscribe();
			process.stdout.write(DISABLE_PASTE_EVENTS);
			stopPaste = undefined;
		};
	};

	pi.on("session_start", (_event, ctx) => {
		idleLeaf = ctx.sessionManager.getLeafId();
		refresh(ctx);
		if (mode.kind === "sandboxed" && ctx.mode === "tui") startPaste(ctx);
		if (mode.kind === "unsandboxed" && ctx.hasUI) {
			ctx.ui.notify(`btw side session opened outside its sandbox: only read-only tools work (${mode.info.origin})`, "warning");
		}
	});

	pi.on("session_shutdown", () => stopPaste?.());

	// before_agent_start fires before the prompt's user message is appended, so together with
	// agent_settled this always holds the leaf of the last moment the agent was idle.
	pi.on("agent_settled", (_event, ctx) => {
		idleLeaf = ctx.sessionManager.getLeafId();
		refresh(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		idleLeaf = ctx.sessionManager.getLeafId();
		const section = promptSection(mode);
		if (section) event.systemPromptOptions.sections.btw = section;
	});

	pi.on("tool_call", (event, ctx) => {
		if (mode.kind === "off") return;
		const readOnlyHint =
			mode.kind === "unsandboxed"
				? pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations?.readOnlyHint
				: undefined;
		const reason = blockReason(mode, { toolName: event.toolName, input: event.input, cwd: ctx.cwd, readOnlyHint });
		if (reason) return { block: true, reason };
	});

	pi.on("tool_result", (event) => {
		if (mode.kind !== "sandboxed" || event.toolName !== "bash") return;
		const texts = event.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
		const hint = readOnlyHint(mode, texts);
		if (hint) return { content: [...event.content, { type: "text" as const, text: hint }] };
	});

	const promote = async (slugArg: string, ctx: ExtensionCommandContext) => {
		if (mode.kind !== "sandboxed") {
			ctx.ui.notify("/btw promote only works inside a sandboxed btw side session", "error");
			return;
		}
		if (!promotable()) {
			ctx.ui.notify("btw: this side session was opened by an older /btw without the pane runner, so it can't be promoted", "error");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("btw: wait for the agent to finish (or press Esc) before promoting", "warning");
			return;
		}
		const slug = slugArg || slugify(ctx.sessionManager.getSessionName() ?? "");
		if (!SLUG.test(slug)) {
			ctx.ui.notify(`btw: "${slug}" is not a valid name; use lowercase letters, digits and dashes`, "error");
			return;
		}
		const title = ctx.sessionManager.getSessionName() ?? slug;
		try {
			await planPromotion({ info: mode.info, slug, title, hasGstuff: onPath("gstuff") });
		} catch (error) {
			ctx.ui.notify(`btw promote: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		writeRequest(mode.info.root, slug);
		ctx.ui.notify("btw: leaving the sandbox; confirm the promotion in this terminal", "info");
		ctx.shutdown();
	};

	const open = async (question: string, ctx: ExtensionCommandContext) => {
		if (mode.kind === "sandboxed" || mode.kind === "unsandboxed") {
			ctx.ui.notify("/btw is not available inside a btw side session (try /btw promote)", "error");
			return;
		}
		if (!onPath("bwrap")) {
			ctx.ui.notify("/btw needs bubblewrap (bwrap) to keep the checkout read-only", "error");
			return;
		}
		if (!existsSync(PANE_SCRIPT)) {
			ctx.ui.notify(`/btw: ${PANE_SCRIPT} is gone, so btw moved after this pi loaded it; run /reload`, "error");
			return;
		}
		const forkPoint = ctx.isIdle() ? ctx.sessionManager.getLeafId() : idleLeaf;
		const branch = forkPoint ? ctx.sessionManager.getBranch(forkPoint) : [];
		const parentSession = ctx.sessionManager.getSessionFile();
		const sessionDir = ctx.sessionManager.getSessionDir() || path.join(SNAPSHOT_BASE, "sessions");
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const thinking = pi.getThinkingLevel();

		ctx.ui.setStatus(STATUS_KEY, "btw: snapshotting…");
		try {
			const snap = await createSnapshot(ctx.cwd, { refuseInside: [getAgentDir()] });
			const createdAt = new Date();
			const info: BtwInfo = {
				origin: snap.origin,
				root: snap.root,
				createdAt: createdAt.toISOString(),
				parentSession,
				head: snap.head,
				branch: snap.branch,
				work: snap.work,
			};
			const name = sessionName(question);
			const side = buildSideSession({ branch, cwd: snap.cwd, parentSession, info, name, now: createdAt });

			// Pi discovers sessions one directory level deep only, so a btw/ subfolder keeps side
			// sessions out of `pi -c` and /resume, where they would reopen without the sandbox.
			const dir = path.join(sessionDir, "btw");
			await mkdir(dir, { recursive: true });
			const sessionFile = path.join(dir, side.fileName);
			await writeFile(sessionFile, side.content, { flag: "wx" });

			const invocation = piInvocation();
			const flags = piFlags({
				model,
				thinking,
				forwarded: forwardedFlags(process.argv.slice(2)),
				approve: new ProjectTrustStore(getAgentDir()).get(snap.origin) === true,
			});
			const openSocket = path.join(runtimeDir(), `${snap.id}.sock`);
			const sandbox = sandboxArgv({
				...snap,
				hides: sandboxHides(process.env, process.getuid?.() ?? 0, existsSync),
				open: { socket: openSocket, node: process.execPath, path: process.env.PATH ?? "" },
				createdAt: info.createdAt,
				command: [...invocation, "--session", sessionFile, ...flags],
			});
			const opener = pickOpener(process.env, onPath);
			if (!opener) {
				const command = question ? [...sandbox, "--", question] : sandbox;
				ctx.ui.notify(`btw: no kitty on a display and no tmux; run this yourself:\n${shellQuote(command)}`, "warning");
				return;
			}
			const spec = {
				sandbox,
				question,
				pi: invocation,
				piFlags: flags,
				sessionFile,
				info,
				rel: path.relative(snap.root, snap.cwd),
				title: name,
				hasGstuff: onPath("gstuff"),
				openSocket,
			};
			const where = await openSideWindow(opener, { id: snap.id, cwd: snap.cwd, title: name, spec });
			const history = side.forked ? "" : " (nothing to fork yet, fresh session)";
			ctx.ui.notify(`btw: opened ${where}, snapshot ${snap.root}${history}`, "info");
		} catch (error) {
			ctx.ui.notify(`btw failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			ctx.ui.setStatus(STATUS_KEY, statusText(mode));
		}
	};

	pi.registerCommand("btw", {
		description: "Ask a side question in a sandboxed fork of this session; /btw promote [name] keeps the work",
		handler: async (args, ctx) => {
			const [first, ...rest] = args.trim().split(/\s+/);
			if (first === "promote") return promote(rest.join("-"), ctx);
			return open(args.trim(), ctx);
		},
	});
}
