import assert from "node:assert/strict";
import test from "node:test";
import { findGuarded, GIT_PUSH } from "./detect.ts";

const labels = (text: string, tool: "bash" | "bg_do" = "bash") => findGuarded(text, tool).map((hit) => hit.label);

const check = (cases: [string, string[]][], tool: "bash" | "bg_do" = "bash") => {
	for (const [text, expected] of cases) assert.deepEqual(labels(text, tool), expected, text);
};

test("every listed command is caught", () => {
	check([
		["wrangler deploy", ["wrangler deploy"]],
		["wrangler deploy -c wrangler.registry.jsonc --env staging", ["wrangler deploy"]],
		["wrangler --env staging deploy", ["wrangler deploy"]],
		["wrangler rollback b2324da9 --name my-worker -m 'revert'", ["wrangler rollback"]],
		["wrangler versions deploy 1f2e@100% -y", ["wrangler versions deploy"]],
		["glab mr merge 1963 --yes", ["glab mr merge"]],
		["glab mr accept 12", ["glab mr merge"]],
		["gh pr merge 59 -R owner/repo --squash --match-head-commit 38c7", ["gh pr merge"]],
		["terraform apply -auto-approve", ["terraform apply"]],
		["terraform -chdir=infra destroy", ["terraform destroy"]],
		["gh repo delete owner/repo --yes", ["repository delete"]],
		["glab repo delete group/repo -y", ["repository delete"]],
		["glab repo transfer group/repo --target-namespace other", ["repository transfer"]],
		["glab api -X PUT projects/123/transfer -f namespace=456", ["repository transfer"]],
		["gh api repos/owner/repo/transfer -f new_owner=org", ["repository transfer"]],
		["gh api -X DELETE repos/owner/repo", ["repository delete"]],
		["glab api --method=DELETE projects/group%2Frepo", ["repository delete"]],
		["curl -s -X DELETE -H 'PRIVATE-TOKEN: x' https://gitlab.example.com/api/v4/projects/42", ["repository delete"]],
		["curl -X PUT https://gitlab.example.com/api/v4/projects/42/transfer?namespace=7", ["repository transfer"]],
		["glab api -X PUT projects/:id/merge_requests/12/merge", ["glab mr merge"]],
		["gh api -X PUT repos/owner/repo/pulls/3/merge", ["gh pr merge"]],
		["git push origin main", [GIT_PUSH]],
	]);
});

test("commands after separators, wrappers and nesting are caught", () => {
	check([
		["cd ~/app && npx wrangler deploy 2>&1 | tail -3", ["wrangler deploy"]],
		["make build; wrangler deploy", ["wrangler deploy"]],
		["test -f x || gh pr merge 1", ["gh pr merge"]],
		["echo go | xargs -n1 gh pr merge", ["gh pr merge"]],
		["(cd infra && terraform apply)", ["terraform apply"]],
		["{ terraform destroy; }", ["terraform destroy"]],
		["out=$(glab mr merge 5 --yes)", ["glab mr merge"]],
		["echo \"result: $(wrangler deploy)\"", ["wrangler deploy"]],
		["echo `gh pr merge 1`", ["gh pr merge"]],
		["npm run build\nwrangler deploy", ["wrangler deploy"]],
		["if true; then wrangler deploy; fi", ["wrangler deploy"]],
		["for n in 1 2; do gh pr merge $n --squash; done", ["gh pr merge"]],
		["! gh pr merge 1", ["gh pr merge"]],
		["ACCOUNT=abc timeout 900 npx wrangler deploy", ["wrangler deploy"]],
		["PATH=/x:$PATH timeout -k 5 600 git push origin main", [GIT_PUSH]],
		["env FOO=1 nohup setsid nice -n 19 wrangler deploy", ["wrangler deploy"]],
		["exec ./node_modules/.bin/wrangler deploy", ["wrangler deploy"]],
		["sudo -u deploy terraform apply", ["terraform apply"]],
		["stdbuf -oL time wrangler deploy", ["wrangler deploy"]],
		["npx -y wrangler@latest deploy", ["wrangler deploy"]],
		["pnpm exec wrangler deploy", ["wrangler deploy"]],
		["pnpm --dir worker wrangler deploy", ["wrangler deploy"]],
		["npm exec -- wrangler versions deploy", ["wrangler versions deploy"]],
		["/home/u/app/node_modules/.bin/wrangler rollback", ["wrangler rollback"]],
		["bash -c 'cd x && wrangler deploy'", ["wrangler deploy"]],
		["bash -euo pipefail -c \"gh pr merge 2\"", ["gh pr merge"]],
		["sh -lc 'glab mr merge 3'", ["glab mr merge"]],
		["eval \"gh pr merge 4\"", ["gh pr merge"]],
		["bash <<'EOF'\nterraform apply\nEOF", ["terraform apply"]],
		["bash <<< 'wrangler deploy'", ["wrangler deploy"]],
		["git -C ../repo push", [GIT_PUSH]],
		["git -c push.default=current push", [GIT_PUSH]],
	]);
});

test("mentions, arguments, data and lookalikes are not caught", () => {
	check([
		["echo \"wrangler deploy\"", []],
		["echo wrangler deploy", []],
		["rg 'gh pr merge' docs/", []],
		["grep -n \"git push origin main\" notes.md", []],
		["rg -n 'terraform apply' . | head", []],
		["git commit -m 'then wrangler deploy; gh pr merge 1'", []],
		["printf '%s\\n' 'glab mr merge'", []],
		["cat > run.sh <<'EOF'\nwrangler deploy\nEOF\nchmod +x run.sh", []],
		["cat <<EOF\ngit push origin main\nEOF", []],
		["# wrangler deploy later\nls", []],
		["ls  # then git push origin main", []],
		["mywrangler deploy", []],
		["wrangler-deploy", []],
		["xgit push", []],
		["git pushx", []],
		["gh pr merged", []],
		["terraform applyx", []],
		["wrangler deployment list", []],
		["wrangler.json deploy", []],
		["wrangler dev --port 8787", []],
		["wrangler tail worker --format json", []],
		["wrangler versions list", []],
		["wrangler pages deploy dist", []],
		["wrangler deploy --dry-run --outdir dist", []],
		["wrangler rollback --help", []],
		["glab mr merge --help", []],
		["gh pr merge -h", []],
		["terraform plan", []],
		["terraform -help apply", []],
		["git push --dry-run origin main", []],
		["git push -n origin main", []],
		["git log origin/main..HEAD", []],
		["glab mr view 12", []],
		["gh repo view owner/repo", []],
		["glab api -X DELETE projects/123/variables/TOKEN", []],
		["glab api --method DELETE projects/group%2Frepo/merge_requests/302/notes/1", []],
		["gh api repos/owner/repo", []],
		["glab api projects/123/transfer", []],
		["curl -s https://api.github.com/repos/owner/repo", []],
		["command -v wrangler && wrangler --version", []],
		["which terraform", []],
		["npm run deploy", []],
		["pnpm deploy ./out", []],
		["bash scripts/deploy.sh", []],
		["ls ~/.config/wrangler; cat deploy.md", []],
		["python3 -c 'import os; os.system(\"wrangler deploy\")'", []],
	]);
});

test("bg_do snippets: strings run by Python calls, bare command lines and captures", () => {
	check(
		[
			['dep = bg.run("cd ~/w && npx wrangler deploy 2>&1")\nr = bg.wait(dep, timeout=500)', ["wrangler deploy"]],
			["rc, push = sh('git push -f origin feature 2>&1 | tail -1')", [GIT_PUSH]],
			['print(subprocess.run("gh pr merge 44 --squash", shell=True, capture_output=True).stdout)', ["gh pr merge"]],
			['cmd = """cd infra && terraform apply -auto-approve"""\nj = bg.run(cmd)', ["terraform apply"]],
			["git push origin main", [GIT_PUSH]],
			["if ok:\n    glab mr merge 12 --yes", ["glab mr merge"]],
			["print($(cd ~/w && wrangler deploy 2>&1))", ["wrangler deploy"]],
			["out = !(gh pr merge 3)", ["gh pr merge"]],
			['jid = bg.run("bash -c \'cd /w && exec ./node_modules/.bin/wrangler deploy\'")', ["wrangler deploy"]],
			['bg.run(f"PATH=\'{p}\' exec node_modules/.bin/wrangler versions deploy 2>&1", cwd="/w")', ["wrangler versions deploy"]],
		],
		"bg_do",
	);
	check(
		[
			['print("wrangler deploy finished")', []],
			['print(f"gh pr merge {n} done")', []],
			['echo "git push origin main"', []],
			['bgout @(j) | grep -E "wrangler deploy|ERROR"', []],
			['wd = bg.run("npx wrangler dev --port 8787 2>&1", cwd="/w")', []],
			["# terraform apply once CI passes\nprint(bg.list())", []],
			['x = 1  # gh pr merge later', []],
			['(d / "wrangler.jsonc").write_text("{}")', []],
			['bg.run("rg \'git push\' ~/notes")', []],
		],
		"bg_do",
	);
});

test("git push carries the directory, remote and refspecs it targets", () => {
	const push = (text: string) => findGuarded(text, "bash")[0]?.push;
	assert.deepEqual(push("cd ~/repo && git push --force-with-lease=b:abc origin b"), {
		cwd: "~/repo",
		remote: "origin",
		refspecs: ["b"],
		all: false,
		deletes: false,
		tags: false,
	});
	assert.deepEqual(push("cd /a && git -C sub push"), {
		cwd: "/a/sub",
		remote: undefined,
		refspecs: [],
		all: false,
		deletes: false,
		tags: false,
	});
	assert.deepEqual(push("git push -q -o ci.skip gitlab HEAD:main +x"), {
		cwd: undefined,
		remote: "gitlab",
		refspecs: ["HEAD:main", "+x"],
		all: false,
		deletes: false,
		tags: false,
	});
	assert.equal(push("git push --mirror origin")?.all, true);
	assert.equal(push("git push origin --delete old")?.deletes, true);
	assert.equal(push("git push -fd origin old")?.deletes, true);
	assert.equal(push("git push --tags")?.tags, true);
	assert.equal(push("git push --repo=upstream")?.remote, "upstream");
});
