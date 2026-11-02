import * as fs from "node:fs";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { RunControls } from "./registry.ts";
import { type RpcChannel, RpcChild, type RpcChildOptions, type RpcResponseRecord, type UiResponseBody } from "./rpc.ts";
import { addNote, applyEvent, oneLine, type RunState } from "./run.ts";

const STDERR_LIMIT = 20_000;
const SHUTDOWN_GRACE_MS = 5_000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RunChildOptions {
	run: RunState;
	command: string;
	args: string[];
	cwd: string;
	prompt: string;
	signal?: AbortSignal;
	onChange: () => void;
	onControls?: (controls: RunControls | undefined) => void;
	forwardDialog?: (request: RpcExtensionUIRequest) => Promise<UiResponseBody>;
	createChild?: (options: RpcChildOptions) => RpcChannel;
	// A durable child keeps running when this call is aborted: abort detaches, and calling again with the
	// same remote run id reattaches instead of starting over.
	durable?: boolean;
}

const failure = (response: RpcResponseRecord) => (response.success ? undefined : (response.error ?? "failed"));

function dialogTitle(request: RpcExtensionUIRequest): string {
	return "title" in request ? request.title : request.method;
}

function describeAnswer(body: UiResponseBody): string {
	if ("cancelled" in body) return "cancelled";
	if ("confirmed" in body) return body.confirmed ? "yes" : "no";
	return oneLine(body.value, 80);
}

const delay = (ms: number) =>
	new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref());

export async function runChild(options: RunChildOptions): Promise<void> {
	const { run, signal, onChange } = options;
	let markSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		markSettled = resolve;
	});

	const handleUi = (request: RpcExtensionUIRequest, respond: (body: UiResponseBody) => void) => {
		if (request.method === "notify") {
			addNote(run, request.notifyType ?? "info", request.message);
			onChange();
		} else if (DIALOG_METHODS.has(request.method)) {
			const forward = options.forwardDialog;
			if (!forward) {
				addNote(run, "warning", `dialog "${dialogTitle(request)}" cancelled (no UI)`);
				respond({ cancelled: true });
				onChange();
				return;
			}
			run.activity = `waiting for you: ${dialogTitle(request)}`;
			onChange();
			forward(request).then(
				(body) => {
					addNote(run, "info", `asked "${dialogTitle(request)}" → ${describeAnswer(body)}`);
					respond(body);
					onChange();
				},
				() => respond({ cancelled: true }),
			);
		}
	};

	let closing = false;
	let stopped = false;
	let sawSettled = false;
	const whenOpen = async (action: () => Promise<RpcResponseRecord>) =>
		closing ? "the subagent already finished" : failure(await action());
	const controls: RunControls = {
		steer: (text) => whenOpen(() => child.request({ type: "steer", message: text }, SHUTDOWN_GRACE_MS)),
		followUp: (text) => whenOpen(() => child.request({ type: "follow_up", message: text }, SHUTDOWN_GRACE_MS)),
		stop: () =>
			whenOpen(() => {
				stopped = true;
				addNote(run, "warning", "stopped by the user");
				onChange();
				return child.request({ type: "abort" }, SHUTDOWN_GRACE_MS);
			}),
	};

	const childOptions: RpcChildOptions = {
		command: options.command,
		args: options.args,
		cwd: options.cwd,
		onEvent: (event) => {
			applyEvent(run, event);
			if (event.type === "agent_settled") {
				sawSettled = true;
				closing = true;
				options.onControls?.(undefined);
				markSettled();
			}
			onChange();
		},
		onUiRequest: (request) => handleUi(request, (body) => child.respondUi(request.id, body)),
		onStderr: (chunk) => {
			run.stderr = (run.stderr + chunk).slice(-STDERR_LIMIT);
		},
	};
	const child: RpcChannel = options.createChild ? options.createChild(childOptions) : new RpcChild(childOptions);

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		if (options.durable) {
			addNote(run, "info", "detached; the remote run keeps going");
			child.kill("SIGHUP");
			return;
		}
		void child.request({ type: "abort" }, SHUTDOWN_GRACE_MS).then(() => child.closeInput());
		setTimeout(() => child.kill("SIGTERM"), SHUTDOWN_GRACE_MS).unref();
		setTimeout(() => child.kill("SIGKILL"), 2 * SHUTDOWN_GRACE_MS).unref();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	try {
		options.onControls?.(controls);
		const prepared = await child.prepare?.();
		const accepted: RpcResponseRecord = prepared?.resumed
			? { type: "response", command: "prompt", success: true }
			: await child.request({ type: "prompt", message: options.prompt });
		if (accepted.success) await Promise.race([settled, child.exited]);
		else run.stderr += `prompt rejected: ${accepted.error ?? "unknown error"}\n`;

		if (child.running) {
			const stats = await child.request({ type: "get_session_stats" }, SHUTDOWN_GRACE_MS);
			const sessionFile = (stats.data as { sessionFile?: string } | undefined)?.sessionFile;
			if (sessionFile && fs.existsSync(sessionFile)) run.sessionFile = sessionFile;
		}
		if (!run.sessionFile && prepared?.sessionFile && fs.existsSync(prepared.sessionFile)) run.sessionFile = prepared.sessionFile;
		child.closeInput();
		if ((await Promise.race([child.exited, delay(SHUTDOWN_GRACE_MS)])) === undefined) child.kill("SIGTERM");
		const exitCode = await child.exited;

		const last = run.lastAssistant;
		const lostDurable = options.durable === true && !sawSettled; // a remote run that ended unsettled lost its channel
		const failed = lostDurable || !accepted.success || !last || last.stopReason === "error" || last.stopReason === "aborted";
		run.status = aborted ? "aborted" : stopped ? "stopped" : failed ? "error" : "done";
		if (run.status === "error" && !last?.errorMessage && !run.stderr.trim()) run.stderr = `subagent exited ${exitCode}`;
		if (lostDurable && last?.errorMessage) run.stderr = `${run.stderr}${last.errorMessage}\n`;
	} finally {
		closing = true;
		options.onControls?.(undefined);
		signal?.removeEventListener("abort", onAbort);
		child.kill("SIGKILL");
		run.endedAt = Date.now();
		run.activity = "";
		onChange();
	}
}
