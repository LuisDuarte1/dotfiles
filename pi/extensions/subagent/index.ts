// Subagent tool: runs `pi --mode rpc` in its own context window and returns only its final text.
// RPC (not JSON mode) keeps a live channel to the child and its session file is kept for inspection.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type TProperties, Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { loadConfig, resolveSubagentModel } from "./config.ts";
import { forwardDialog } from "./dialogs.ts";
import { SubagentInspector } from "./inspector.ts";
import { RunRegistry } from "./registry.ts";
import { COMPACT, Lines, runHeader, statusIcon, transcriptLines } from "./render.ts";
import {
	createRun,
	formatCost,
	formatDuration,
	formatTokens,
	lastEntryId,
	lastText,
	oneLine,
	replaySession,
	resultText,
	type RunState,
	type RunStatus,
	shortModel,
} from "./run.ts";
import { runChild } from "./runner.ts";
import { findThread, NAME_PATTERN, type ThreadDetails, threadFooter } from "./threads.ts";
import { collectTransports, type SubagentTransport } from "./transport.ts";
import { SubagentWidget } from "./widget.ts";

const SESSIONS_ROOT = path.join(getAgentDir(), "subagent-sessions");
const CONFIG_FILE = path.join(getAgentDir(), "subagent.json");
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 250;
const LIVE_TRANSCRIPT_LINES = 30;

interface SubagentDetails {
	runId?: number;
	agent?: string;
	agentSource?: "user" | "project";
	task: string;
	context?: string;
	status: RunStatus;
	model?: string;
	turns?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
	stderr: string;
	sessionFile?: string;
	steers?: string[];
	thread?: ThreadDetails;
}

function detailsFor(run: RunState, agentSource: AgentConfig["source"] | undefined, thread?: ThreadDetails): SubagentDetails {
	return {
		thread,
		runId: run.id,
		agent: run.agent,
		agentSource,
		task: run.task,
		context: run.context,
		status: run.status,
		model: run.model,
		turns: run.turns,
		tokens: run.usage.totalTokens,
		cost: run.usage.cost.total,
		durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
		stderr: run.stderr,
		sessionFile: run.sessionFile,
		steers: run.steers.length > 0 ? run.steers : undefined,
	};
}

// Resolve how to re-invoke pi from inside an extension.
// Mirrors the upstream subagent example so it works under both `node dist/cli.js` and the compiled bun binary.
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: "pi", args };
	}
	return { command: process.execPath, args };
}

async function writeTempPrompt(name: string, body: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, body, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

async function readLastEntryId(file: string): Promise<string | undefined> {
	return lastEntryId(await fs.promises.readFile(file, "utf-8").catch(() => ""));
}

async function pruneOldSessions(): Promise<void> {
	const cutoff = Date.now() - SESSION_RETENTION_MS;
	const entries = await fs.promises.readdir(SESSIONS_ROOT, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(SESSIONS_ROOT, entry.name);
		const stat = await fs.promises.stat(dir).catch(() => undefined);
		if (stat && stat.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

function statsLine(details: SubagentDetails, theme: Theme): string {
	const parts = [
		shortModel(details.model),
		details.durationMs === undefined ? undefined : formatDuration(details.durationMs),
		details.turns === undefined ? undefined : `${details.turns} turn${details.turns === 1 ? "" : "s"}`,
		details.tokens === undefined ? undefined : `${formatTokens(details.tokens)} tok`,
		details.cost ? formatCost(details.cost) : undefined,
	].filter(Boolean);
	return parts.length > 0 ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
}

function renderLive(run: RunState, expanded: boolean, theme: Theme) {
	return new Lines((width) => {
		const lines = [truncateToWidth(runHeader(run, theme), width)];
		if (run.activity) lines.push(truncateToWidth(theme.fg("dim", `  ${oneLine(run.activity, 300)}`), width));
		if (!expanded) return lines;
		lines.push(...wrapTextWithAnsi(theme.fg("muted", "Task: ") + theme.fg("dim", run.task), width), "");
		lines.push(...transcriptLines(run.transcript, width, theme, COMPACT).slice(-LIVE_TRANSCRIPT_LINES));
		return lines;
	});
}

interface SubagentParams {
	task: string;
	name?: string;
	agent?: string;
	model?: string;
	context?: string;
	[transport: string]: unknown;
}

function subagentParameters(transports: SubagentTransport[]) {
	const properties: TProperties = {
		task: Type.String({ description: "What the subagent should do." }),
		name: Type.Optional(
			Type.String({
				description:
					'Optional stable name for this subagent (e.g. "auth-explorer"). Calling again with the same name continues its session with full history: send only the follow-up, and omit agent/model to keep them.',
			}),
		),
		agent: Type.Optional(
			Type.String({
				description:
					"Optional agent name (filename without .md) loaded from ~/.pi/agent/agents or .pi/agents. The agent's frontmatter supplies model + tools and its body becomes the system prompt.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description: "Optional provider/model-id override for this call; otherwise uses the agent's model or the default. Fable parents still cannot delegate to Fable models.",
				minLength: 1,
			}),
		),
		context: Type.Optional(
			Type.String({
				description:
					"Optional context (file paths, prior findings, constraints) to forward so the subagent can act without re-discovering them.",
			}),
		),
	};
	for (const transport of transports) properties[transport.param] = Type.Optional(transport.schema);
	return Type.Object(properties);
}

function createSubagentTool(registry: RunRegistry, widget: SubagentWidget, transports: SubagentTransport[]) {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a focused subtask to an isolated `pi` subprocess and receive only its final text answer.",
			"Useful to keep your own context window small when exploring code, summarizing files, or running self-contained analyses.",
			"Pass `agent` to use a configured agent definition from ~/.pi/agent/agents/<name>.md or .pi/agents/<name>.md",
			"(YAML frontmatter with `description`, optional `model`, optional `tools`; body is the system prompt). When `agent` is omitted, runs as a generic subagent with the default model and tools.",
			"Pass `model` as provider/model-id to override the agent's model for this call without changing its prompt or tools.",
			"When neither a model override nor an agent model is configured, the subagent uses the configured default model.",
			"The subagent cannot see this session's history, so pass any relevant facts, paths, or prior findings via `context`.",
			"Pass `name` to keep a subagent for follow-ups: a later call with the same name resumes it with everything it already saw and found.",
			"Names belong to this session; a named subagent runs one task at a time.",
		].join(" "),
		promptSnippet: "Spawn an isolated subagent for a focused subtask; returns only its final text.",
		parameters: subagentParameters(transports),

		async execute(toolCallId, rawParams, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			const params = rawParams as SubagentParams;
			const transport = transports.find((t) => params[t.param] !== undefined);
			const transportValue = transport ? params[transport.param] : undefined;
			const name = params.name?.trim();
			const prior = name === undefined ? undefined : findThread(ctx.sessionManager.getBranch(), name);
			if (name !== undefined) {
				if (!NAME_PATTERN.test(name)) throw new Error(`Invalid subagent name "${name}": use 1-64 letters, digits, ".", "_" or "-".`);
				if (transport) throw new Error(`\`name\` cannot be combined with \`${transport.param}\` yet.`);
				if (registry.liveNamed(name)) {
					throw new Error(`Subagent "${name}" is still running; wait for its result before sending it more, or use another name.`);
				}
				if (prior && params.agent !== undefined && params.agent !== prior.agent) {
					const was = prior.agent ? `agent "${prior.agent}"` : "a generic subagent";
					throw new Error(`Subagent "${name}" runs as ${was}; omit \`agent\` to continue it, or use another name.`);
				}
			}

			const agentName = params.agent ?? prior?.agent;
			let agent: AgentConfig | undefined;
			if (agentName) {
				const agents = discoverAgents(ctx.cwd);
				agent = agents.find((a) => a.name === agentName);
				if (!agent) {
					const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
					throw new Error(`Unknown agent "${agentName}". Available: ${available}.`);
				}
			}

			const modelOverride = params.model?.trim();
			if (modelOverride !== undefined) {
				const separator = modelOverride.indexOf("/");
				const provider = modelOverride.slice(0, separator);
				const modelId = modelOverride.slice(separator + 1);
				if (separator <= 0 || !ctx.modelRegistry.find(provider, modelId)) {
					throw new Error(`Unknown model override "${modelOverride}". Use an exact provider/model-id.`);
				}
			}

			const subagentModel = resolveSubagentModel({
				override: modelOverride ?? prior?.model,
				agent,
				parentModelId: ctx.model?.id,
				config: loadConfig(CONFIG_FILE),
			});

			// Nothing above may await: the liveNamed check and this create must be atomic, or two
			// parallel calls with one name would both resume the same session file.
			widget.bind(ctx);
			const run = registry.create({
				task: params.task,
				name,
				callId: toolCallId,
				agent: transport ? transport.label(transportValue, agentName) : agentName,
				model: subagentModel,
				context: params.context,
			});

			const sessionDir = path.resolve(SESSIONS_ROOT, ctx.sessionManager.getSessionId());
			const priorFile = prior && fs.existsSync(prior.sessionFile) ? path.resolve(prior.sessionFile) : undefined;
			const thread: ThreadDetails | undefined =
				name === undefined ? undefined : { name, agent: agent?.name, prompt: prior && priorFile ? prior.prompts + 1 : 1 };

			let lastProgress = 0;
			const progress = (force = false) => {
				const now = Date.now();
				if (run.status !== "running" || (!force && now - lastProgress < PROGRESS_INTERVAL_MS)) return;
				lastProgress = now;
				onUpdate?.({
					content: [{ type: "text", text: lastText(run.lastAssistant) || "(running...)" }],
					details: detailsFor(run, agent?.source, thread),
				});
			};
			const ticker = setInterval(() => progress(true), 1000);
			ticker.unref?.();
			progress(true);

			const args = ["--mode", "rpc", "--session-dir", sessionDir];
			if (subagentModel) args.push("--model", subagentModel);
			if (agent?.thinking) args.push("--thinking", agent.thinking);
			if (agent?.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

			let tmp: { dir: string; filePath: string } | undefined;
			try {
				if (thread && priorFile) thread.after = await readLastEntryId(priorFile);
				if (!priorFile) {
					args.push("--name", `subagent: ${name ? `${name}: ` : ""}${oneLine(params.task, 60)}`);
				} else if (path.dirname(priorFile) === sessionDir) {
					args.push("--session", priorFile);
					const now = new Date();
					await fs.promises.utimes(sessionDir, now, now).catch(() => {}); // appending does not bump the dir mtime pruning reads
				} else {
					args.push("--fork", priorFile); // inherited from a forked parent: copy, never share
				}
				if (agent?.systemPrompt.trim()) {
					tmp = await writeTempPrompt(agent.name, agent.systemPrompt);
					args.push("--append-system-prompt", tmp.filePath);
				}
				const prompt = params.context
					? `Context from parent agent:\n${params.context}\n\nTask:\n${params.task}`
					: params.task;
				const invocation = getPiInvocation(args);
				const spec = { model: subagentModel, thinking: agent?.thinking, tools: agent?.tools, systemPrompt: agent?.systemPrompt };
				await runChild({
					run,
					createChild: transport ? (o) => transport.createChild(o, transportValue, spec) : undefined,
					durable: transport?.durable === true,
					command: invocation.command,
					args: invocation.args,
					cwd: ctx.cwd,
					prompt,
					signal,
					onChange: () => {
						registry.changed();
						progress();
					},
					onControls: (controls) => (controls ? registry.attach(run.id, controls) : registry.detach(run.id)),
					forwardDialog: ctx.hasUI ? (request) => forwardDialog(ctx, run, request, signal) : undefined,
				});
			} finally {
				clearInterval(ticker);
				if (run.status === "running") run.status = "error"; // a throw must not leave the name busy
				registry.finish(run);
				if (tmp) await fs.promises.rm(tmp.dir, { recursive: true, force: true }).catch(() => {});
			}

			const footer = thread ? `\n\n${threadFooter(thread, prior !== undefined && !priorFile)}` : "";
			return {
				content: [{ type: "text", text: resultText(run) + footer }],
				details: detailsFor(run, agent?.source, thread),
				usage: run.usage,
			};
		},

		renderCall(args, theme) {
			const task = (args.task ?? "...").toString();
			const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
			const agentTag = args.agent ? theme.fg("accent", `${args.agent} `) : "";
			const nameTag = args.name ? theme.fg("accent", `@${args.name} `) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) + nameTag + agentTag + theme.fg("dim", preview),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const detail = result.details as SubagentDetails | undefined;
			const live = isPartial && detail?.runId !== undefined ? registry.get(detail.runId) : undefined;
			if (live?.status === "running") return renderLive(live, expanded, theme);

			const status: RunStatus = detail?.status ?? (isPartial ? "running" : "done");
			const nameLabel = detail?.thread ? ` ${theme.fg("accent", `@${detail.thread.name}`)}` : "";
			const agentLabel = detail?.agent
				? `${nameLabel} ${theme.fg("accent", detail.agent)}${theme.fg("muted", detail.agentSource ? ` (${detail.agentSource})` : "")}`
				: nameLabel;
			const header = `${statusIcon(status, theme)} ${theme.fg("toolTitle", theme.bold("subagent"))}${agentLabel} ${theme.fg("muted", `[${status}]`)}${detail ? statsLine(detail, theme) : ""}`;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			if (!expanded) {
				const preview = text.split("\n").slice(0, 3).join("\n");
				const body = preview.trim() || (status === "running" ? "(running...)" : "(no output)");
				return new Text(`${header}\n${theme.fg("toolOutput", body)}`, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			if (detail?.task) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", detail.task), 0, 0));
			}
			if (detail?.context) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Context:"), 0, 0));
				container.addChild(new Text(theme.fg("dim", detail.context), 0, 0));
			}
			if (text.trim()) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(text.trim(), 0, 0, getMarkdownTheme()));
			}
			if (detail?.sessionFile) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("muted", "Session: ") + theme.fg("dim", `pi --session ${detail.sessionFile}`), 0, 0),
				);
			}
			return container;
		},
	});
}

// Runs from before a restart only survive as tool-result details on this branch;
// their transcripts are replayed from the child session file when opened.
function pastRuns(ctx: ExtensionContext): RunState[] {
	const runs: RunState[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") continue;
		const details = entry.message.details as SubagentDetails | undefined;
		if (!details?.sessionFile) continue;
		const run = createRun({
			id: 0,
			task: details.task,
			name: details.thread?.name,
			callId: entry.message.toolCallId,
			agent: details.agent,
			model: details.model,
			context: details.context,
		});
		const endedAt = Date.parse(entry.timestamp);
		Object.assign(run, {
			replayAfter: details.thread?.after,
			status: details.status,
			turns: details.turns ?? 0,
			sessionFile: details.sessionFile,
			endedAt,
			startedAt: endedAt - (details.durationMs ?? 0),
			activity: "",
			stderr: details.stderr,
		});
		run.usage.totalTokens = details.tokens ?? 0;
		run.usage.cost.total = details.cost ?? 0;
		runs.push(run);
	}
	return runs.reverse();
}

function loadPast(run: RunState): void {
	if (run.transcript.length > 0 || !run.sessionFile) return;
	try {
		const replayed = replaySession(createRun({ id: 0, task: run.task }), fs.readFileSync(run.sessionFile, "utf-8"), run.replayAfter);
		run.transcript = replayed.transcript;
		run.steers = replayed.steers;
	} catch (error) {
		run.stderr = `cannot read ${run.sessionFile}: ${(error as Error).message}`;
	}
}

type RunRef = { id: number } | { name: string };

function parseRef(text: string, requireSigil = false): { ref?: RunRef; rest: string } {
	const trimmed = text.trim();
	const match = (requireSigil ? /^(?:#(\d+)|@([\w.-]+))(?=\s|$)/ : /^(?:#?(\d+)|@([\w.-]+))(?=\s|$)/).exec(trimmed);
	if (!match) return { rest: trimmed };
	const ref = match[1] !== undefined ? { id: Number(match[1]) } : { name: match[2] };
	return { ref, rest: trimmed.slice(match[0].length).trim() };
}

const refLabel = (ref: RunRef) => ("id" in ref ? `#${ref.id}` : `@${ref.name}`);
const runRefLabel = (run: RunState) => `#${run.id}${run.name ? ` @${run.name}` : ""}`;

export default function (pi: ExtensionAPI) {
	const registry = new RunRegistry();
	const widget = new SubagentWidget(registry);
	pi.registerTool(createSubagentTool(registry, widget, []));
	let transportsCollected = false;

	let inspectorOpen = false;
	const openInspector = async (ctx: ExtensionContext, initialRunId?: number) => {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("The subagent inspector needs the terminal UI.", "warning");
			return;
		}
		if (inspectorOpen) return;
		inspectorOpen = true;
		try {
			const past = pastRuns(ctx);
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new SubagentInspector({ tui, theme, registry, pastRuns: past, loadPast, initialRunId, done: () => done() }),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
			);
		} finally {
			inspectorOpen = false;
		}
	};

	const findRun = (ref: RunRef) =>
		"id" in ref ? registry.get(ref.id) : (registry.liveNamed(ref.name) ?? registry.all().find((run) => run.name === ref.name));

	const runCompletions = (prefix: string, runs = registry.all()): AutocompleteItem[] | null => {
		const describe = (run: RunState) => `[${run.status}] ${oneLine(run.task, 60)}`;
		const byId = runs.map((run) => ({ value: `#${run.id}`, label: runRefLabel(run), description: describe(run) }));
		const latestByName = new Map<string, RunState>();
		for (const run of runs) if (run.name && !latestByName.has(run.name)) latestByName.set(run.name, run);
		const byName = [...latestByName].map(([name, run]) => ({ value: `@${name}`, label: `@${name}`, description: describe(run) }));
		const items = [...byName, ...byId].filter((item) => item.value.startsWith(prefix.trim()));
		return items.length > 0 ? items : null;
	};

	pi.registerCommand("subagents", {
		description: "Inspect running and finished subagents (optionally jump to #id or @name)",
		getArgumentCompletions: runCompletions,
		handler: async (args, ctx) => {
			const { ref } = parseRef(args);
			return openInspector(ctx, ref ? findRun(ref)?.id : undefined);
		},
	});
	pi.registerCommand("steer", {
		description: "Steer a running subagent: /steer [#id|@name] <message>",
		getArgumentCompletions: (prefix) => (/^(#?\d*|@[\w.-]*)$/.test(prefix.trim()) ? runCompletions(prefix, registry.live()) : null),
		handler: async (args, ctx) => {
			const notify = (message: string, level: "info" | "warning" = "warning") => ctx.ui.notify(message, level);
			const { ref, rest: message } = parseRef(args, true);
			const live = registry.live();
			const target = ref ? findRun(ref) : live.length === 1 ? live[0] : undefined;
			if (!message) return notify("Usage: /steer [#id|@name] <message>");
			if (!target) {
				if (ref) return notify(`No subagent ${refLabel(ref)}.`);
				if (live.length === 0) return notify("No subagent is running.");
				return notify(`Several subagents are running (${live.map(runRefLabel).join(", ")}); use /steer #<id> <message>.`);
			}
			const controls = registry.controlsFor(target.id);
			if (target.status !== "running" || !controls) return notify(`Subagent #${target.id} already finished.`);
			const error = await controls.steer(message);
			if (error) return notify(`Steer failed: ${error}`);
			notify(`Queued for #${target.id}; it is delivered after the subagent's current step.`, "info");
		},
	});
	pi.registerShortcut("alt+s", {
		description: "Inspect subagents",
		handler: async (ctx) => openInspector(ctx),
	});

	// Every extension's factory has run by session start, whatever the load order, so this is the
	// first point where transports can answer; re-registering replaces the tool's schema.
	pi.on("session_start", (_event, ctx) => {
		if (!transportsCollected) {
			transportsCollected = true;
			const transports = collectTransports(pi.events);
			if (transports.length > 0) pi.registerTool(createSubagentTool(registry, widget, transports));
		}
		registry.clearFinished();
		widget.bind(ctx);
		void pruneOldSessions();
	});
	pi.on("session_shutdown", () => widget.dispose());
}
