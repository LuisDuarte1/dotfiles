// The sandbox has no display, so a paste must come through kitty's paste-event protocol (private
// mode 5522): kitty lists the clipboard's types with a one-use token and hands over what we ask for.
export const ENABLE_PASTE_EVENTS = "\x1b[?5522$p\x1b[?5522h";
export const DISABLE_PASTE_EVENTS = "\x1b[?5522l";

const PACKET_START = "\x1b]5522;";
const DECRPM = /^\x1b\[\?5522;(\d)\$y$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_TYPES = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "TEXT", "STRING"];

export type PasteResult =
	| { kind: "image"; mime: string; bytes: Buffer }
	| { kind: "text"; text: string }
	| { kind: "error"; message: string };

export type Outcome = { consume: false } | { consume: true; result?: PasteResult };

export interface Packet {
	meta: Record<string, string>;
	payload: string;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64");

export function parsePacket(packet: string): Packet | undefined {
	if (!packet.startsWith(PACKET_START)) return undefined;
	const body = packet.slice(PACKET_START.length).replace(/(\x07|\x1b\\)$/, "");
	const [header, payload = ""] = body.split(";", 2);
	const meta: Record<string, string> = {};
	for (const field of header.split(":")) {
		const eq = field.indexOf("=");
		if (eq > 0) meta[field.slice(0, eq)] = field.slice(eq + 1);
	}
	return { meta, payload };
}

export function pickMime(types: readonly string[]): string | undefined {
	return [...IMAGE_TYPES, ...TEXT_TYPES].find((type) => types.includes(type));
}

export function readRequest(mime: string, pw: string | undefined, loc: string | undefined): string {
	const auth = pw ? `:pw=${pw}:name=${b64("Paste event")}` : "";
	return `${PACKET_START}type=read${loc ? `:loc=${loc}` : ""}${auth};${b64(mime)}\x1b\\`;
}

// The text goes back to pi wrapped in bracketed-paste markers, so a copied end marker would let
// the rest of the clipboard run as keystrokes; removal repeats until none can re-form.
export function withoutPasteMarkers(text: string): string {
	for (let prev = ""; prev !== text; ) [prev, text] = [text, text.replace(/\x1b\[20[01]~/g, "")];
	return text;
}

function packetEnd(buffer: string): number {
	const bel = buffer.indexOf("\x07");
	const st = buffer.indexOf("\x1b\\");
	if (bel < 0) return st < 0 ? -1 : st + 2;
	return st < 0 || bel < st ? bel + 1 : st + 2;
}

type Phase =
	| { kind: "idle" }
	| { kind: "listing"; pw?: string; loc?: string; types: string[] }
	| { kind: "reading"; mime: string; chunks: Buffer[] };

// pi's input buffer gives up on an escape sequence that stalls mid-way and replays it as keys, so
// a split packet arrives as "\x1b]" plus loose text; everything is collected until a terminator.
export class PasteReader {
	supported: boolean | undefined;
	private phase: Phase = { kind: "idle" };
	private partial = "";
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	get busy(): boolean {
		return this.phase.kind !== "idle" || this.partial !== "";
	}

	input(data: string): Outcome {
		const decrpm = DECRPM.exec(data);
		if (decrpm) {
			this.supported = ["1", "2", "3"].includes(decrpm[1]);
			return { consume: true };
		}
		const starts = data.startsWith(PACKET_START) || (data === "\x1b]" && this.phase.kind !== "idle");
		if (!starts && this.partial === "") return { consume: false };
		this.partial += data;
		let result: PasteResult | undefined;
		for (let end = packetEnd(this.partial); end > 0; end = packetEnd(this.partial)) {
			const packet = parsePacket(this.partial.slice(0, end));
			this.partial = this.partial.slice(end);
			if (packet) result = this.handle(packet) ?? result;
		}
		if (!PACKET_START.startsWith(this.partial) && !this.partial.startsWith(PACKET_START)) this.partial = "";
		return { consume: true, result };
	}

	abort(message: string): PasteResult | undefined {
		const wasBusy = this.busy;
		this.phase = { kind: "idle" };
		this.partial = "";
		return wasBusy ? { kind: "error", message } : undefined;
	}

	private fail(message: string): PasteResult {
		this.phase = { kind: "idle" };
		return { kind: "error", message };
	}

	private handle({ meta, payload }: Packet): PasteResult | undefined {
		const status = meta.status;
		const mime = meta.mime ? unb64(meta.mime).toString() : undefined;
		if (status === "OK" && meta.pw) {
			this.phase = { kind: "listing", pw: meta.pw, loc: meta.loc, types: [] };
			return undefined;
		}
		const phase = this.phase;
		if (status === "OK") {
			if (phase.kind === "idle") this.phase = { kind: "listing", loc: meta.loc, types: [] };
			return undefined;
		}
		if (status === "DATA" && mime === "." && phase.kind === "listing") {
			phase.types.push(...unb64(payload).toString().trim().split(/\s+/).filter(Boolean));
			return undefined;
		}
		if (status === "DATA" && phase.kind === "reading" && mime === phase.mime) {
			phase.chunks.push(unb64(payload));
			return undefined;
		}
		if (status === "DONE" && phase.kind === "listing") {
			const wanted = pickMime(phase.types);
			if (!wanted) return this.fail(`nothing pi can paste on the clipboard (${phase.types.join(", ") || "empty"})`);
			this.phase = { kind: "reading", mime: wanted, chunks: [] };
			this.write(readRequest(wanted, phase.pw, phase.loc));
			return undefined;
		}
		if (status === "DONE" && phase.kind === "reading") {
			this.phase = { kind: "idle" };
			const bytes = Buffer.concat(phase.chunks);
			if (IMAGE_TYPES.includes(phase.mime)) return { kind: "image", mime: phase.mime, bytes };
			return { kind: "text", text: withoutPasteMarkers(bytes.toString(phase.mime === "STRING" ? "latin1" : "utf8")) };
		}
		if (status && status !== "DATA" && status !== "DONE") return this.fail(`kitty refused the paste (${status})`);
		return undefined;
	}
}
