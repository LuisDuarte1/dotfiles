## Git Commit Amend Policy

When committing changes with git, the following OVERRIDES apply to the standard git safety rules:

- When `git log -1 --format='%an <%ae>'` shows the author is "Luís Duarte" with the repo's `git config user.email` (each repo may use a different address of mine), you ARE allowed to use `git commit --amend` on the HEAD commit, even if:
  - The branch is up to date with the remote (not ahead)
  - The commit was not created by you in this conversation
- This applies ONLY when the HEAD commit author is "Luís Duarte" and its email equals `git config user.email`
- On my own MR and stack branches, rewriting is the default: fold fixes with `--fixup` + autosquash and push with `--force-with-lease`
- Once an MR has an approval, do not push to it without asking: a push resets approvals
- Still NEVER amend other authors' commits, and NEVER rewrite or force push main/master or a branch with other authors' commits

## Commit Conventions

Commits MUST be atomic, and commit messages MUST concisely explain why the change was made, not primarily what changed.

When you fix your own work (review feedback, lint, a forgotten file), amend or `--fixup` it into the commit that introduced it; never stack "address feedback" commits.

## Comment Block Length

Any comment block you write in code MUST be exactly 2 lines long. No more, no less.

The point of the limit is to force you to write only what is worth writing: **why** the code is
the way it is (the constraint, the bug, the trade-off), never **how** it works — the code already
says that. If two lines are not enough, the explanation is not concise enough, or it does not
belong in the code at all (put it in the commit message, a doc, or nowhere).

- This applies to ALL comment blocks regardless of language (`//`, `#`, `/* */`, `"""`, `<!-- -->`, etc.)
- NEVER stack blocks to buy more room: a 2-line block, a blank line, then another comment block is FORBIDDEN. Two adjacent comment blocks separated only by blank lines count as one over-long block
- If the content does not fit in 2 lines, cut it down — do not split it, do not continue it elsewhere
- Single-line inline comments at the end of a line of code are permitted and do not count as comment blocks
- Docstrings and JSDoc-style blocks also count as comment blocks and must follow this rule
- Do not comment the obvious: no restating the next statement, no section banners, no "first we do X, then Y" narration

## Mermaid diagrams

When asked for a Mermaid diagram, read `~/.pi/agent/MERMAID.md`.

## Waiting

NEVER `sleep N` and then act on the result — a guessed duration is either a stall or a race. Wait
on the event instead: block until the condition/log line/exit appears, or poll it in short intervals.
If you have other work meanwhile, `bg.notify` the job and do it; otherwise block on the event
(`bg.wait`, `ci-wait` for CI).

## Working rules

- A question gets an answer, not an action. Do only what was asked; report blockers.
- Where and how I say to run something is a constraint; facts I state about my systems are true.
- Smallest design first; nothing unrequested.
- Say "fixed", "ready", "all" or "safe" only with proof run after the last change.
- Gloss labels you coin, every time. End MR replies with the URL.
- A rule of mine that should outlast the task goes in the repo's AGENTS.md.
- Files that must outlive a command go in `~/.cache/<topic>/`, never `/tmp`.
- On an auth wall, stop and give me the login command; never poll.
- Never batch a tool call with the one that produces its input; batches run concurrently.

## Pi-specific notes

NEVER use subagents to review your own implementation unless explicitly asked.

Pi has no built-in plan mode or todo list. Workarounds when these are needed:

- **Plans**: write to a `PLAN.md` file in the repo and iterate on it. Read it back at the start of each major step.
- **Todos**: maintain a `TODO.md` if the work is large. Models often confuse themselves with synthesized todo state, so prefer a real file.
- **Sub-agents**: use the `subagent` tool; never spawn `pi -p` yourself.

Use the `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` built-in tools as the primary toolset. Skills under `~/.agents/skills/` are auto-discovered.
