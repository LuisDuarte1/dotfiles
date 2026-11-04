import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "./guard.ts";
import { execOnWorkspace, findParentPlacement } from "./hyprland.ts";
import type { PaneSpec } from "./pane.ts";

export const PANE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pane.ts");

export type Opener = "kitty" | "tmux";

const FORWARDED_VALUE_FLAGS = new Set(["--mcp-profile"]);
const FORWARDED_BOOLEAN_FLAGS = new Set(["--web-search"]);
const STRIPPED_ENV = /^(TMUX|TMUX_PANE|LUISD_.*|KITTY_WINDOW_ID|KITTY_PID|KITTY_LISTEN_ON|PI_BTW_.*)$/;

// Headless fallback only: every key goes to pi, and the mouse wheel reaches pi or tmux's
// scrollback. With a display the runner gets kitty to itself, so nothing filters its escapes.
const SESSION_SETUP = (name: string) => [
	["set-option", "-t", name, "key-table", "off"],
	["set-option", "-t", name, "prefix", "None"],
	["set-option", "-t", name, "prefix2", "None"],
	["set-option", "-t", name, "mouse", "on"],
	["bind-key", "-T", "off", "WheelUpPane", "if-shell", "-F", "#{||:#{pane_in_mode},#{mouse_any_flag}}", "send-keys -M", "copy-mode -e"],
	["bind-key", "-T", "off", "WheelDownPane", "send-keys", "-M"],
];

// A runner that dies on startup would take the session down before kitty attaches, so the window
// just flashes shut; keep the dead pane and its error on screen until the viewer detaches.
const KEEP_FAILED = (name: string) => [
	["set-option", "-t", name, "remain-on-exit", "failed"],
	["set-hook", "-t", name, "client-detached", `if-shell -F '#{pane_dead}' 'kill-session -t ${name}'`],
];

export function piInvocation(argv = process.argv, execPath = process.execPath): string[] {
	const script = argv[1];
	if (script && existsSync(script)) return [execPath, script];
	return /^(node|bun)(\.exe)?$/i.test(path.basename(execPath)) ? ["pi"] : [execPath];
}

export function forwardedFlags(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		const name = arg.split("=", 1)[0];
		if (FORWARDED_VALUE_FLAGS.has(name)) {
			if (arg.includes("=")) out.push(arg);
			else if (i + 1 < argv.length) out.push(arg, argv[++i]);
		} else if (FORWARDED_BOOLEAN_FLAGS.has(name)) {
			out.push(arg);
		}
	}
	return out;
}

export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !STRIPPED_ENV.test(key)) out[key] = value;
	}
	return out;
}

const HIDDEN_SOCKETS = [
	"/run/docker.sock",
	"/run/containerd/containerd.sock",
	"/run/podman/podman.sock",
	"/var/snap/lxd/common/lxd/unix.socket",
	"/var/lib/lxd/unix.socket",
	"/run/libvirt/libvirt-sock",
	"/tmp/luisd.sock",
];
const UNSET_IN_SANDBOX = [
	"DBUS_SESSION_BUS_ADDRESS",
	"HYPRLAND_INSTANCE_SIGNATURE",
	"WAYLAND_DISPLAY",
	"DISPLAY",
	"TMUX",
	"TMUX_PANE",
	"DOCKER_HOST",
];

export interface SandboxHides {
	dirs: string[];
	sockets: string[];
}

// A read-only mount alone is escapable through any daemon that runs commands for us outside the
// namespace (tmux run-shell, systemd-run --user, hyprctl exec, docker -v), so their sockets go too.
export function sandboxHides(
	env: NodeJS.ProcessEnv,
	uid: number,
	exists: (target: string) => boolean,
): SandboxHides {
	const dirs = [env.XDG_RUNTIME_DIR, path.join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`), "/tmp/.X11-unix"];
	return {
		dirs: [...new Set(dirs.filter((dir): dir is string => Boolean(dir) && exists(dir as string)))],
		sockets: HIDDEN_SOCKETS.filter(exists),
	};
}

export interface SandboxSpec {
	origin: string;
	root: string;
	cwd: string;
	protect: string[];
	hides: SandboxHides;
	createdAt: string;
	command: string[];
}

export function piFlags(opts: { model?: string; thinking?: string; forwarded: string[]; approve: boolean }): string[] {
	return [
		...(opts.model ? ["--model", opts.model] : []),
		...(opts.thinking ? ["--thinking", opts.thinking] : []),
		...opts.forwarded,
		...(opts.approve ? ["--approve"] : []),
	];
}

export function sandboxArgv(spec: SandboxSpec): string[] {
	return [
		"bwrap",
		"--dev-bind", "/", "/",
		...spec.protect.flatMap((dir) => ["--ro-bind", dir, dir]),
		...spec.hides.dirs.flatMap((dir) => ["--perms", "0700", "--tmpfs", dir]), // tmux refuses looser modes
		...spec.hides.sockets.flatMap((socket) => ["--ro-bind", "/dev/null", socket]),
		...UNSET_IN_SANDBOX.flatMap((name) => ["--unsetenv", name]),
		"--die-with-parent",
		"--setenv", ENV.sandbox, "1",
		"--setenv", ENV.origin, spec.origin,
		"--setenv", ENV.root, spec.root,
		"--setenv", ENV.createdAt, spec.createdAt,
		"--setenv", ENV.promotable, "1", // only the pane runner can act on a promote request
		"--chdir", spec.cwd,
		"--",
		...spec.command,
	];
}

export function pickOpener(env: NodeJS.ProcessEnv, has: (bin: string) => boolean): Opener | undefined {
	const forced = env.PI_BTW_OPENER;
	if (forced === "kitty" || forced === "tmux") return has(forced) ? forced : undefined;
	if ((env.WAYLAND_DISPLAY || env.DISPLAY) && has("kitty")) return "kitty";
	return has("tmux") ? "tmux" : undefined;
}

export function tmuxSocket(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
	return path.join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, "default");
}

// tmux panes don't inherit our env and tmux splits any argv element ending in ";", so env and
// command travel in a 0600 spec file that the pane runner reads and deletes.
export function tmuxCommand(opts: { socket: string; name: string; cwd: string; specFile: string; node?: string }): string[] {
	const create = ["new-session", "-d", "-s", opts.name, "-x", "200", "-y", "50", "-c", opts.cwd];
	const runner = [opts.node ?? process.execPath, PANE_SCRIPT, opts.specFile];
	const setup = [...SESSION_SETUP(opts.name), ...KEEP_FAILED(opts.name)].flatMap((command) => [";", ...command]);
	return ["tmux", "-S", opts.socket, ...create, ...runner, ...setup];
}

// Kitty closes the window as soon as its child exits, so a runner that dies on startup would
// flash shut; the shell keeps the error up until Enter, and `trap :` lets Ctrl+C reach only pi.
const HOLD_ON_FAILURE = 'trap : INT; "$@" || { printf "\\n[btw] side window failed (status %s); press Enter to close " "$?"; read -r _; }';

export function kittyCommand(opts: { cwd: string; title: string; specFile: string; node?: string }): string[] {
	const runner = [opts.node ?? process.execPath, PANE_SCRIPT, opts.specFile];
	return ["kitty", "--directory", opts.cwd, "-T", opts.title, "sh", "-c", HOLD_ON_FAILURE, "btw", ...runner];
}

export function shellQuote(args: readonly string[]): string {
	return args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)).join(" ");
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function run(command: string[], env: Record<string, string>, cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("exit", (code) => {
			child.stderr.destroy(); // kitty --detach leaves a grandchild holding the pipe
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `${command[0]} exited with status ${code}`));
		});
	});
}

export async function openSideWindow(
	opener: Opener,
	opts: { id: string; cwd: string; title: string; spec: Omit<PaneSpec, "env"> },
): Promise<string> {
	const env = cleanEnv(process.env);
	const name = `btw-${opts.id}`;
	const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "pi-btw");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const specFile = path.join(dir, `${opts.id}.json`);
	await writeFile(specFile, JSON.stringify({ ...opts.spec, env } satisfies PaneSpec), { mode: 0o600 });
	let kittyFailure = "";
	if (opener === "kitty") {
		const command = kittyCommand({ cwd: opts.cwd, title: opts.title, specFile });
		const placement = await findParentPlacement();
		if (placement) {
			const placed = await execOnWorkspace(shellQuote(command), placement).then(
				() => true,
				() => false,
			);
			if (placed) return `a kitty window on workspace ${placement.workspace.name}`;
		}
		try {
			await run([command[0], "--detach", ...command.slice(1)], env, opts.cwd);
			return "a kitty window";
		} catch (error) {
			kittyFailure = `kitty failed (${reason(error)}); `;
		}
	}
	try {
		await run(tmuxCommand({ socket: tmuxSocket(), name, cwd: opts.cwd, specFile }), env, opts.cwd);
	} catch (error) {
		await rm(specFile, { force: true });
		throw kittyFailure ? new Error(`${kittyFailure}tmux: ${reason(error)}`) : error;
	}
	return `${kittyFailure}tmux session ${name} (attach: tmux attach -t ${name})`;
}
