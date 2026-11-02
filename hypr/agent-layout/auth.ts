import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

// Overlays may install a pi-auth hook (`check` / `login`) that refreshes provider credentials;
// restore runs it once up front, or every restored terminal would start its own login.
export function authHook(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
	const hook = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "dotfiles", "hooks", "pi-auth");
	try {
		accessSync(hook, constants.X_OK);
		return hook;
	} catch {
		return undefined;
	}
}

export function runHook(hook: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(hook, args, { stdio: "ignore" });
		child.on("exit", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}
