# bg_do (xonsh code-mode) pi tool — build plan

## Goal
A pi tool `bg_do` that runs agent-provided **xonsh** code against an injected `bg`
API for background-job orchestration. Non-blocking; jobs persist across calls in a
per-session persistent xonsh REPL. No `subprocess` in agent code (proven fluent in evals).

## Architecture
- Node (extension) owns the xonsh **process lifecycle** + a **unix-socket control channel**.
- xonsh owns the **job engine** (the validated `bg` bootstrap: `!()` + file-capture + os.killpg).
- Per bg_do call: Node sends base64(JSON{code}) over the socket; xonsh `execx`es it with
  stdout/stderr captured, replies base64(JSON{out,err}). Framing = base64 + newline.
- Persistent namespace `_NS` (seeded with `bg`) so jobs AND vars persist across calls.
- Timeout: Node awaits reply; on timeout sends SIGINT (serve loop catches → returns error),
  and if xonsh is wedged, kill + respawn (jobs lost, reported).
- session_shutdown: killpg the xonsh process group → all jobs die, no orphans.

## Steps
1. [x] Validate engine (evals): haiku/sonnet/opus 5/5, 0 subprocess.
2. [x] bg_engine.xsh: engine + socket serve loop. Validated with a standalone client.
3. [x] Extension: spawn xonsh lazily, net server, bg_do tool, /bg command, shutdown.
4. [x] Add xonsh + util-linux to flake.nix (engine falls back to pid kill without setsid).
5. [x] Load test + real model e2e (cross-call persistence, readiness, kill, no orphans).

## Status: DONE
- `xonsh` must be on PATH — run the flake rebuild/install so it lands in the profile.
- The old pure-JS `background-bash.ts` bg_do was removed to avoid a name collision.

## Dependencies
- `xonsh` (required) — add to flake.nix.
- `setsid` (optional, for process-group kill) — engine falls back to pid kill if absent.

## Notes / decisions
- Keep the pure-JS `background-bash.ts` bg_do too? → this xonsh tool is the intended
  `bg_do`; rename/retire the JS one to avoid a tool-name collision.
- Agent output convention: use `print(...)` for results (captured via redirect_stdout);
  bare xonsh subprocess stdout goes to fd1 and is NOT captured.
