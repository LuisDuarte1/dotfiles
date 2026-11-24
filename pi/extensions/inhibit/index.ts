import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GRACE_MS, INITIAL_STATE, inhibitArgs, type LockEvent, type LockState, lockWhy, runningJobs, step } from "./lock.ts";

// Only pi holds the write end of `cat`'s stdin, so the lock ends however pi exits, even on SIGKILL.
// Its own session keeps a stray terminal SIGINT or SIGHUP from dropping the lock while pi lives.
export function spawnInhibitor(why: string): ChildProcess {
	const child = spawn("systemd-inhibit", inhibitArgs(why), { detached: true, stdio: ["pipe", "ignore", "ignore"] });
	child.stdin?.on("error", () => {});
	(child.stdin as { unref?: () => void } | null)?.unref?.();
	child.unref();
	return child;
}

// Subagent children take their own lock rather than skip it: nothing reliably marks a pi process
// as a subagent child, and a second inhibitor next to the parent's is harmless.
export default function inhibit(pi: ExtensionAPI) {
	let state: LockState = { ...INITIAL_STATE };
	let ctx: ExtensionContext | undefined;
	let child: ChildProcess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const why = () => {
		try {
			if (ctx) {
				const sm = ctx.sessionManager;
				return lockWhy({ name: sm.getSessionName(), id: sm.getSessionId(), cwd: ctx.cwd }, state);
			}
		} catch {}
		return lockWhy({ id: "pi", cwd: process.cwd() }, state);
	};

	const acquire = () => {
		let spawned: ChildProcess;
		try {
			spawned = spawnInhibitor(why());
		} catch {
			send({ type: "lock_exited", missing: false });
			return;
		}
		child = spawned;
		const lost = (missing: boolean) => {
			if (child !== spawned) return;
			child = undefined;
			send({ type: "lock_exited", missing });
		};
		spawned.once("error", (error) => lost((error as NodeJS.ErrnoException).code === "ENOENT"));
		spawned.once("exit", () => lost(false));
	};

	const release = () => {
		const held = child;
		child = undefined;
		held?.stdin?.end();
	};

	const send = (event: LockEvent) => {
		const result = step(state, event);
		state = result.state;
		for (const action of result.actions) {
			if (action === "acquire") acquire();
			else if (action === "release") release();
			else if (action === "cancel_grace") {
				clearTimeout(timer);
				timer = undefined;
			} else {
				timer = setTimeout(() => {
					timer = undefined;
					send({ type: "grace_expired" });
				}, GRACE_MS);
				timer.unref?.();
			}
		}
	};

	pi.events.on("bg-do:running", (data) => {
		const running = runningJobs(data);
		if (running !== undefined) send({ type: "jobs", running });
	});

	pi.on("session_start", (_event, c) => {
		ctx = c;
	});

	pi.on("agent_start", (_event, c) => {
		ctx = c;
		send({ type: "turn_start" });
	});

	pi.on("agent_settled", () => send({ type: "turn_settled" }));

	pi.on("session_shutdown", () => send({ type: "shutdown" }));
}
