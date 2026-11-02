---
description: Review branch/PR/MR in one parallel batch with GPT-6 Sol + Opus 5.5, single-pass security, and optional global add-ons
argument-hint: "[PR/MR ref or focus hint]"
---

Delegate review to parallel topic-focused `review` subagents, the
`security-review` subagent and any global add-on reviewers, then
aggregate findings into a single report. Run **two independent passes
per non-security review phase**:

| Pass | `model` override |
|------|------------------|
| `sol` | `openai/gpt-6-sol` |
| `opus` | `anthropic/claude-opus-5-5` |

Security is the exception: run it **once** with `agent: security-review`
and **omit `model`**, preserving its configured model. Do not skip
security or run it again on Sol/Opus 5.5. Scope resolution, partition
planning, and aggregation still happen once, not once per model.

Use the `subagent` tool for every delegation. Pass `agent: review`
(`security-review` for Security, each add-on's agent for its passes),
the explicit `model` override above for each non-security pass, and a
short `task`/`context` pointing to the prepared input files. Never
substitute one model for the other or count two calls on the same model
as two passes.

Give both passes the same scope, topic instructions, and source context.
They must review independently: neither gets the other's findings or
reads other findings files. Partitions limit each reviewer's scope, NOT
concurrency. Prepare shared inputs on disk, then launch every partition's
reviewers and every add-on's global passes in **one parallel batch**. Pass
paths instead of repeating diffs in tool arguments to keep the dispatch
short and avoid streaming timeouts.

## Scope

Default: current branch vs `origin/main` (`git diff origin/main...HEAD`,
`git log --oneline origin/main..HEAD`). If `$ARGUMENTS` contains a
GitHub PR ref, use `gh pr view/diff/checks <n>`. If it contains a
GitLab MR ref, use `glab mr view/diff <n>` and `glab ci status`. Cache
the resolved base ref (e.g. `origin/main` or `<base_sha>`); refer to
it as `$BASE` below.

Also create a unique session dir once and cache it as `$RDIR`: run
`mktemp -d /tmp/review-XXXXXX` and reuse the printed path verbatim for
the plan and every findings file below. This isolates concurrent review
sessions so they never clobber each other's plans or findings.

## Step 0 — Global add-ons

Run `ls ~/.pi/agent/review.d/*.md 2>/dev/null` and read every file in
full. Each one is a global review add-on: it names a slug, a precheck,
the `subagent` calls it adds (agent, passes, models), the topic its
findings use, and any aggregation rules. Run each precheck now; skip an
add-on whose precheck fails, print the message it asks for, and note it
for the summary. No files means no add-ons; continue normally.

## Step 0.5 — Plan partitions

Measure scope:

    git diff --name-only $BASE...HEAD | wc -l
    git diff --shortstat  $BASE...HEAD

If `files ≤ 30 AND insertions+deletions ≤ 10000`, write a single
partition to `$RDIR/plan.json` and skip ahead to Step 1:

    {"partitions":[{"id":"P1","name":"all","files":["...","..."]}]}

Otherwise YOU propose the partition plan, using semantic judgment.
Prefer in order:

1. Tight coupling first — a crate's `src/` and `tests/`, a feature's
   frontend + backend, a refactor's caller and callee.
2. Then workspace/module boundaries — Cargo workspace members,
   top-level directories, language ecosystems.
3. Merge groups under ~8 files into a `_misc` partition.

Caps per partition: ≤ 25 files AND ≤ 10000 line changes. A single
oversize file is OK (cannot be split).

Write the plan to `$RDIR/plan.json` as:

    { "partitions": [
        { "id": "P1", "name": "ml_classifier",  "files": ["..."] },
        { "id": "P2", "name": "email",          "files": ["..."] },
        ...
    ] }

Then validate:

    validate-review-plan --plan $RDIR/plan.json --base $BASE

On failure, read the printed errors (also persisted next to the plan as
`$RDIR/plan.errors.json`), revise the plan, re-validate.
Maximum **3 revision attempts**. If still failing, fall back to one
partition per top-level directory, skip validation, print a warning,
and continue.

## Step 1 — Prepare shared inputs before dispatch

    mkdir -p "$RDIR/inputs" "$RDIR/findings"

Materialize all inputs before launching any reviewer:

- `$RDIR/inputs/context.md`: absolute repository path, resolved base/head
  refs and commit SHAs, `$ARGUMENTS` verbatim, topic instructions below,
  independence/read-only requirements, and the shared findings schema
  and ack contract below. Every reviewer must read this file.
- `$RDIR/inputs/<partition_id>.json`: that partition's id, name, and file
  list from the validated plan (or the documented fallback plan).
- `$RDIR/inputs/<partition_id>.diff`: that partition's diff, generated
  with `git diff <base_sha>...<head_sha> -- <files>`. Use the same pinned
  commit SHAs for every artifact, and pass each filename as a separate,
  safely quoted literal pathspec.
- `$RDIR/inputs/_global.diff`: the full diff between those same SHAs,
  without a file filter, when at least one add-on is enabled.

Generate diffs directly into files with shell redirection; do not copy
large diffs through model output. Treat the input files as immutable
once dispatch starts. Reviewers must read their assigned inputs in full
(paging when needed), not regenerate diffs against moving branch refs.
They may inspect repository context, but must not change repository or
add-on files; only their own findings file may be written.

## Step 2 — Launch ALL reviewers in one parallel batch

Let `N` be the number of partitions. In **ONE assistant turn**, issue
**`7 × N + G` parallel `subagent` calls**, where `G` is the number of
calls the enabled add-ons ask for (`0` without add-ons). Include every
partition and every add-on pass in that same batch. Do not wait for one
partition, topic, or model to finish before launching another; do not
defer add-ons to a later turn. Only aggregation waits for the batch to finish.

### Partition reviewers

For EVERY partition, include these seven calls in the batch, each
scoped to that partition's files:

1. **Correctness** (`correctness`) — bugs, edge cases, concurrency, error handling, invariants. Two `review` calls: `sol` and `opus`.
2. **Security** (`security`) — injection, authn/authz, secrets, deserialization, SSRF/XSS/CSRF, crypto, input validation. One `security-review` call, no model override; pass id `native`.
3. **Performance** (`performance`) — hot paths, allocations, N+1, complexity regressions, I/O amplification, lock contention. Two `review` calls: `sol` and `opus`.
4. **Breaking changes** (`breaking-changes`) — removed/renamed exports, signature/behavior/wire changes, semver, migration. Two `review` calls: `sol` and `opus`.

Keep each call compact:

- `task` = assigned topic + instructions to read the shared context,
  partition descriptor, and diff in full, then write findings and return
  only the ack. Reference the concrete absolute paths under `$RDIR`;
  do not inline the diff, file list, or shared instructions.
- `context` = partition id, pass id, and the absolute input/output paths:
  `inputs/context.md`, `inputs/<partition_id>.json`,
  `inputs/<partition_id>.diff`, and
  `findings/<partition_id>__<topic_slug>__<pass>.yaml` under `$RDIR`.
- For each non-security call, set `model` to the full provider/model id
  from the pass table. Keep the review focused on its assigned topic.

### Global add-on reviewers (same batch)

For each add-on enabled in Step 0, include the `subagent` calls it
defines. They read `$RDIR/inputs/context.md` and
`$RDIR/inputs/_global.diff` in full and review the FULL diff, NOT
individual partitions. No add-on pass depends on any partition review
finishing.

Give each pass its own output path,
`$RDIR/findings/_global__<slug>__<pass>.yaml`, using the topic the
add-on names. Launch nothing for a skipped add-on and expect none of its
output files.

### Shared findings contract

Each subagent MUST sink its findings to its assigned YAML file and
return a one-line ack — this keeps the orchestrator's context small.
Store these instructions and the schema in `inputs/context.md`:

    Write only your assigned findings file using the shared schema.
    Do not read other reviewers' findings. Return only:
        "wrote <N> findings to <path>"

Shared schema (a YAML list, possibly empty):

    - topic: <topic>
      severity: CRITICAL | HIGH | MEDIUM | LOW
      location: <file:line>
      title: <short summary>
      detail: <what/why>
      suggestion: <concrete fix, optional>

Empty list = nothing material. Don't pad. The filename records the pass,
so the two models never overwrite each other's findings. For example:
`P1__correctness__sol.yaml`, `P1__correctness__opus.yaml`, and
`P1__security__native.yaml`.

## Step 3 — Aggregate

Wait for all dispatched calls to finish. Verify every expected findings
file exists and contains a YAML list (including `[]` for a clean pass):
seven per partition, plus one per enabled add-on pass. A failed
call, missing file, or invalid YAML is an incomplete pass, not a clean
review. Report incomplete passes explicitly; do not silently replace a
model or give an approval verdict while coverage is incomplete.

Read all `$RDIR/findings/*.yaml` and merge into one report:

- Sort CRITICAL → HIGH → MEDIUM → LOW; group under severity headings.
- Dedupe overlapping findings across passes, topics, and partitions
  (same underlying issue and location, even if titles differ). Preserve
  highest severity, merge useful evidence/suggestions, and list all
  topics (e.g. `topics: Security, Correctness`). Retain material
  findings found by only one model; agreement is not required.
- Prefix every entry with a severity-coded id: `C1, C2, …` for
  CRITICAL, `H1, H2, …` for HIGH, `M1, M2, …` for MEDIUM, `L1, L2, …`
  for LOW. Numbering resets per severity, in the order entries appear
  under that heading. These ids are the addressable handle used by
  `/iterate-review`.
- Each entry: `<id> file:line — title (topics: ...)` then detail and
  suggestion.
- Append summary: deduplicated counts per severity and topic, pass
  coverage (`sol` + `opus` for each non-security phase, one native
  Security pass per partition), and verdict (`block` / `request changes`
  / `approve with nits` / `LGTM`; use `incomplete` if coverage is missing
  and no blocking finding already determines the verdict). Apply every
  enabled add-on's aggregation rules, and note each skipped add-on. If
  the partition fallback was used, note it.

If nothing significant turned up, say so briefly.

## Arguments

`$ARGUMENTS` — optional PR/MR number/URL or narrowing hint
(`focus on <file>`, `focus on memory safety`). Store it verbatim in
`$RDIR/inputs/context.md` and require every subagent to read and honor it.
