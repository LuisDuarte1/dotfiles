import assert from "node:assert/strict";
import test from "node:test";
import { findGuarded } from "./detect.ts";
import { ALL_BRANCHES, approvalQuery, approvedUrl, isProtected, isRemoteUrl, parseRemote, pushTargets } from "./push.ts";

const targets = (command: string, current: string | undefined) => {
	const push = findGuarded(command, "bash")[0]?.push;
	assert.ok(push, command);
	return pushTargets(push, current);
};

test("push targets come from refspecs, or from the current branch when there are none", () => {
	const cases: [string, string | undefined, string[]][] = [
		["git push", "main", ["main"]],
		["git push", "feature", ["feature"]],
		["git push", undefined, []],
		["git push -u origin HEAD", "feature", ["feature"]],
		["git push --force-with-lease origin feature", "main", ["feature"]],
		["git push --force-with-lease=feature:abc123 origin feature", "main", ["feature"]],
		["git push origin HEAD:main", "feature", ["main"]],
		["git push origin +feature:master", "feature", ["master"]],
		["git push origin refs/heads/main", "feature", ["main"]],
		["git push origin :main", "feature", ["main"]],
		["git push --delete origin main", "feature", ["main"]],
		["git push origin a b", "main", ["a", "b"]],
		["git push --all origin", "feature", [ALL_BRANCHES]],
		["git push --mirror", "feature", [ALL_BRANCHES]],
		["git push origin 'refs/heads/*:refs/heads/*'", "feature", [ALL_BRANCHES]],
		["git push --tags", "main", []],
		["git push origin refs/tags/v1.2", "main", []],
		['git push origin "me/$b"', "main", []],
	];
	for (const [command, current, expected] of cases) assert.deepEqual(targets(command, current), expected, command);
});

test("main, master and every-branch pushes are protected", () => {
	assert.equal(isProtected("main"), true);
	assert.equal(isProtected("master"), true);
	assert.equal(isProtected(ALL_BRANCHES), true);
	assert.equal(isProtected("main-fix"), false);
	assert.equal(isProtected("me/main"), false);
});

test("remotes: URLs are parsed, names are looked up", () => {
	assert.deepEqual(parseRemote("git@github.com:owner/repo.git"), { host: "github.com", path: "owner/repo" });
	assert.deepEqual(parseRemote("https://github.com/owner/repo"), { host: "github.com", path: "owner/repo" });
	assert.deepEqual(parseRemote("ssh://git@ssh.github.com:443/owner/repo.git"), { host: "github.com", path: "owner/repo" });
	assert.deepEqual(parseRemote("ssh://git@gitlab.example.com:2222/group/sub/repo.git"), {
		host: "gitlab.example.com",
		path: "group/sub/repo",
	});
	assert.deepEqual(parseRemote("https://oauth2:secret@gitlab.example.com/group/repo.git/"), {
		host: "gitlab.example.com",
		path: "group/repo",
	});
	assert.equal(parseRemote("/srv/git/repo.git"), undefined);
	assert.equal(parseRemote("../repo"), undefined);
	for (const url of ["git@github.com:o/r.git", "https://x/y", "../repo", "/srv/repo"]) assert.equal(isRemoteUrl(url), true, url);
	for (const name of ["origin", "gitlab", "my-fork"]) assert.equal(isRemoteUrl(name), false, name);
});

test("approval query: gh for GitHub, one GraphQL call for GitLab", () => {
	const gh = approvalQuery({ host: "github.com", path: "owner/repo" }, "feature");
	assert.equal(gh.command, "gh");
	assert.deepEqual(gh.args.slice(0, 6), ["pr", "list", "-R", "github.com/owner/repo", "--head", "feature"]);
	const glab = approvalQuery({ host: "gitlab.example.com", path: "group/repo" }, "feature");
	assert.equal(glab.command, "glab");
	assert.deepEqual(glab.args.slice(0, 4), ["api", "graphql", "--hostname", "gitlab.example.com"]);
	assert.ok(glab.args.includes("path=group/repo") && glab.args.includes("branch=feature"));
});

test("approval parsing: a recorded approval counts, an empty or unapproved list does not", () => {
	const url = "https://github.com/o/r/pull/1";
	const pr = (extra: object) => JSON.stringify([{ url, reviewDecision: "", latestReviews: [], ...extra }]);
	assert.equal(approvedUrl("gh", pr({ reviewDecision: "APPROVED" })), url);
	assert.equal(approvedUrl("gh", pr({ latestReviews: [{ state: "COMMENTED" }, { state: "APPROVED" }] })), url);
	assert.equal(approvedUrl("gh", pr({ reviewDecision: "REVIEW_REQUIRED", latestReviews: [{ state: "CHANGES_REQUESTED" }] })), undefined);
	assert.equal(approvedUrl("gh", "[]"), undefined);

	const mr = (approvers: object[]) => {
		const nodes = [{ webUrl: "https://gl/mr/1", approvedBy: { nodes: approvers } }];
		return JSON.stringify({ data: { project: { mergeRequests: { nodes } } } });
	};
	assert.equal(approvedUrl("glab", mr([{ username: "rev" }])), "https://gl/mr/1");
	assert.equal(approvedUrl("glab", mr([])), undefined);
	assert.equal(approvedUrl("glab", JSON.stringify({ data: { project: null } })), undefined);
	assert.throws(() => approvedUrl("gh", "not json"));
});
