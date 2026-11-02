import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RunControls } from "../registry.ts";
import { createRun, lastText, type RunState } from "../run.ts";
import { runChild } from "../runner.ts";
import { isSubagentEnd, isSubagentUpdate, makeSandbox, RpcSession, runJson, type Sandbox, subagentResult } from "./harness.ts";

let sandbox: Sandbox;
before(() => {
	sandbox = makeSandbox();
});
after(() => sandbox.cleanup());

test("/steer reaches a running subagent and the parent is told about it", async () => {
	const session = new RpcSession(sandbox);
	try {
		await session.send({ type: "prompt", message: "delegate SLEEP3 steer me" });
		await session.waitFor((e) => isSubagentUpdate(e) && e.partialResult.details.tokens === 15);

		const accepted = await session.send({ type: "prompt", message: "/steer #1 also check README" });
		assert.equal(accepted.success, true);
		const notice = await session.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify");
		assert.match(notice.message, /^Queued for #1/);

		const end = await session.waitFor(isSubagentEnd);
		const text: string = end.result.content[0].text;
		assert.match(text, /^child done; users=\["also check README"\]/);
		assert.match(text, /extra instructions while it ran:\n- also check README$/);
		assert.deepEqual(end.result.details.steers, ["also check README"]);
	} finally {
		await session.close();
	}
});

test("/steer explains why it cannot deliver", async () => {
	const session = new RpcSession(sandbox);
	try {
		await session.send({ type: "prompt", message: "/steer hello" });
		const notice = await session.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify");
		assert.equal(notice.message, "No subagent is running.");
	} finally {
		await session.close();
	}
});

test("forwards child dialogs to the parent UI", async () => {
	const session = new RpcSession(sandbox);
	try {
		await session.send({ type: "prompt", message: "delegate CONFIRM please" });
		const dialog = await session.waitFor((e) => e.type === "extension_ui_request" && e.method === "confirm");
		assert.equal(dialog.title, "[subagent #1 tester] Test question");
		session.respondUi(dialog.id, { confirmed: true });

		const end = await session.waitFor(isSubagentEnd);
		assert.equal(end.result.content[0].text, "child done; users=[]; answer=yes");
	} finally {
		await session.close();
	}
});

test("cancels child dialogs when the parent has no UI", async () => {
	const result = subagentResult(await runJson(sandbox, "delegate CONFIRM please"));
	assert.equal(result.content[0].text, "child done; users=[]; answer=no");
});

async function runDirect(task: string, act: (controls: RunControls, run: RunState) => Promise<void>): Promise<RunState> {
	const saved = { ...process.env };
	Object.assign(process.env, sandbox.env);
	delete process.env.PI_CODING_AGENT;
	const run = createRun({ id: 1, task });
	let controls: RunControls | undefined;
	let acting = false;
	let acted: Promise<void> | undefined;
	try {
		await runChild({
			run,
			command: "pi",
			args: ["--mode", "rpc", "--no-session", "-nc", "-ns", "-np", "--model", "fake/child"],
			cwd: sandbox.cwd,
			prompt: task,
			onControls: (c) => {
				controls ??= c;
			},
			onChange: () => {
				if (acting || !controls || !run.activity.startsWith("bash:")) return;
				acting = true;
				acted = act(controls, run);
			},
		});
		await acted;
	} finally {
		process.env = saved;
	}
	return run;
}

test("stop ends the child early and keeps its partial state", async () => {
	const started = Date.now();
	const run = await runDirect("SLEEP10 then answer", async (controls) => {
		assert.equal(await controls.stop(), undefined);
	});

	assert.equal(run.status, "stopped");
	assert.ok(Date.now() - started < 8_000, "did not wait for the 10s sleep");
	assert.ok(run.transcript.some((i) => i.kind === "note" && i.text === "stopped by the user"));
});

test("follow-up extends the run before it returns", async () => {
	const run = await runDirect("SLEEP1 then answer", async (controls) => {
		assert.equal(await controls.followUp("and summarize"), undefined);
	});

	assert.equal(run.status, "done");
	assert.equal(lastText(run.lastAssistant), 'child done; users=["and summarize"]');
	assert.deepEqual(run.steers, ["and summarize"]);
	assert.deepEqual(
		run.transcript.map((i) => (i.kind === "tool" ? `tool:${i.name}:${i.state}:${i.output.trim()}` : `${i.kind}:${"text" in i ? i.text : ""}`)),
		[
			"thinking:planning a nap",
			"tool:bash:done:slept",
			"text:child done; users=[]",
			"user:and summarize",
			'text:child done; users=["and summarize"]',
		],
		"streamed blocks reduce to the same transcript as a replay",
	);
});

test("controls refuse input once the child has finished", async () => {
	let late: RunControls | undefined;
	const run = createRun({ id: 1, task: "quick" });
	const saved = { ...process.env };
	Object.assign(process.env, sandbox.env);
	try {
		await runChild({
			run,
			command: "pi",
			args: ["--mode", "rpc", "--no-session", "-nc", "-ns", "-np", "--model", "fake/child"],
			cwd: sandbox.cwd,
			prompt: "quick",
			onControls: (c) => {
				late ??= c;
			},
			onChange: () => {},
		});
	} finally {
		process.env = saved;
	}
	assert.equal(await late?.steer("too late"), "the subagent already finished");
});

test("/steer needs an id when several subagents run in parallel", async () => {
	const session = new RpcSession(sandbox);
	const notices = () => session.events.filter((e) => e.type === "extension_ui_request" && e.method === "notify");
	try {
		await session.send({ type: "prompt", message: "delegate PARALLEL" });
		await session.waitFor((e) => isSubagentUpdate(e) && e.partialResult.details.runId === 2 && e.partialResult.details.tokens === 15);
		await session.waitFor((e) => isSubagentUpdate(e) && e.partialResult.details.runId === 1 && e.partialResult.details.tokens === 15);

		await session.send({ type: "prompt", message: "/steer which one?" });
		await session.waitFor(() => notices().length === 1);
		assert.equal(notices()[0].message, "Several subagents are running (#1, #2); use /steer #<id> <message>.");

		await session.send({ type: "prompt", message: "/steer #2 only the right one" });
		await session.waitFor(() => notices().length === 2);

		const ends = await session.waitFor(() => session.events.filter(isSubagentEnd).length === 2);
		assert.ok(ends);
		const texts = session.events.filter(isSubagentEnd).map((e) => `${e.result.details.runId}:${e.result.content[0].text.split("\n")[0]}`);
		assert.deepEqual(texts.sort(), ["1:child done; users=[]", '2:child done; users=["only the right one"]']);
	} finally {
		await session.close();
	}
});
