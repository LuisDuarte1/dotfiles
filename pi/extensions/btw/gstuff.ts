import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StackFrame {
	number: number;
	branch: string;
}

export interface StackRef {
	stack: string;
	frame: number;
}

interface StackFile {
	name?: string;
	frames?: StackFrame[];
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
}

// Mirrors gstuff's repo_hash(): sha256 of the main worktree's canonical path, first 8 bytes,
// so every linked worktree of a repo resolves to the same stacks directory.
export function stacksDir(mainWorkdir: string, env: NodeJS.ProcessEnv = process.env): string {
	const hash = createHash("sha256").update(mainWorkdir).digest("hex").slice(0, 16);
	return path.join(configDir(env), "gstuff", "stacks", hash);
}

function readStacks(dir: string): StackFile[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json") && file !== "repo_commands.json")
		.flatMap((file) => {
			try {
				return [JSON.parse(readFileSync(path.join(dir, file), "utf8")) as StackFile];
			} catch {
				return [];
			}
		});
}

export function findFrame(dir: string, branch: string): StackRef | undefined {
	for (const stack of readStacks(dir)) {
		const frame = stack.frames?.find((candidate) => candidate.branch === branch);
		if (frame && stack.name) return { stack: stack.name, frame: frame.number };
	}
	return undefined;
}

export function stackExists(dir: string, name: string): boolean {
	return existsSync(path.join(dir, `${name}.json`));
}

export function username(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const file = path.join(configDir(env), "gstuff", "config.toml");
	if (existsSync(file)) {
		const section = readFileSync(file, "utf8").split(/^\s*\[/m).find((part) => part.startsWith("user]"));
		const name = section?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
		if (name) return name;
	}
	return env.USER || env.USERNAME || undefined;
}
