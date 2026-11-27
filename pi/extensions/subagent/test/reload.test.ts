import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { isSubagentUpdate, makeSandbox, RpcSession, type Sandbox } from "./harness.ts";

let sandbox: Sandbox;
before(() => {
	sandbox = makeSandbox({ reloadBroadcast: true });
});
after(() => sandbox.cleanup());

function requestReload(): void {
	const dir = path.join(sandbox.env.XDG_RUNTIME_DIR as string, "pi-reload");
	fs.writeFileSync(path.join(dir, ".request.tmp"), `${Date.now()}\n`);
	fs.renameSync(path.join(dir, ".request.tmp"), path.join(dir, "request")); // as pi-reload-all does
}

test("a reload broadcast mid-run reloads the child after its tool turn, and the run continues to the end", async () => {
	const session = new RpcSession(sandbox);
	try {
		const ended = session.prompt("delegate SLEEP2 please");
		await session.waitFor((e) => isSubagentUpdate(e) && e.partialResult.details.tokens === 15); // child is in its sleep
		requestReload();
		const end = await ended;

		assert.equal(end.result.details.status, "done");
		assert.match(end.result.content[0].text, /^child done; users=\["pi was reloaded mid-run.*Continue where you left off\."\]/);
		const entries = fs
			.readFileSync(end.result.details.sessionFile, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const trail = entries
			.filter((e) => (e.type === "message" && e.message.role !== "system") || e.type === "custom_message")
			.map((e) => (e.type === "custom_message" ? `custom:${e.customType}` : `${e.message.role}:${e.message.stopReason ?? ""}`));
		assert.deepEqual(trail, ["user:", "assistant:toolUse", "toolResult:", "assistant:aborted", "custom:reload-broadcast", "assistant:stop"]);
	} finally {
		await session.close();
	}
});
