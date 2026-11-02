import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function run(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {},
): Promise<string> {
	const { stdout } = await execFileAsync(command, args, {
		env: options.env ?? process.env,
		cwd: options.cwd,
		timeout: options.timeout,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
}

export function git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	return run("git", args, { env });
}

export async function tryGit(args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	try {
		return await git(args, env);
	} catch {
		return undefined;
	}
}
