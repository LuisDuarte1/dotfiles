export type InterruptCause = "timeout" | "user";

// The engine reports every SIGINT with this text; only the extension knows whether
// its own timer or the user's abort sent it.
export const ENGINE_INTERRUPT = "Interrupted (timeout)";

export interface ErrorInput {
	err: string;
	cause?: InterruptCause;
	timeoutS: number;
}

export function errorText({ err, cause, timeoutS }: ErrorInput): string {
	if (err.trim() !== ENGINE_INTERRUPT) return err;
	if (cause === "user") return "Interrupted by the user, not a timeout. Background jobs are still running.";
	return `Interrupted: snippet hit the ${timeoutS}s bg_do timeout. Background jobs are still running — poll them (bg.list/bg.output/bg.wait_for) in another call, and pass timeout_seconds to wait longer.`;
}
