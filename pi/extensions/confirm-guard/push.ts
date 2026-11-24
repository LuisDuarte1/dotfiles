import type { Push } from "./detect.ts";

export const ALL_BRANCHES = "*";
const PROTECTED = new Set([ALL_BRANCHES, "main", "master"]);

export interface Remote {
	host: string;
	path: string;
}

export interface Query {
	command: "gh" | "glab";
	args: string[];
}

export const isProtected = (branch: string) => PROTECTED.has(branch);

// Only remote branch names come back; tags, other refs and refspecs built from shell variables
// are dropped, since an unknown target means no approval to protect and the push goes through.
export function pushTargets(push: Push, current: string | undefined): string[] {
	if (push.all) return [ALL_BRANCHES];
	const specs = push.refspecs.length > 0 || push.tags ? push.refspecs : ["HEAD"];
	const targets = new Set<string>();
	for (const spec of specs) {
		const ref = spec.replace(/^\+/, "");
		const colon = ref.indexOf(":");
		let dst = push.deletes || colon < 0 ? ref : ref.slice(colon + 1) || ref.slice(0, colon);
		if (dst.includes("*")) return [ALL_BRANCHES];
		if (dst === "HEAD" || dst === "@") dst = current ?? "";
		dst = dst.replace(/^refs\/heads\//, "");
		if (dst && !dst.startsWith("refs/") && !/[$`]/.test(dst)) targets.add(dst);
	}
	return [...targets];
}

export function isRemoteUrl(remote: string): boolean {
	return /^[^/]+:/.test(remote) || /^[./~]/.test(remote);
}

export function parseRemote(url: string): Remote | undefined {
	const m =
		/^[\w+.-]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ??
		/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
	if (!m) return undefined;
	return { host: m[1].replace(/^ssh\.github\.com$/, "github.com"), path: m[2].replace(/^\/+/, "") };
}

const GITLAB_QUERY =
	"query($path: ID!, $branch: String!) { project(fullPath: $path) { mergeRequests(sourceBranches: [$branch], " +
	"state: opened, first: 5) { nodes { webUrl approvedBy { nodes { username } } } } } }";

export function approvalQuery(remote: Remote, branch: string): Query {
	if (remote.host === "github.com") {
		const repo = `${remote.host}/${remote.path}`;
		const fields = "url,reviewDecision,latestReviews";
		return { command: "gh", args: ["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", fields] };
	}
	const variables = ["-f", `query=${GITLAB_QUERY}`, "-f", `path=${remote.path}`, "-f", `branch=${branch}`];
	return { command: "glab", args: ["api", "graphql", "--hostname", remote.host, ...variables] };
}

interface GhPull {
	url?: string;
	reviewDecision?: string;
	latestReviews?: { state?: string }[];
}

interface GlabResponse {
	data?: { project?: { mergeRequests?: { nodes?: { webUrl?: string; approvedBy?: { nodes?: unknown[] } }[] } } };
}

// GitLab's `approved` is also true when no approval is required, so only a recorded approver
// counts; on GitHub a review decision needs required reviewers, so the latest reviews count too.
export function approvedUrl(command: Query["command"], stdout: string): string | undefined {
	if (command === "gh") {
		const pulls = JSON.parse(stdout) as GhPull[];
		const approved = pulls.find((p) => p.reviewDecision === "APPROVED" || p.latestReviews?.some((r) => r.state === "APPROVED"));
		return approved ? (approved.url ?? "an approved pull request") : undefined;
	}
	const nodes = (JSON.parse(stdout) as GlabResponse).data?.project?.mergeRequests?.nodes ?? [];
	const approved = nodes.find((mr) => (mr.approvedBy?.nodes?.length ?? 0) > 0);
	return approved ? (approved.webUrl ?? "an approved merge request") : undefined;
}
