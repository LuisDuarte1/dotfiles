import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "..", "ci-wait");
const fake = path.join(here, "fake-forge.mjs");

type Response = { json?: unknown; stdout?: string; stderr?: string; code?: number; hang?: boolean };
type Plan = Record<string, Response[]>;
type Call = { route: string; args: string[] };
interface Run {
	code: number | null;
	lines: string[];
	stderr: string;
	calls: Call[];
	seconds: number;
}

const gitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};
const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function ciWait(args: string[], plan: Plan, cwd?: string): Promise<Run> {
	const dir = tempDir("ci-wait-");
	writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
	const forge = path.join(dir, "forge");
	writeFileSync(forge, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
	chmodSync(forge, 0o755);
	const env = { ...process.env, ...gitEnv, CI_WAIT_GH: forge, CI_WAIT_GLAB: forge, FAKE_FORGE_DIR: dir };
	const started = Date.now();
	const child = spawn(script, args, { cwd: cwd ?? dir, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	const log = path.join(dir, "calls.jsonl");
	const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	return {
		code,
		lines: strip(stdout)
			.split("\n")
			.filter(Boolean)
			.map((line) => line.replace(/^\d\d:\d\d:\d\d /, "")),
		stderr: strip(stderr),
		calls,
		seconds: (Date.now() - started) / 1000,
	};
}

function repo(origin: string, branch: string, pushed: boolean): { dir: string; head: string } {
	const dir = tempDir("ci-wait-repo-");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, env: { ...process.env, ...gitEnv } }).toString().trim();
	git("init", "-q", "-b", branch);
	git("remote", "add", "origin", origin);
	git("commit", "-q", "--allow-empty", "-m", "work");
	const head = git("rev-parse", "HEAD");
	if (pushed) git("update-ref", `refs/remotes/origin/${branch}`, head);
	return { dir, head };
}

const SHA = "1111111111111111111111111111111111111111";
const OLD = "2222222222222222222222222222222222222222";
const MR_URL = "https://gitlab.example.org/group/sub/proj/-/merge_requests/7";
const PIPELINE_URL = "https://gitlab.example.org/group/sub/proj/-/pipelines/501";
const PR_URL = "https://github.com/owner/repo/pull/7";

interface MrOptions {
	state?: string;
	sha?: string;
	pipeline?: number;
	pipelineSha?: string;
	ref?: string;
	url?: string;
}

function mr(status: string | null, dms = "ci_still_running", options: MrOptions = {}): Response {
	const sha = options.sha ?? SHA;
	const id = options.pipeline ?? 501;
	return {
		json: {
			id: 9001,
			iid: 7,
			project_id: 42,
			title: "Add a feature",
			state: options.state ?? "opened",
			merge_status: "can_be_merged",
			detailed_merge_status: dms,
			source_branch: "feature/x",
			sha,
			web_url: options.url ?? MR_URL,
			head_pipeline:
				status === null
					? null
					: {
							id,
							iid: 12,
							project_id: 42,
							sha: options.pipelineSha ?? sha,
							ref: options.ref ?? "refs/merge-requests/7/head",
							status,
							source: "merge_request_event",
							web_url: `https://gitlab.example.org/group/sub/proj/-/pipelines/${id}`,
						},
		},
	};
}

function job(stage: string, name: string, id: number, allowFailure = false) {
	return {
		id,
		name,
		stage,
		status: "failed",
		allow_failure: allowFailure,
		web_url: `https://gitlab.example.org/group/sub/proj/-/jobs/${id}`,
	};
}

function checkRun(name: string, status: string, conclusion = "", startedAt = "2026-11-24T10:00:00Z") {
	return {
		__typename: "CheckRun",
		name,
		workflowName: "CI",
		status,
		conclusion,
		startedAt,
		completedAt: status === "COMPLETED" ? "2026-11-24T10:05:00Z" : "0001-01-01T00:00:00Z",
		detailsUrl: `https://github.com/owner/repo/actions/runs/1/job/${name}-${startedAt.slice(11, 13)}`,
	};
}

function statusContext(state: string) {
	return {
		__typename: "StatusContext",
		context: "ci/legacy",
		state,
		startedAt: "2026-11-24T10:00:00Z",
		targetUrl: "https://ci.example.com/build/9",
	};
}

function pr(checks: unknown[], mergeStateStatus = "BLOCKED", state = "OPEN", headRefOid = SHA): Response {
	return { json: { state, url: PR_URL, headRefOid, mergeStateStatus, statusCheckRollup: checks } };
}

const passing = [checkRun("build", "COMPLETED", "SUCCESS"), checkRun("lint", "COMPLETED", "SKIPPED")];
const fast = ["--interval", "1"];

describe("ci-wait", { concurrency: true }, () => {
	test("GitLab: prints one line per state change and exits 0 once CI passed and the MR can merge", async () => {
		const run = await ciWait([...fast, MR_URL], {
			mr: [
				mr(null, "ci_must_pass"),
				mr("running"),
				mr("running"),
				mr("success", "ci_still_running"),
				mr("success", "mergeable"),
			],
		});

		assert.equal(run.code, 0);
		assert.deepEqual(run.lines, [
			`Watching ${MR_URL} (timeout 3600s, every 1s)`,
			"no pipeline yet, merge status ci_must_pass",
			"pipeline 501 running, merge status ci_still_running",
			"pipeline 501 success, merge status ci_still_running",
			"pipeline 501 success, merge status mergeable",
			`Passed: mergeable, ${MR_URL}`,
		]);
		assert.equal(run.calls.length, 5);
		assert.deepEqual(run.calls[0].args, [
			"api",
			"--hostname",
			"gitlab.example.org",
			"projects/group%2Fsub%2Fproj/merge_requests/7",
		]);
	});

	test("GitLab: takes the host from the URL and ignores what follows the MR number", async () => {
		const url = "https://code.example.net/a/b/-/merge_requests/7";
		const run = await ciWait([`${url}/diffs#note_3`], { mr: [mr("success", "mergeable", { url })] });

		assert.equal(run.code, 0);
		assert.equal(run.lines[0], `Watching ${url} (timeout 3600s, every 30s)`);
		assert.deepEqual(run.calls[0].args, ["api", "--hostname", "code.example.net", "projects/a%2Fb/merge_requests/7"]);
	});

	test("GitLab: a failed pipeline exits 1 with its failed jobs and bridges, but not allowed failures", async () => {
		const run = await ciWait([...fast, MR_URL], {
			mr: [mr("running"), mr("failed", "ci_must_pass")],
			jobs: [{ json: [job("test", "unit", 601), job("lint", "style", 602, true)] }],
			bridges: [
				{
					json: [
						{
							...job("deploy", "child", 603),
							downstream_pipeline: { id: 502, web_url: "https://gitlab.example.org/group/sub/proj/-/pipelines/502" },
						},
					],
				},
			],
		});

		assert.equal(run.code, 1);
		assert.deepEqual(run.lines.slice(1), [
			"pipeline 501 running, merge status ci_still_running",
			"pipeline 501 failed, merge status ci_must_pass",
			`Failed: pipeline failed, ${PIPELINE_URL}`,
			"  test/unit: failed https://gitlab.example.org/group/sub/proj/-/jobs/601",
			"  deploy/child: failed https://gitlab.example.org/group/sub/proj/-/pipelines/502",
		]);
		assert.equal(
			run.calls.find((call) => call.route === "jobs")?.args.at(-1),
			"projects/group%2Fsub%2Fproj/pipelines/501/jobs?scope=failed&per_page=100",
		);
	});

	test("GitLab: a failed pipeline still exits 1 when its jobs cannot be listed", async () => {
		const run = await ciWait([MR_URL], {
			mr: [mr("canceled")],
			jobs: [{ code: 1, stderr: "glab: 500 Internal Server Error\n" }],
			bridges: [{ json: [] }],
		});

		assert.equal(run.code, 1);
		assert.deepEqual(run.lines.slice(2), [
			`Failed: pipeline canceled, ${PIPELINE_URL}`,
			"Could not list the failed jobs: forge exited with 1: glab: 500 Internal Server Error",
		]);
	});

	for (const dms of ["discussions_not_resolved", "conflict", "not_approved"]) {
		test(`GitLab: waits for CI despite ${dms}, then exits 2`, async () => {
			const run = await ciWait([...fast, MR_URL], { mr: [mr("running", dms), mr("success", dms)] });

			assert.equal(run.code, 2);
			assert.deepEqual(run.lines.slice(1), [
				`pipeline 501 running, merge status ${dms}`,
				`pipeline 501 success, merge status ${dms}`,
				`Blocked: ${dms}, ${MR_URL}`,
			]);
		});
	}

	test("GitLab: a pipeline that waits for a manual job exits 2", async () => {
		const run = await ciWait([MR_URL], { mr: [mr("manual")] });

		assert.equal(run.code, 2);
		assert.equal(run.lines.at(-1), `Blocked: the pipeline waits for a manual job, ${PIPELINE_URL}`);
	});

	test("GitLab: a merged MR counts as passed and a closed one as blocked", async () => {
		const merged = await ciWait([MR_URL], { mr: [mr("success", "not_open", { state: "merged" })] });
		const closed = await ciWait([MR_URL], { mr: [mr("success", "not_open", { state: "closed" })] });

		assert.equal(merged.code, 0);
		assert.equal(merged.lines.at(-1), `Passed: merged, ${MR_URL}`);
		assert.equal(closed.code, 2);
		assert.equal(closed.lines.at(-1), `Blocked: the MR is closed, ${MR_URL}`);
	});

	test("GitLab: a merged-results pipeline counts even though its commit is not the MR head", async () => {
		const run = await ciWait([MR_URL], {
			mr: [mr("success", "mergeable", { pipelineSha: OLD, ref: "refs/merge-requests/7/merge" })],
		});

		assert.equal(run.code, 0);
	});

	test("GitLab: a branch takes host and project from origin and exits 3 at once without an open MR", async () => {
		const { dir } = repo("ssh://git@gitlab.example.org:2222/group/sub/proj.git", "feature/x", false);
		const run = await ciWait([], { mrs: [{ json: [] }] }, dir);

		assert.equal(run.code, 3);
		assert.match(run.stderr, /No open merge request for branch 'feature\/x' in group\/sub\/proj on gitlab\.example\.org/);
		assert.deepEqual(run.calls, [
			{
				route: "mrs",
				args: [
					"api",
					"--hostname",
					"gitlab.example.org",
					"projects/group%2Fsub%2Fproj/merge_requests?source_branch=feature%2Fx&state=opened&per_page=1",
				],
			},
		]);
	});

	test("GitLab: a branch waits until the MR and its pipeline reach the commit on origin", async () => {
		const { dir, head } = repo("git@code.example.net:group/proj.git", "feature", true);
		const url = "https://code.example.net/group/proj/-/merge_requests/7";
		const run = await ciWait(
			[...fast, "feature"],
			{
				mrs: [{ json: [{ iid: 7, web_url: url }] }],
				mr: [
					mr("success", "mergeable", { sha: OLD, url }),
					mr("success", "mergeable", { sha: head, pipelineSha: OLD, url }),
					mr("running", "ci_still_running", { sha: head, pipeline: 502, url }),
					mr("success", "mergeable", { sha: head, pipeline: 502, url }),
				],
			},
			dir,
		);

		assert.equal(run.code, 0);
		assert.deepEqual(run.lines, [
			`Watching ${url} (timeout 3600s, every 1s)`,
			`waiting for the MR to show ${head.slice(0, 8)}, it shows 22222222`,
			`pipeline 501 is for 22222222, waiting for one on ${head.slice(0, 8)}`,
			"pipeline 502 running, merge status ci_still_running",
			"pipeline 502 success, merge status mergeable",
			`Passed: mergeable, ${url}`,
		]);
		assert.deepEqual(run.calls[0].args.slice(0, 3), ["api", "--hostname", "code.example.net"]);
		assert.equal(run.calls[1].args.at(-1), "projects/group%2Fproj/merge_requests/7");
	});

	test("three probes in a row that fail or return something unparsable exit 3", async () => {
		const run = await ciWait([...fast, MR_URL], {
			mr: [{ code: 1, stderr: "glab: 502 Bad Gateway\n" }, { stdout: "<html>oops</html>" }, { json: { message: "ok" } }],
		});

		assert.equal(run.code, 3);
		assert.equal(run.lines[1], "probe failed (1/3): forge exited with 1: glab: 502 Bad Gateway");
		assert.match(run.lines[2], /^probe failed \(2\/3\): unparsable response: jq: /);
		assert.equal(run.lines.length, 3);
		assert.match(run.stderr, /Gave up after 3 failed probes in a row: unparsable response: .*no state in the response/);
	});

	test("a good probe resets the probe error count", async () => {
		const down = { code: 1, stderr: "glab: connection refused\n" };
		const run = await ciWait([...fast, MR_URL], {
			mr: [down, down, mr("running"), down, down, mr("success", "mergeable")],
		});

		assert.equal(run.code, 0);
		assert.equal(run.lines.filter((line) => line.startsWith("probe failed (2/3)")).length, 2);
	});

	test("a pipeline that never finishes exits 4 at the timeout", async () => {
		const run = await ciWait(["--timeout", "2", ...fast, MR_URL], { mr: [mr("running")] });

		assert.equal(run.code, 4);
		assert.deepEqual(run.lines.slice(1), [
			"pipeline 501 running, merge status ci_still_running",
			"Timed out after 2s; last state: pipeline 501 running, merge status ci_still_running",
		]);
	});

	test("the timeout holds while a probe hangs", async () => {
		const run = await ciWait(["--timeout", "2", MR_URL], { mr: [{ hang: true }] });

		assert.equal(run.code, 4);
		assert.deepEqual(run.lines.slice(1), ["probe failed (1/3): forge timed out after 2s", "Timed out after 2s; last state: none"]);
		assert.ok(run.seconds < 6, `took ${run.seconds}s`);
	});

	test("GitHub: newest run of each check counts; exits 0 once all passed and merge state settles", async () => {
		const rerun = [
			checkRun("build", "COMPLETED", "FAILURE", "2026-11-24T09:00:00Z"),
			checkRun("build", "COMPLETED", "SUCCESS", "2026-11-24T10:00:00Z"),
			checkRun("lint", "COMPLETED", "SKIPPED"),
			statusContext("SUCCESS"),
		];
		const run = await ciWait([...fast, `${PR_URL}/checks`], {
			view: [
				pr([]),
				pr([checkRun("build", "IN_PROGRESS"), statusContext("PENDING")]),
				pr([checkRun("build", "IN_PROGRESS"), statusContext("SUCCESS")]),
				pr(rerun, "UNKNOWN"),
				pr(rerun, "CLEAN"),
			],
		});

		assert.equal(run.code, 0);
		assert.deepEqual(run.lines, [
			`Watching ${PR_URL} (timeout 3600s, every 1s)`,
			"no checks yet on 1111111, merge state BLOCKED",
			"checks pending on 1111111, merge state BLOCKED",
			"checks passed on 1111111, merge state UNKNOWN",
			"checks passed on 1111111, merge state CLEAN",
			`Passed: CLEAN, ${PR_URL}`,
		]);
		assert.deepEqual(run.calls[0].args, [
			"pr",
			"view",
			PR_URL,
			"--json",
			"state,url,headRefOid,mergeStateStatus,statusCheckRollup",
		]);
	});

	test("GitHub: failed checks exit 1 with their names and URLs", async () => {
		const run = await ciWait([PR_URL], {
			view: [
				pr([
					checkRun("build", "COMPLETED", "SUCCESS", "2026-11-24T09:00:00Z"),
					checkRun("build", "COMPLETED", "FAILURE", "2026-11-24T10:00:00Z"),
					checkRun("lint", "COMPLETED", "SUCCESS"),
					statusContext("ERROR"),
				]),
			],
		});

		assert.equal(run.code, 1);
		assert.deepEqual(run.lines.slice(1), [
			"checks failed on 1111111, merge state BLOCKED",
			`Failed: 2 of 3 checks failed, ${PR_URL}`,
			"  build: FAILURE https://github.com/owner/repo/actions/runs/1/job/build-10",
			"  ci/legacy: ERROR https://ci.example.com/build/9",
		]);
	});

	const githubEnds: [string, string, number, string][] = [
		["OPEN", "DIRTY", 2, "Blocked: conflicts with the base branch"],
		["OPEN", "BLOCKED", 2, "Blocked: a branch protection rule, such as a required review"],
		["CLOSED", "UNKNOWN", 2, "Blocked: the PR is closed"],
		["MERGED", "UNKNOWN", 0, "Passed: merged"],
	];
	for (const [state, mergeState, code, last] of githubEnds) {
		test(`GitHub: passed checks on a ${state} PR in merge state ${mergeState} exit ${code}`, async () => {
			const run = await ciWait([PR_URL], { view: [pr(passing, mergeState, state)] });

			assert.equal(run.code, code);
			assert.equal(run.lines.at(-1), `${last}, ${PR_URL}`);
		});
	}

	test("GitHub: a branch finds its PR in the origin repo and waits for the pushed commit", async () => {
		const { dir, head } = repo("git@github.com:owner/repo.git", "topic", true);
		const run = await ciWait(
			[...fast],
			{
				list: [{ json: [{ number: 7, url: PR_URL }] }],
				view: [pr(passing, "CLEAN", "OPEN", OLD), pr(passing, "CLEAN", "OPEN", head)],
			},
			dir,
		);

		assert.equal(run.code, 0);
		assert.deepEqual(run.lines, [
			`Watching ${PR_URL} (timeout 3600s, every 1s)`,
			`waiting for the PR to show ${head.slice(0, 7)}, it shows 2222222`,
			`checks passed on ${head.slice(0, 7)}, merge state CLEAN`,
			`Passed: CLEAN, ${PR_URL}`,
		]);
		assert.deepEqual(run.calls[0].args, [
			"pr",
			"list",
			"-R",
			"github.com/owner/repo",
			"--head",
			"topic",
			"--state",
			"open",
			"--json",
			"url,number",
			"--limit",
			"1",
		]);
	});

	test("GitHub: a branch without an open PR exits 3 at once", async () => {
		const { dir } = repo("https://github.example.com/owner/repo.git", "topic", false);
		const run = await ciWait(["topic"], { list: [{ json: [] }] }, dir);

		assert.equal(run.code, 3);
		assert.match(run.stderr, /No open pull request for branch 'topic' in owner\/repo on github\.example\.com/);
		assert.deepEqual(run.calls[0].args.slice(2, 4), ["-R", "github.example.com/owner/repo"]);
	});

	const badUsage: string[][] = [
		["--bogus"],
		["--timeout", "0", MR_URL],
		["--interval"],
		[MR_URL, PR_URL],
		["https://example.com/not/a/review"],
	];
	for (const args of badUsage) {
		test(`bad usage exits 1 before any probe: ${args.join(" ")}`, async () => {
			const run = await ciWait(args, {});

			assert.equal(run.code, 1);
			assert.match(run.stderr, /^Error: /);
			assert.deepEqual(run.calls, []);
		});
	}
});
