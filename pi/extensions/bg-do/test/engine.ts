import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = fileURLToPath(new URL("../bg_engine.xsh", import.meta.url));

export const HAVE_XONSH = spawnSync("xonsh", ["--version"]).status === 0;

export type Frame = Record<string, unknown>;

export const encode = (obj: unknown) => `${Buffer.from(JSON.stringify(obj), "utf8").toString("base64")}\n`;

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, what: string, ms = 15000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await delay(10);
	}
}

// Every frame is kept in arrival order, so a test can assert what came before what;
// lines that do not decode are kept too, since a torn frame is the bug to catch.
export class Client {
	frames: Frame[] = [];
	bad: string[] = [];
	closed = false;
	readonly socket: Socket;
	private buf = "";
	private cursor = 0;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (d: string) => {
			this.buf += d;
			for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
				const line = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 1);
				try {
					this.frames.push(JSON.parse(Buffer.from(line, "base64").toString("utf8")) as Frame);
				} catch {
					this.bad.push(line.slice(0, 80));
				}
			}
		});
		socket.on("close", () => {
			this.closed = true;
		});
		socket.on("error", () => {});
	}

	async next(pred: (f: Frame) => boolean, what: string, ms?: number): Promise<Frame> {
		let hit: Frame | undefined;
		await until(
			() => {
				const i = this.frames.findIndex((f, n) => n >= this.cursor && pred(f));
				if (i < 0) return false;
				hit = this.frames[i];
				this.cursor = i + 1;
				return true;
			},
			what,
			ms,
		);
		return hit as Frame;
	}

	async run(code: string, ms?: number): Promise<{ out: string; err: string | null }> {
		this.socket.write(encode({ code }));
		const f = await this.next((f) => !("event" in f) && !("ready" in f), `reply to ${code.slice(0, 40)}`, ms);
		return { out: f.out as string, err: f.err as string | null };
	}

	events(kind: string): Frame[] {
		return this.frames.filter((f) => f.event === kind);
	}

	close(): Promise<void> {
		this.socket.destroy();
		return until(() => this.closed, "client close");
	}
}

export interface Engine {
	dir: string;
	sock: string;
	proc: ChildProcess;
	stderr: () => string;
	connect(): Promise<Client>;
	stop(): Promise<void>;
}

export async function startEngine(): Promise<Engine> {
	const dir = mkdtempSync(join(tmpdir(), "bg-do-engine-"));
	const sock = join(dir, "engine.sock");
	let stderr = "";
	const proc = spawn("xonsh", ["--no-rc", ENGINE], {
		cwd: dir,
		env: { ...process.env, BG_DO_SOCK: sock, TMPDIR: dir },
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	proc.stderr?.on("data", (d) => {
		stderr += d;
	});
	let exited = false;
	proc.on("exit", () => {
		exited = true;
	});
	const open = (): Promise<Client> =>
		new Promise((resolve, reject) => {
			const s = connect(sock);
			s.once("error", reject);
			s.once("connect", () => {
				const c = new Client(s);
				c.next((f) => f.ready === true, "ready").then(() => resolve(c), reject);
			});
		});
	const engine: Engine = {
		dir,
		sock,
		proc,
		stderr: () => stderr,
		async connect() {
			const end = Date.now() + 15000;
			for (;;) {
				try {
					return await open();
				} catch (e) {
					if (exited || Date.now() > end) throw new Error(`engine did not accept: ${e}\n${stderr}`);
					await delay(50);
				}
			}
		},
		async stop() {
			if (!exited) {
				try {
					const c = await open();
					c.socket.write(encode({ shutdown: true }));
					await until(() => exited, "engine exit", 5000);
				} catch {
					try {
						process.kill(-(proc.pid as number), "SIGKILL");
					} catch {}
				}
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return engine;
}
