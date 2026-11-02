import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandInput = DistributiveOmit<RpcCommand, "id">;
export type UiResponseBody = DistributiveOmit<RpcExtensionUIResponse, "type" | "id">;

export interface RpcResponseRecord {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

export interface RpcChildOptions {
	command: string;
	args: string[];
	cwd: string;
	onEvent: (event: JsonAgentSessionEvent) => void;
	onUiRequest: (request: RpcExtensionUIRequest) => void;
	onStderr?: (chunk: string) => void;
}

// What the runner needs from a child: a local `pi --mode rpc` process, or one from a transport
// extension (transport.ts), so both get the same widget, inspector, steering and dialog handling.
export interface RpcChannel {
	readonly exited: Promise<number>;
	readonly running: boolean;
	request(command: RpcCommandInput, timeoutMs?: number): Promise<RpcResponseRecord>;
	respondUi(id: string, body: UiResponseBody): void;
	closeInput(): void;
	kill(signal: NodeJS.Signals): void;
	prepare?(): Promise<{ resumed: boolean; sessionFile?: string }>;
}

// Node's readline also splits on U+2028/U+2029, which are legal inside JSON
// strings, so the RPC docs require splitting on LF only.
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
	let buffer = "";
	const emit = (line: string) => {
		const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (trimmed.trim()) onLine(trimmed);
	};
	return {
		push(chunk) {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				emit(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		},
		flush() {
			if (buffer) emit(buffer);
			buffer = "";
		},
	};
}

export class RpcChild implements RpcChannel {
	readonly exited: Promise<number>;
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, (response: RpcResponseRecord) => void>();
	private nextId = 0;
	private inputClosed = false;
	private hasExited = false;
	private readonly options: RpcChildOptions;

	constructor(options: RpcChildOptions) {
		this.options = options;
		this.proc = spawn(options.command, options.args, { cwd: options.cwd, shell: false, stdio: "pipe" });
		const splitter = createLineSplitter((line) => this.handleLine(line));
		this.proc.stdout.setEncoding("utf-8");
		this.proc.stderr.setEncoding("utf-8");
		this.proc.stdout.on("data", (chunk: string) => splitter.push(chunk));
		this.proc.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
		this.proc.stdin.on("error", () => {});
		this.exited = new Promise((resolve) => {
			const finish = (code: number) => {
				if (this.hasExited) return;
				this.hasExited = true;
				splitter.flush();
				this.failPending("subagent process exited");
				resolve(code);
			};
			this.proc.on("close", (code) => finish(code ?? 1));
			this.proc.on("error", (error) => {
				options.onStderr?.(`${error.message}\n`);
				finish(1);
			});
		});
	}

	get running(): boolean {
		return !this.hasExited;
	}

	request(command: RpcCommandInput, timeoutMs?: number): Promise<RpcResponseRecord> {
		const id = `r${++this.nextId}`;
		return new Promise((resolve) => {
			if (!this.write({ ...command, id })) {
				resolve({ type: "response", id, command: command.type, success: false, error: "subagent is not running" });
				return;
			}
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							this.pending.delete(id);
							resolve({ type: "response", id, command: command.type, success: false, error: "timed out" });
						}, timeoutMs);
			this.pending.set(id, (response) => {
				if (timer) clearTimeout(timer);
				resolve(response);
			});
		});
	}

	respondUi(id: string, body: UiResponseBody): void {
		this.write({ type: "extension_ui_response", id, ...body });
	}

	closeInput(): void {
		if (this.inputClosed) return;
		this.inputClosed = true;
		this.proc.stdin.end();
	}

	kill(signal: NodeJS.Signals): void {
		if (!this.hasExited) this.proc.kill(signal);
	}

	private write(record: object): boolean {
		if (this.inputClosed || this.hasExited) return false;
		this.proc.stdin.write(`${JSON.stringify(record)}\n`);
		return true;
	}

	private handleLine(line: string): void {
		let record: { type?: string; id?: string };
		try {
			record = JSON.parse(line);
		} catch {
			this.options.onStderr?.(`unparseable RPC line: ${line.slice(0, 200)}\n`);
			return;
		}
		if (record.type === "response") {
			const resolve = record.id ? this.pending.get(record.id) : undefined;
			if (resolve && record.id) {
				this.pending.delete(record.id);
				resolve(record as RpcResponseRecord);
			}
			return;
		}
		if (record.type === "extension_ui_request") {
			this.options.onUiRequest(record as RpcExtensionUIRequest);
			return;
		}
		this.options.onEvent(record as JsonAgentSessionEvent);
	}

	private failPending(error: string): void {
		for (const [id, resolve] of this.pending) {
			resolve({ type: "response", id, command: "unknown", success: false, error });
		}
		this.pending.clear();
	}
}
