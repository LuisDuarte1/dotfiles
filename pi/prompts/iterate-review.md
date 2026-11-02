---
description: Walk through findings from /review-branch-code; verify each with a research subagent and post approved comments to GitHub/GitLab
argument-hint: "[PR/MR ref] [all|C|H|M|L|C1,H2,...]"
---

Iterate findings from a prior `/review-branch-code` in this session.
For each selected finding: verify with a `research` subagent (call the
`subagent` tool with `agent: research`); if real, draft a comment and
post on user approval.

**Prereq:** `/review-branch-code` must be in context. If not, abort and
ask the user to run it. DO NOT silently re-run it.

## Step 0 — Resolve target + cache refs

1. Detect platform from `git remote get-url origin` (`github.com` →
   `gh`, `gitlab` → `glab`, else ask).
2. Resolve PR/MR from `$ARGUMENTS` (URL, `!<n>`, `#<n>`, bare int) or
   auto-detect: `gh pr view --json number,headRefName,baseRefName,headRefOid,url`
   / `glab mr view --output json`. Abort helpfully if missing.
3. Cache once: GitHub `headRefOid` (= `commit_id`); GitLab
   `glab api projects/:id/merge_requests/:iid` →
   `diff_refs.{base_sha,start_sha,head_sha}` + project id + MR iid.
4. Cache the diff file list (`gh pr diff --name-only <n>` /
   `glab mr diff <n> --raw | grep '^+++'`) to test if a `file:line` is
   in the diff.

## Step 1 — Select findings

Findings from prior `/review-branch-code` are already addressable by
severity-coded id: `C1, C2, …` (CRITICAL), `H1, H2, …` (HIGH),
`M1, M2, …` (MEDIUM), `L1, L2, …` (LOW). These ids are authoritative;
do NOT renumber. Process severity order CRITICAL → HIGH → MEDIUM → LOW.

`$ARGUMENTS` selection token: comma list of ids (`C1,H2,M3` — case
insensitive) → those in given order; `all` → every finding in severity
order; severity letter alone (`C`, `H`, `M`, `L`) → all findings of
that severity; none → print the id list and ask for ids / `all` /
`interactive` (walk one-by-one with `y/skip/quit`).

## Step 2 — Per-finding loop

**Verify.** Call the `subagent` tool ONCE with `agent: research` (read-
only research; no edits). Pass the finding verbatim, the diff hunk,
and head/base SHAs as the `task`, and any extra refs/file list in
`context`. The subagent reads the cited file + context, callers, tests,
`git blame` for intent, then returns:

    verdict: false_positive | real
    confidence: high | medium | low
    explanation: <2–5 sentences, cite file:line>
    fix_suggestion: <if real; 1–3 sentences>

**Triage.** `false_positive` → print 2–4 line summary and move on (no
draft, no prompt). `real` → print summary + evidence, continue.

**Draft.** Comments MUST be concise AND actionable — every draft has
to end with a small concrete suggestion or idea, never a bare
observation. Max 6 lines, neutral tone, no AI footer, no emojis
unless already in use:

    <one-line problem statement>

    <1–2 lines of why it matters / when it triggers>

    Suggested: <concrete fix or idea — required, never omit>.

Show as `DRAFT:` then prompt `post` / `edit` / `skip` / `quit`. `edit`
= user describes change inline, you rewrite, re-show as `DRAFT:`, loop.
Block until reply. NEVER post without an explicit `post`.

**Post.** Line in cached diff list → inline; else → general thread/comment.

API quirks: `-f body=@path` sends the literal string — use `-F` for
`@file` and numeric fields. `-f position[key]=value` is flat, NOT
nested — GitLab line threads MUST be built with `jq` and piped via
`--input -` with `Content-Type: application/json`.

GitLab line-scoped (ALWAYS `/discussions`, never `/notes`):

    jq -n --arg body "$(cat /tmp/iterate-review-body.md)" \
          --arg base_sha "$BASE_SHA" --arg start_sha "$START_SHA" \
          --arg head_sha "$HEAD_SHA" --arg new_path "$FILE" \
          --arg old_path "$FILE" --argjson new_line $LINE \
          '{body:$body, position:{base_sha:$base_sha, start_sha:$start_sha, head_sha:$head_sha, position_type:"text", new_path:$new_path, old_path:$old_path, new_line:$new_line}}' \
    | glab api "projects/$PROJECT_ID/merge_requests/$MR_IID/discussions" \
        -X POST -H "Content-Type: application/json" --input -

Numeric `--argjson new_line`; base-side finding → use `old_line`.
URL-encode `$PROJECT_ID` if it's a path (numeric ids preferred).

GitLab general: `glab api projects/$PROJECT_ID/merge_requests/$MR_IID/discussions -X POST -F body=@/tmp/iterate-review-body.md`.

GitHub inline:

    gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" -X POST \
        -F body=@/tmp/iterate-review-body.md \
        -f commit_id="$HEAD_OID" -f path="$FILE" -F line=$LINE -f side=RIGHT

Base-side → `side=LEFT` + old line number.

GitHub general: `gh pr comment "$PR_NUMBER" --body-file /tmp/iterate-review-body.md`.

Print returned URL/id. On failure, surface error and ask
retry/skip/quit; never silently swallow.

## Step 3 — Final summary

    Processed N findings:
      - posted:          M  (inline: X, general-thread: Y)
      - skipped:         S
      - false positives: F
      - errored:         E

List the URL of every posted comment, prefixed with its finding id
(e.g. `C1 → <url>`).

## Arguments

`$ARGUMENTS` may contain, in any order: a PR/MR id (URL, `!<n>`, `#<n>`,
bare int) and a selection token (`all`, severity letter, or comma list
of finding ids like `C1,H2`). Selection absent → interactive. PR/MR
absent → auto-detect from branch.
