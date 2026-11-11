import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeOpen, loopbackUrl, requestOpen, SHIM_DIR, serveOpen } from "./open.ts";

test("loopbackUrl lets only http loopback pages out, normalized", () => {
	assert.equal(loopbackUrl("http://127.0.0.1:43561/"), "http://127.0.0.1:43561/");
	assert.equal(loopbackUrl("http://LOCALHOST:3000/a b?x=1#f"), "http://localhost:3000/a%20b?x=1#f");
	assert.equal(loopbackUrl("http://[::1]:8080"), "http://[::1]:8080/");
	for (const raw of [
		"https://127.0.0.1/",
		"file:///etc/passwd",
		"http://example.com/",
		"http://127.0.0.1.example.com/",
		"http://user:pw@127.0.0.1/",
		"javascript:alert(1)",
		"/tmp/x.html",
		"",
	]) {
		assert.equal(loopbackUrl(raw), undefined, raw);
	}
});

async function withBridge(fn: (socket: string, opened: string[]) => Promise<void>, fail?: Error) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "btw-open-"));
	const socket = path.join(dir, "x.sock");
	const opened: string[] = [];
	const server = await serveOpen(socket, async (url) => {
		if (fail) throw fail;
		opened.push(url);
	});
	try {
		await fn(socket, opened);
	} finally {
		closeOpen(server, socket);
		assert.equal(existsSync(socket), false);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("serveOpen opens accepted URLs and explains refusals and failures", async () => {
	await withBridge(async (socket, opened) => {
		assert.equal(await requestOpen(socket, "http://127.0.0.1:43561/"), "ok");
		assert.match(await requestOpen(socket, "file:///etc/passwd"), /only http:\/\/127\.0\.0\.1.*not "file:\/\/\/etc\/passwd"/);
		assert.deepEqual(opened, ["http://127.0.0.1:43561/"]);
	});
	await withBridge(async (socket) => {
		assert.equal(await requestOpen(socket, "http://localhost/"), "could not open http://localhost/: no xdg-open");
	}, new Error("no xdg-open"));
});

function shim(name: string, args: string[], env: Record<string, string>) {
	return new Promise<{ code: number; stderr: string }>((resolve) => {
		const child = execFile(path.join(SHIM_DIR, name), args, { env: { PATH: process.env.PATH ?? "", PI_BTW_NODE: process.execPath, ...env } });
		let stderr = "";
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
	});
}

test("the open and xdg-open shims go through the bridge and fail loudly without it", async () => {
	await withBridge(async (socket, opened) => {
		assert.deepEqual(await shim("open", ["http://127.0.0.1:1/"], { PI_BTW_OPEN_SOCKET: socket }), { code: 0, stderr: "" });
		assert.equal((await shim("xdg-open", ["http://localhost:2/"], { PI_BTW_OPEN_SOCKET: socket })).code, 0);
		const refused = await shim("xdg-open", ["notes.pdf"], { PI_BTW_OPEN_SOCKET: socket });
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /only http:\/\/127\.0\.0\.1/);
		assert.deepEqual(opened, ["http://127.0.0.1:1/", "http://localhost:2/"]);
	});
	const missing = await shim("open", ["http://127.0.0.1:1/"], { PI_BTW_OPEN_SOCKET: "/nonexistent/x.sock" });
	assert.equal(missing.code, 1);
	assert.match(missing.stderr, /can't reach the desktop; ask the user to open http:\/\/127\.0\.0\.1:1\//);
	assert.equal((await shim("open", [], {})).code, 2);
});
