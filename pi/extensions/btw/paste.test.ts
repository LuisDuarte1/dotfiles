import assert from "node:assert/strict";
import test from "node:test";
import { type PasteResult, PasteReader, parsePacket, pickMime, readRequest, withoutPasteMarkers } from "./paste.ts";

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const packet = (header: string, payload?: string) => `\x1b]5522;${header}${payload === undefined ? "" : `;${payload}`}\x1b\\`;

function reader() {
	const written: string[] = [];
	const results: PasteResult[] = [];
	const paste = new PasteReader((data) => written.push(data));
	const collect = (result: PasteResult | undefined) => result && results.push(result);
	const r = {
		input(data: string) {
			const outcome = paste.input(data);
			if (outcome.consume) collect(outcome.result);
			return outcome.consume;
		},
		abort: (message: string) => collect(paste.abort(message)),
		get busy() {
			return paste.busy;
		},
		get supported() {
			return paste.supported;
		},
	};
	return { r, written, results };
}

function pasteEvent(types: string, extra = "") {
	return [
		packet(`type=read:status=OK${extra}:pw=${b64("secret")}`),
		packet(`type=read:status=DATA:mime=${b64(".")}:pw=${b64("secret")}`, b64(types)),
		packet(`type=read:status=DONE:pw=${b64("secret")}`),
	];
}

test("an image paste asks for the image with the event's token and delivers its bytes", () => {
	const { r, written, results } = reader();
	for (const p of pasteEvent("text/html image/png text/plain\n")) assert.equal(r.input(p), true);
	assert.deepEqual(written, [readRequest("image/png", b64("secret"), undefined)]);
	assert.match(written[0], /^\x1b\]5522;type=read:pw=c2VjcmV0:name=UGFzdGUgZXZlbnQ=;aW1hZ2UvcG5n\x1b\\$/);
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
	r.input(packet("type=read:status=OK"));
	r.input(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64(png.subarray(0, 4))));
	r.input(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64(png.subarray(4))));
	r.input(packet("type=read:status=DONE"));
	assert.deepEqual(results, [{ kind: "image", mime: "image/png", bytes: png }]);
	assert.equal(r.busy, false);
});

test("a text paste from the primary selection reads utf-8 text from the same location", () => {
	const { r, written, results } = reader();
	for (const p of pasteEvent("UTF8_STRING text/plain text/plain;charset=utf-8", ":loc=primary")) r.input(p);
	assert.equal(written[0], readRequest("text/plain;charset=utf-8", b64("secret"), "primary"));
	r.input(packet("type=read:status=OK"));
	r.input(packet(`type=read:status=DATA:mime=${b64("text/plain;charset=utf-8")}`, b64("olá ✓")));
	r.input(packet("type=read:status=DONE"));
	assert.deepEqual(results, [{ kind: "text", text: "olá ✓" }]);
});

test("a packet that pi's input buffer split and replayed as keys is reassembled", () => {
	const { r, results } = reader();
	const [ok, list, done] = pasteEvent("text/plain");
	r.input(ok);
	assert.equal(r.input("\x1b]"), true, "a lone ESC ] mid-paste starts a packet, not an Alt+] key");
	for (const ch of list.slice(2, -2)) assert.equal(r.input(ch), true);
	assert.equal(r.input("\x1b\\"), true);
	r.input(done);
	r.input(packet("type=read:status=OK"));
	const data = packet(`type=read:status=DATA:mime=${b64("text/plain")}`, b64("split"));
	r.input(data.slice(0, 20));
	r.input(data.slice(20));
	r.input(packet("type=read:status=DONE"));
	assert.deepEqual(results, [{ kind: "text", text: "split" }]);
});

test("ordinary input passes through when no paste is in flight", () => {
	const { r } = reader();
	for (const key of ["a", "\r", "\x1b]", "\x1b[13;2u", "\x1b]11;rgb:0000/0000/0000\x1b\\"]) assert.equal(r.input(key), false, JSON.stringify(key));
});

test("a stray ESC ] during a paste is dropped once the next byte rules out a packet", () => {
	const { r } = reader();
	r.input(pasteEvent("text/plain")[0]);
	r.input("\x1b]");
	r.input("x");
	assert.equal(r.input("y"), false, "input after the dropped fragment reaches pi again");
});

test("the DECRPM reply records whether the terminal supports paste events", () => {
	const { r } = reader();
	assert.equal(r.input("\x1b[?5522;2$y"), true);
	assert.equal(r.supported, true);
	r.input("\x1b[?5522;0$y");
	assert.equal(r.supported, false);
});

test("an unpasteable clipboard, a refusal and a stall each end the paste with an error", () => {
	const { r, written, results } = reader();
	for (const p of pasteEvent("application/x-thing")) r.input(p);
	assert.equal(written.length, 0);
	for (const p of pasteEvent("text/plain")) r.input(p);
	r.input(packet("type=read:status=EPERM"));
	for (const p of pasteEvent("text/plain")) r.input(p);
	r.abort("stalled");
	r.abort("idle aborts stay quiet");
	assert.deepEqual(
		results.map((result) => (result.kind === "error" ? result.message : result.kind)),
		["nothing pi can paste on the clipboard (application/x-thing)", "kitty refused the paste (EPERM)", "stalled"],
	);
	assert.equal(r.busy, false);
});

test("parsePacket keeps base64 padding in values and pickMime prefers images, then utf-8 text", () => {
	assert.deepEqual(parsePacket(packet("type=read:status=OK:pw=YQ==", "cGF5")), {
		meta: { type: "read", status: "OK", pw: "YQ==" },
		payload: "cGF5",
	});
	assert.equal(parsePacket("\x1b]52;c;eA==\x07"), undefined);
	assert.equal(pickMime(["text/plain", "image/jpeg", "image/png"]), "image/png");
	assert.equal(pickMime(["STRING", "text/plain"]), "text/plain");
	assert.equal(pickMime(["image/bmp"]), undefined);
});

test("pasted text can't close the bracketed paste it is delivered in", () => {
	assert.equal(withoutPasteMarkers("a\x1b[201~\rrm -rf ~\r"), "a\rrm -rf ~\r");
	assert.equal(withoutPasteMarkers("\x1b[20\x1b[201~1~x\x1b[200~"), "x");
	const { r, results } = reader();
	for (const p of pasteEvent("text/plain")) r.input(p);
	r.input(packet("type=read:status=OK"));
	r.input(packet(`type=read:status=DATA:mime=${b64("text/plain")}`, b64("ok\x1b[201~\r")));
	r.input(packet("type=read:status=DONE"));
	assert.deepEqual(results, [{ kind: "text", text: "ok\r" }]);
});
