export type InterruptCause = "timeout" | "user";

// The engine reports every SIGINT with this text; only the extension knows whether
// its own timer or the user's abort sent it.
export const ENGINE_INTERRUPT = "Interrupted (timeout)";

export const SUBPROC_HINT = "xonsh `$()` takes one command; use `$(bash -c '…')`.";

export interface ErrorInput {
	code: string;
	err: string;
	cause?: InterruptCause;
	timeoutS: number;
}

export function errorText({ code, err, cause, timeoutS }: ErrorInput): string {
	if (err.trim() === ENGINE_INTERRUPT) {
		if (cause === "user") return "Interrupted by the user, not a timeout. Background jobs are still running.";
		return `Interrupted: snippet hit the ${timeoutS}s bg_do timeout. Background jobs are still running — poll them (bg.list/bg.output/bg.wait_for) in another call, and pass timeout_seconds to wait longer.`;
	}
	if (err.includes("SyntaxError") && code.includes("$(") && /&&|\|\|/.test(code)) {
		return `${err.trimEnd()}\n${SUBPROC_HINT}`;
	}
	return err;
}

// The tool description carries the API block from USAGE.md, so subagents that never
// read the file still call real methods, and the two cannot drift apart.
export function apiBlock(usage: string): string {
	const section = usage.indexOf("## The `bg` API");
	if (section < 0) return "";
	const match = /```\n([\s\S]*?)\n```/.exec(usage.slice(section));
	return match ? match[1] : "";
}
