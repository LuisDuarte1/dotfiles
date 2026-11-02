import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sandboxArgv, sandboxHides, tmuxSocket } from "./launch.ts";

const hasBwrap = spawnSync("bwrap", ["--version"]).status === 0;

test("the generated sandbox blocks direct writes and every daemon route to the origin", { skip: !hasBwrap }, () => {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "btw-escape-")));
	try {
		const origin = path.join(dir, "origin");
		const reach = path.join(dir, "reachable");
		mkdirSync(origin);
		const script = [
			`touch ${origin}/direct`,
			`tmux -S ${tmuxSocket()} run-shell 'touch ${origin}/via-tmux'`,
			`systemd-run --user --quiet --wait touch ${origin}/via-systemd`,
			`tmux -S ${tmuxSocket()} list-sessions && echo tmux >> ${reach}`,
			`busctl --user list && echo systemd-user-bus >> ${reach}`,
			`hyprctl version && echo hyprland >> ${reach}`,
			`docker -H unix:///run/docker.sock version && echo docker >> ${reach}`,
		]
			.map((cmd) => `{ ${cmd}; } >/dev/null 2>&1`)
			.join("\n");
		const argv = sandboxArgv({
			origin,
			root: dir,
			cwd: dir,
			protect: [origin],
			hides: sandboxHides(process.env, process.getuid?.() ?? 0, existsSync),
			createdAt: "",
			command: ["bash", "-c", script],
		});
		spawnSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: 30_000 });
		assert.deepEqual(readdirSync(origin), []);
		assert.equal(existsSync(reach) ? readFileSync(reach, "utf8") : "", "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sandboxHides keeps only control sockets and dirs that exist", () => {
	const present = new Set(["/run/user/1000", "/tmp/tmux-1000", "/run/docker.sock"]);
	assert.deepEqual(sandboxHides({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000, (p) => present.has(p)), {
		dirs: ["/run/user/1000", "/tmp/tmux-1000"],
		sockets: ["/run/docker.sock"],
	});
	assert.deepEqual(sandboxHides({}, 1000, () => false), { dirs: [], sockets: [] });
});
