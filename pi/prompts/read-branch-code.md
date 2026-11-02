---
description: Explain a branch/PR/MR diff via a research subagent — what changed, why, how it fits
argument-hint: "[PR/MR ref or focus hint]"
---

Call the `subagent` tool ONCE with `agent: research`. Not a review —
explanation only.

## Scope

Default: `git diff origin/main...HEAD` + `git log --oneline
origin/main..HEAD`. GitHub ref in `$ARGUMENTS` → `gh pr view/diff`.
GitLab ref → `glab mr view/diff`. Non-ref text → forward verbatim as
focus hint.

## Subagent task

Pass the diff, commit list, base/head SHAs, and file list. Tell it:

> Explain this branch. Read touched files + callers/tests; use `git
> blame` / `git log` for intent. Cite `file:line` for every claim.
> Don't speculate — flag ambiguity. Skip empty sections.
>
> Return:
>
>     summary: <2–4 sentences>
>     changes:
>       - area: <subsystem>
>         files: [<path>: <role>]
>         what / why / how
>     public_surface: [<file:line> — <added|modified|removed> <sig delta>]
>     flow: [<new/changed control or data flow, file:line>]
>     tests: { added, modified, gaps }
>     deps_config: [<manifest/CI/env change, file:line>]
>     open_questions: [<unanswered by the diff alone>]

## Output

Print one banner line — `Reading <BASE>..<HEAD> — <N> commits, <M>
files` — then the subagent report verbatim. No extra analysis.
