import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "./guard.ts";

export const SHIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_REQUEST = 8192;
const OK = "ok";

// The browser runs outside the sandbox with the user's cookies, so only loopback pages (which
// the sandbox can already reach with curl) get through; files and other schemes never do.
export function loopbackUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" || url.username || url.password) return undefined;
	return LOOPBACK_HOSTS.has(url.hostname) ? url.href : undefined;
}

export function openInBrowser(url: string, env: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("xdg-open", [url], { env, detached: true, stdio: "ignore" });
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
		child.once("error", reject);
	});
}

export function serveOpen(socket: string, open: (url: string) => Promise<void>): Promise<net.Server> {
	rmSync(socket, { force: true });
	const server = net.createServer({ allowHalfOpen: true }, (conn) => {
		let raw = "";
		conn.setEncoding("utf8");
		conn.on("error", () => conn.destroy());
		conn.on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > MAX_REQUEST) conn.destroy();
		});
		conn.on("end", async () => {
			const url = loopbackUrl(raw.trim());
			if (!url) return conn.end(`only http://127.0.0.1, localhost or [::1] URLs can leave the btw sandbox, not ${JSON.stringify(raw.trim())}`);
			try {
				await open(url);
				conn.end(OK);
			} catch (error) {
				conn.end(`could not open ${url}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, () => {
			server.off("error", reject).on("error", () => undefined);
			resolve(server);
		});
	});
}

export function closeOpen(server: net.Server, socket: string): void {
	server.close();
	rmSync(socket, { force: true });
}

export function requestOpen(socket: string, target: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let reply = "";
		const conn = net.connect(socket, () => conn.end(target));
		conn.setEncoding("utf8");
		conn.on("data", (chunk: string) => (reply += chunk));
		conn.on("end", () => resolve(reply));
		conn.on("error", reject);
	});
}

async function main(args: string[]): Promise<number> {
	const socket = process.env[ENV.openSocket];
	if (args.length !== 1) {
		console.error("btw open: usage: open <http://127.0.0.1:PORT/...>");
		return 2;
	}
	const unreachable = `btw open: this sandbox can't reach the desktop; ask the user to open ${args[0]}`;
	if (!socket) {
		console.error(unreachable);
		return 1;
	}
	try {
		const reply = await requestOpen(socket, args[0]);
		if (reply === OK) return 0;
		console.error(`btw open: ${reply || "the pane runner gave no answer"}`);
	} catch {
		console.error(unreachable);
	}
	return 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
