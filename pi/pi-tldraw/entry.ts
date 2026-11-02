import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { restoreCanvasCode } from "./src/canvas/state.ts";
import piTldraw, { type PiTldrawHooks } from "./src/index.ts";
import { getCanvasPath, saveCanvasSnapshot } from "./src/store/project-store.ts";

type Method = (...args: unknown[]) => unknown;

interface Drawing {
	shapes: unknown[];
	assets: unknown[];
	bindings: unknown[];
}

interface VersionEntry {
	canvasId: string;
	hash: string;
	shapes: number;
}

const VERSION_ENTRY = "pi-tldraw-version";
const EMPTY: Drawing = { shapes: [], assets: [], bindings: [] };

const NAMESPACE = {
	name: "tldraw",
	description:
		"Local tldraw canvas shared with the user in their browser (pi-tldraw), one per session branch. Unlisted: tldraw_canvas_layout, tldraw_canvas_state, tldraw_status and MCP passthroughs; see describeNamespace('tldraw')",
	instructions: [
		"1. tldraw_canvas_open shows the canvas in the user's browser; read tldraw_diagram_tips before a new diagram.",
		"2. Draw or edit with tldraw_canvas_exec (JavaScript against the live editor, focused `_type` shapes); look up Editor methods with tldraw_search.",
		"3. Read the canvas with tldraw_canvas_scene (compact) before editing; tldraw_canvas_state gives exact geometry.",
		"4. Tidy a subset with tldraw_canvas_layout({ mode: 'horizontal' | 'vertical' | 'grid', shapeIds? }).",
		"5. Check the result with tldraw_canvas_export and pass the returned image block to image() to see it.",
		"The canvas belongs to this session: omit canvasId, and expect it to follow /tree and /fork like the conversation.",
		"Diagnostics: tldraw_status, tldraw_read_canvas_resource, tldraw_call_readonly_tool.",
	].join("\n"),
};

// Codemode lists tools inline cheapest-first within a token budget, which would drop exec, the
// one whose examples teach the focused shape format; deferring the rest keeps it in the listing.
const DEFERRED = new Set([
	"tldraw_canvas_layout",
	"tldraw_canvas_state",
	"tldraw_status",
	"tldraw_read_canvas_resource",
	"tldraw_call_readonly_tool",
]);

function versionsDir(): string {
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-tldraw", "versions");
}

const SESSION_CANVAS_PREFIX = "pi-";

function defaultCanvasId(ctx: ExtensionContext): string {
	return `${SESSION_CANVAS_PREFIX}${ctx.sessionManager.getSessionId().replace(/-/g, "")}`;
}

// A fork copies the parent's entries, including its session canvas id; mapping those back to
// this session's own id keeps the fork's edits out of the parent's working copy.
function canvasIdFor(ctx: ExtensionContext, version: VersionEntry | undefined): string {
	if (!version || version.canvasId.startsWith(SESSION_CANVAS_PREFIX)) return defaultCanvasId(ctx);
	return version.canvasId;
}

function asDrawing(value: unknown): Drawing {
	const record = (value ?? {}) as Partial<Record<keyof Drawing, unknown>>;
	const list = (field: unknown) => (Array.isArray(field) ? field : []);
	return { shapes: list(record.shapes), assets: list(record.assets), bindings: list(record.bindings) };
}

function hashOf(drawing: Drawing): string {
	return createHash("sha256").update(JSON.stringify(drawing)).digest("hex");
}

function readWorkingCopy(cwd: string, canvasId: string): Drawing | undefined {
	try {
		return asDrawing(JSON.parse(readFileSync(getCanvasPath(cwd, canvasId), "utf-8")));
	} catch {
		return undefined;
	}
}

function storeVersion(drawing: Drawing): string {
	const hash = hashOf(drawing);
	const file = join(versionsDir(), `${hash}.json`);
	if (!existsSync(file)) {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(drawing));
		renameSync(tmp, file);
	}
	return hash;
}

function loadVersion(hash: string): Drawing | undefined {
	try {
		return asDrawing(JSON.parse(readFileSync(join(versionsDir(), `${hash}.json`), "utf-8")));
	} catch {
		return undefined;
	}
}

function latestVersion(ctx: ExtensionContext): VersionEntry | undefined {
	const branch = ctx.sessionManager.getBranch() as unknown as { type: string; customType?: string; data?: unknown }[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === VERSION_ENTRY) return entry.data as VersionEntry;
	}
	return undefined;
}

// The canvas is versioned through the session tree: each change at a turn boundary becomes a
// custom entry pointing at a content-addressed snapshot, so /tree and /fork carry it like messages.
function trackBranches(pi: ExtensionAPI, hooks: PiTldrawHooks): void {
	const canvasIdOf = (ctx: ExtensionContext) => hooks.getSessionCanvasId?.() ?? defaultCanvasId(ctx);
	const browserConnected = () => hooks.canvasHost?.getStatus().browserConnected === true;

	// Reads only the working copy, which the tab's autosave and every exec keep current; a live read
	// is a browser round trip (seconds in a throttled background tab) that held each turn hostage.
	function capture(ctx: ExtensionContext): void {
		const canvasId = canvasIdOf(ctx);
		const drawing = readWorkingCopy(ctx.cwd, canvasId);
		if (!drawing) return;
		const latest = latestVersion(ctx);
		const hash = hashOf(drawing);
		if (latest?.hash === hash && latest.canvasId === canvasId) return;
		storeVersion(drawing);
		pi.appendEntry<VersionEntry>(VERSION_ENTRY, { canvasId, hash, shapes: drawing.shapes.length });
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		const version = latestVersion(ctx);
		const canvasId = canvasIdFor(ctx, version);
		const working = readWorkingCopy(ctx.cwd, canvasId);
		if (!version && !working) return;
		const target = (version && loadVersion(version.hash)) || EMPTY;
		hooks.setSessionCanvasId?.(canvasId);
		if (working && hashOf(working) === hashOf(target)) return;
		let live = "";
		if (browserConnected()) {
			try {
				await hooks.canvasHost?.execOnCanvas({ code: restoreCanvasCode(target), canvasId });
			} catch (err) {
				live = ` The open tab still shows the old branch; reload it before drawing (${err instanceof Error ? err.message : String(err)}).`;
			}
		}
		await saveCanvasSnapshot(ctx.cwd, canvasId, target, { allowEmptyOverwrite: true });
		ctx.ui.notify(
			`tldraw: canvas restored to this branch (${target.shapes.length} shape(s)); unsent edits were discarded.${live}`,
			live ? "warning" : "info",
		);
	}

	const report = (ctx: ExtensionContext, what: string) => (err: unknown) =>
		ctx.ui.notify(`tldraw: could not ${what} the branch canvas: ${err instanceof Error ? err.message : String(err)}`, "warning");

	pi.on("session_start", async (_event, ctx) => {
		const version = latestVersion(ctx);
		const canvasId = canvasIdFor(ctx, version);
		hooks.setSessionCanvasId?.(canvasId);
		if (!version || readWorkingCopy(ctx.cwd, canvasId)) return; // an existing working copy holds unsent edits worth keeping
		const drawing = loadVersion(version.hash);
		if (drawing) await saveCanvasSnapshot(ctx.cwd, canvasId, drawing, { allowEmptyOverwrite: true }).catch(report(ctx, "seed"));
	});

	const safeCapture = (ctx: ExtensionContext) => {
		try {
			capture(ctx);
		} catch (err) {
			report(ctx, "save")(err);
		}
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") safeCapture(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		safeCapture(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restore(ctx).catch(report(ctx, "restore"));
	});
}

// pi-tldraw declares eleven tools on every request; as a codemode namespace they stay out of the
// prompt's tool list, and one script can chain open, exec, scene and export.
export default function piTldrawSessions(pi: ExtensionAPI) {
	const wrapped = new Proxy(pi, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop !== "registerTool") return (value as Method).bind(target);
			return (tool: ToolDefinition) =>
				(value as Method).call(target, {
					...tool,
					exposure: DEFERRED.has(tool.name) ? "deferred" : "codemode",
					namespace: NAMESPACE,
				});
		},
	});
	const hooks: PiTldrawHooks = {};
	piTldraw(wrapped, hooks);
	trackBranches(pi, hooks);
}
