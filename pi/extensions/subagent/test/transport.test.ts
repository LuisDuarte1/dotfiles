import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeSandbox, RpcSession, type Sandbox } from "./harness.ts";

let sandbox: Sandbox;
before(() => {
	sandbox = makeSandbox({ transports: true });
});
after(() => sandbox.cleanup());

const text = (end: { result: { content: { text: string }[] } }) => end.result.content[0].text;

test("a transport fills its defaults and the result says where the run went", async () => {
	const session = new RpcSession(sandbox);
	try {
		const end = await session.prompt("delegate VIA=remote:{} first");
		assert.equal(text(end), "child done; users=[]\n\n[remote · run 1 in work]");
		assert.deepEqual(end.result.details.transport, { param: "remote", value: { ws: "work", run: 1 } });
		assert.equal(end.result.details.agent, "tester @work");
	} finally {
		await session.close();
	}
});

test("a named subagent keeps its transport, which derives each follow-up from the last run", async () => {
	const session = new RpcSession(sandbox);
	try {
		const first = await session.prompt("delegate NAME=scout VIA=remote:{} first");
		assert.equal(text(first), 'child done; users=[]\n\n[subagent "scout" · new]\n[remote · run 1 in work]');

		const second = await session.prompt("delegate NAME=scout second");
		assert.equal(text(second), 'child done; users=["second"]\n\n[subagent "scout" · continued, prompt 2]\n[remote · run 2 in work]');
		assert.deepEqual(second.result.details.transport, { param: "remote", value: { ws: "work", run: 2, from: 1 } });

		const again = await session.prompt("delegate NAME=scout VIA=remote:{} third");
		assert.match(text(again), /\[remote · run 3 in work\]$/, "repeating the transport on a follow-up continues it");

		const moved = await session.prompt('delegate NAME=scout VIA=remote:{"ws":"other"} fourth');
		assert.match(text(moved), /runs in work, not other/);
	} finally {
		await session.close();
	}
});

test("a named subagent cannot switch between local and a transport, or use one that cannot continue", async () => {
	const session = new RpcSession(sandbox);
	try {
		await session.prompt("delegate NAME=here first");
		const local = await session.prompt("delegate NAME=here VIA=remote:{} second");
		assert.match(text(local), /^Subagent "here" runs locally; omit `remote` to continue it, or use another name\./);

		await session.prompt("delegate NAME=away VIA=remote:{} first");
		const plain = await session.prompt("delegate NAME=away VIA=plain:{} second");
		assert.match(text(plain), /^Subagent "away" runs with `remote`; omit `plain` to continue it/);

		const bare = await session.prompt("delegate NAME=bare VIA=plain:{} first");
		assert.match(text(bare), /^`name` cannot be combined with `plain` yet\./);
	} finally {
		await session.close();
	}
});
