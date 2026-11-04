import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import {
	cleanEnv,
	forwardedFlags,
	kittyCommand,
	PANE_SCRIPT,
	pickOpener,
	piFlags,
	sandboxArgv,
	shellQuote,
	tmuxCommand,
	tmuxSocket,
} from "./launch.ts";

test("forwardedFlags keeps mcp-profile and web-search, in both spellings, and stops at --", () => {
	assert.deepEqual(
		forwardedFlags(["--extension", "x.ts", "--mcp-profile", "portal", "--web-search", "--model", "m", "--mcp-profile=canvas"]),
		["--mcp-profile", "portal", "--web-search", "--mcp-profile=canvas"],
	);
	assert.deepEqual(forwardedFlags(["--", "--web-search"]), []);
	assert.deepEqual(forwardedFlags(["--mcp-profile"]), []);
});

test("cleanEnv drops the parent's tmux, luisd and kitty identity", () => {
	assert.deepEqual(
		cleanEnv({ TMUX: "x", TMUX_PANE: "%1", LUISD_AGENT_ID: "a", KITTY_WINDOW_ID: "1", PI_BTW_ROOT: "r", PATH: "/bin", PI_PROVIDER_TOKEN: "t" }),
		{ PATH: "/bin", PI_PROVIDER_TOKEN: "t" },
	);
});

test("piFlags renders model, thinking, forwarded flags and approve in order", () => {
	assert.deepEqual(piFlags({ model: "a/b", thinking: "high", forwarded: ["--web-search"], approve: true }), [
		"--model", "a/b", "--thinking", "high", "--web-search", "--approve",
	]);
	assert.deepEqual(piFlags({ forwarded: [], approve: false }), []);
});

test("sandboxArgv mounts protected dirs read-only, hides daemon sockets, then runs the command", () => {
	const argv = sandboxArgv({
		origin: "/w/repo",
		root: "/tmp/pi-btw/repo-1",
		cwd: "/tmp/pi-btw/repo-1/sub",
		protect: ["/w/repo", "/w/main/.git"],
		hides: { dirs: ["/run/user/1000", "/tmp/tmux-1000"], sockets: ["/run/docker.sock"] },
		createdAt: "now",
		command: ["node", "cli.js", "--session", "/s/btw/f.jsonl"],
	});
	const sep = argv.indexOf("--");
	const sandbox = argv.slice(0, sep).join(" ");
	assert.match(sandbox, /--ro-bind \/w\/repo \/w\/repo --ro-bind \/w\/main\/\.git \/w\/main\/\.git/);
	assert.match(sandbox, /--perms 0700 --tmpfs \/run\/user\/1000 --perms 0700 --tmpfs \/tmp\/tmux-1000 --ro-bind \/dev\/null \/run\/docker\.sock/);
	for (const name of ["DBUS_SESSION_BUS_ADDRESS", "HYPRLAND_INSTANCE_SIGNATURE", "TMUX", "DOCKER_HOST"]) {
		assert.match(sandbox, new RegExp(`--unsetenv ${name}( |$)`));
	}
	assert.match(sandbox, /--setenv PI_BTW_SANDBOX 1/);
	assert.match(sandbox, /--setenv PI_BTW_PROMOTABLE 1/);
	assert.match(sandbox, /--chdir \/tmp\/pi-btw\/repo-1\/sub/);
	assert.deepEqual(argv.slice(sep + 1), ["node", "cli.js", "--session", "/s/btw/f.jsonl"]);
});

test("pickOpener: a forced opener must exist; kitty needs a display, not tmux; tmux is the fallback", () => {
	const all = () => true;
	assert.equal(pickOpener({ PI_BTW_OPENER: "tmux", WAYLAND_DISPLAY: "w" }, all), "tmux");
	assert.equal(pickOpener({ WAYLAND_DISPLAY: "w" }, all), "kitty");
	assert.equal(pickOpener({ WAYLAND_DISPLAY: "w" }, (bin) => bin === "kitty"), "kitty");
	assert.equal(pickOpener({}, all), "tmux");
	assert.equal(pickOpener({ DISPLAY: ":0" }, (bin) => bin === "tmux"), "tmux");
	assert.equal(pickOpener({ WAYLAND_DISPLAY: "w", PI_BTW_OPENER: "kitty" }, (bin) => bin === "tmux"), undefined);
	assert.equal(pickOpener({}, (bin) => bin === "kitty"), undefined);
});

const socket = "/tmp/tmux-1000/default";

test("tmuxCommand runs the pane runner on the spec file, with luisd-style options in one tmux call", () => {
	const command = tmuxCommand({ socket, name: "btw-ab12", cwd: "/r", specFile: "/run/x.json", node: "/bin/node" });
	assert.deepEqual(command.slice(0, 13), [
		"tmux", "-S", socket, "new-session", "-d", "-s", "btw-ab12", "-x", "200", "-y", "50", "-c", "/r",
	]);
	assert.equal(command[13], "/bin/node");
	assert.match(command[14], /\/btw\/pane\.ts$/);
	assert.equal(command[15], "/run/x.json");
	assert.deepEqual(command.slice(16, 22), [";", "set-option", "-t", "btw-ab12", "key-table", "off"]);
	assert.deepEqual(command.filter((arg) => arg !== ";" && arg.endsWith(";")), [], "tmux would split on these");
});

test("tmuxCommand keeps a failed runner's pane on screen and drops the session once the viewer detaches", () => {
	const command = tmuxCommand({ socket, name: "btw-ab12", cwd: "/r", specFile: "/run/x.json", node: "/bin/node" });
	const setup = command.join(" ");
	assert.match(setup, /; set-option -t btw-ab12 remain-on-exit failed( |$)/);
	assert.ok(
		setup.endsWith("; set-hook -t btw-ab12 client-detached if-shell -F '#{pane_dead}' 'kill-session -t btw-ab12'"),
		setup,
	);
});

test("PANE_SCRIPT points at the pane runner shipped next to launch.ts", () => {
	assert.ok(existsSync(PANE_SCRIPT), PANE_SCRIPT);
});

test("kittyCommand runs the pane runner itself in kitty, held open only when it fails", () => {
	const command = kittyCommand({ cwd: "/r", title: "btw: q", specFile: "/run/x.json", node: "/bin/node" });
	assert.deepEqual(command.slice(0, 7), ["kitty", "--directory", "/r", "-T", "btw: q", "sh", "-c"]);
	assert.deepEqual(command.slice(8), ["btw", "/bin/node", PANE_SCRIPT, "/run/x.json"]);
	assert.match(command[7], /^trap : INT; "\$@" \|\| \{ printf .*; read -r _; \}$/);
	assert.equal(tmuxSocket({}, 1000), "/tmp/tmux-1000/default");
	assert.equal(tmuxSocket({ TMUX_TMPDIR: "/run/x" }, 7), "/run/x/tmux-7/default");
});

test("kittyCommand's shell waits for Enter after a failed runner and stays quiet after a clean exit", () => {
	const hold = (runner: string[]) => {
		const [, , , , , sh, flag, script, name] = kittyCommand({ cwd: "/r", title: "t", specFile: "/s" });
		return execFileSync(sh, [flag, script, name, ...runner], { input: "\n", encoding: "utf8" });
	};
	assert.match(hold(["sh", "-c", "exit 3"]), /side window failed \(status 3\); press Enter to close $/);
	assert.equal(hold(["true"]), "");
});

test("shellQuote quotes only what needs it", () => {
	assert.equal(shellQuote(["bwrap", "--ro-bind", "/a b", "it's"]), "bwrap --ro-bind '/a b' 'it'\\''s'");
});
