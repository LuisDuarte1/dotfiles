import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beaconDir, forwardableFlags, processStartTime, removeBeacon, writeBeacon } from "./beacon.ts";

const EXIT_HOOK = Symbol.for("pi.session-beacon.exit-hook");

function tmuxSessionName(env: NodeJS.ProcessEnv): string | null {
	if (env.LUISD_TMUX) return env.LUISD_TMUX;
	if (!env.TMUX || !env.TMUX_PANE) return null;
	try {
		const name = execFileSync("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#{session_name}"], {
			encoding: "utf8",
			timeout: 2000,
		}).trim();
		return name || null;
	} catch {
		return null;
	}
}

// Publishes which session file this interactive pi is on, so `agent-layout snapshot` can map
// terminal windows to sessions; nothing outside the process can recover that mapping.
export default function sessionBeacon(pi: ExtensionAPI): void {
	const dir = beaconDir();
	const startTime = processStartTime(process.pid);
	if (!startTime) return;

	let tmuxSession: string | null | undefined;
	let active = false;

	const publish = (ctx: ExtensionContext, sessionName: string | null) => {
		tmuxSession ??= tmuxSessionName(process.env);
		try {
			writeBeacon(dir, {
				version: 1,
				pid: process.pid,
				startTime,
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName,
				flags: forwardableFlags(process.argv.slice(2)),
				tmuxSession,
				updatedAt: new Date().toISOString(),
			});
		} catch {}
	};

	pi.on("session_start", (_event, ctx) => {
		active = ctx.hasUI;
		if (!active) return;
		publish(ctx, ctx.sessionManager.getSessionName() ?? null);

		const state = globalThis as { [EXIT_HOOK]?: true };
		if (!state[EXIT_HOOK]) {
			state[EXIT_HOOK] = true;
			process.once("exit", () => removeBeacon(dir, process.pid));
		}
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (active) publish(ctx, event.name ?? null);
	});

	pi.on("session_shutdown", (event) => {
		if (active && event.reason === "quit") removeBeacon(dir, process.pid);
	});
}
