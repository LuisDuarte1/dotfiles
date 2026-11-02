## Git Commit Amend Policy

When committing changes with git, the following OVERRIDES apply to the standard git safety rules:

- When `git log -1 --format='%an <%ae>'` shows the author is "Luís Duarte" with the repo's `git config user.email` (each repo may use a different address of mine), you ARE allowed to use `git commit --amend` on the HEAD commit, even if:
  - The branch is up to date with the remote (not ahead)
  - The commit was not created by you in this conversation
- This applies ONLY when the HEAD commit author is "Luís Duarte" and its email equals `git config user.email`
- Autosquash rebases (`git commit --fixup=<sha>` + `git rebase -i --autosquash`) are allowed on **unpushed** commits authored by Luís Duarte, so a fix can land in the commit that introduced it
- Still NEVER amend commits by other authors
- Still NEVER rewrite pushed commits, and NEVER force push to main/master without explicit permission

## Commit Conventions

Commits MUST be atomic, and commit messages MUST concisely explain why the change was made, not primarily what changed.

When you fix your own unpushed work (review feedback, lint, a forgotten file), amend or `--fixup` it into the commit that introduced it; never stack "address feedback" commits.

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

## Pi-specific notes

NEVER use subagents to review your own implementation unless explicitly asked.

Pi has no built-in plan mode, sub-agents, or todo list. Workarounds when these are needed:

- **Plans**: write to a `PLAN.md` file in the repo and iterate on it. Read it back at the start of each major step.
- **Todos**: maintain a `TODO.md` if the work is large. Models often confuse themselves with synthesized todo state, so prefer a real file.
- **Sub-agents**: split work into separate pi sessions (`pi --session <id>` to resume) or shell out for parallel work via `bash`.

Use the `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` built-in tools as the primary toolset. Skills under `~/.agents/skills/` are auto-discovered.
