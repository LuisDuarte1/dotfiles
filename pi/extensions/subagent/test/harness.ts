import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "..");

export interface Sandbox {
	agentDir: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

// A throwaway PI_CODING_AGENT_DIR so parent and child load only the fake provider
// and this extension, and never touch the real config, sessions or models.
export function makeSandbox(options: { autoRetry?: boolean } = {}): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-e2e-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "work");
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(cwd);
	fs.symlinkSync(extensionDir, path.join(agentDir, "extensions", "subagent"));
	fs.symlinkSync(path.join(here, "fake-provider.ts"), path.join(agentDir, "extensions", "fake-provider.ts"));
	if (options.autoRetry) {
		fs.symlinkSync(path.resolve(extensionDir, "..", "auto-retry.ts"), path.join(agentDir, "extensions", "auto-retry.ts"));
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	}
	fs.writeFileSync(
		path.join(agentDir, "agents", "tester.md"),
		"---\ndescription: Test agent\nmodel: fake/child\n---\nYou are a test agent.\n",
	);
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	delete env.PI_CODING_AGENT;
	return { agentDir, cwd, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const BASE_ARGS = ["--no-session", "-nc", "-ns", "-np"];

export interface JsonEvent {
	type: string;
	[key: string]: any;
}

export function runJson(sandbox: Sandbox, prompt: string, timeoutMs = 60_000): Promise<JsonEvent[]> {
	return new Promise((resolve, reject) => {
		const proc = spawn("pi", ["--mode", "json", ...BASE_ARGS, "--model", "fake/parent", prompt], {
			cwd: sandbox.cwd,
			env: sandbox.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`pi timed out\n${stderr}`));
		}, timeoutMs);
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(`pi exited ${code}\n${stderr}`));
			resolve(stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
		});
	});
}

// Drives a parent pi over RPC so tests can act mid-run: send `/steer`, answer
// forwarded dialogs, and wait on specific events instead of fixed delays.
export class RpcSession {
	readonly events: JsonEvent[] = [];
	private readonly proc: ReturnType<typeof spawn>;
	private waiters: { match: (e: JsonEvent) => boolean; resolve: (e: JsonEvent) => void }[] = [];
	private nextId = 0;

	constructor(sandbox: Sandbox, model = "fake/parent") {
		this.proc = spawn("pi", ["--mode", "rpc", ...BASE_ARGS, "--model", model], { cwd: sandbox.cwd, env: sandbox.env });
		let buffer = "";
		this.proc.stdout?.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) this.dispatch(JSON.parse(line));
		});
	}

	private dispatch(event: JsonEvent): void {
		this.events.push(event);
		const ready = this.waiters.filter((w) => w.match(event));
		this.waiters = this.waiters.filter((w) => !ready.includes(w));
		for (const waiter of ready) waiter.resolve(event);
	}

	send(command: Record<string, unknown>): Promise<JsonEvent> {
		const id = `t${++this.nextId}`;
		const response = this.waitFor((e) => e.type === "response" && e.id === id);
		this.proc.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		return response;
	}

	respondUi(id: string, body: Record<string, unknown>): void {
		this.proc.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, ...body })}\n`);
	}

	waitFor(match: (e: JsonEvent) => boolean, timeoutMs = 30_000): Promise<JsonEvent> {
		const seen = this.events.find(match);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for event (${this.events.length} seen)`)), timeoutMs);
			this.waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this.proc.on("close", () => resolve());
			this.proc.stdin?.end();
		});
	}
}

export const isSubagentUpdate = (e: JsonEvent) => e.type === "tool_execution_update" && e.toolName === "subagent";
export const isSubagentEnd = (e: JsonEvent) => e.type === "tool_execution_end" && e.toolName === "subagent";

export function subagentResult(events: JsonEvent[]): JsonEvent["result"] {
	return events.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent")?.result;
}

export function finalAssistantText(events: JsonEvent[]): string {
	const ends = events.filter((e) => e.type === "message_end" && e.message.role === "assistant");
	const content = ends.at(-1)?.message.content ?? [];
	return content.map((part: { text?: string }) => part.text ?? "").join("");
}
