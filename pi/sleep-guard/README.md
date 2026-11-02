# sleep-guard

A pi guardrail that **blocks blind `sleep` in agent commands** before they run, and tells the model
what to do instead. Classification is a Rust function (`brush-parser` AST) compiled to wasm; the
TypeScript extension only marshals strings and renders reasons.

## Why

Instructions did not work. In one week of sessions, 68 `bash` calls slept blindly — including
`sleep 290; glab ci status --branch …` **seven times** in a session where the rule had already been
stated twice in chat. The failure mode is not just wasted wall-clock: the follow-up command runs at a
guessed moment, reads a half-finished state, and the model concludes the job died and starts over.

`pi/AGENTS.md` still carries the rule (`## Waiting`); this makes it enforceable.

## What it blocks

| rule | condition | example |
|---|---|---|
| R1 | sleep > 15s outside a loop | `sleep 290; glab ci status` |
| R2 | leading sleep > 5s with work after it | `sleep 6; check` |
| R3 | sleep > 30s inside a loop body | `for …; do check && break; sleep 60; done` |
| R4 | non-numeric duration | `sleep $WAIT`, `sleep 5m` |
| — | unterminated here-document | `git commit -F - <<'EOF' && git log` |

The heredoc rule is a freebie from having a parser: the model emits that shape often enough that bash
itself rejects it (`warning: here-document delimited by end-of-file`) after burning a turn — twice in
the sampled week, both producing an empty commit message.

Blocks are **non-terminating**, so the model can immediately retry with a poll loop or `bg.wait_for`.

## What stays allowed

```bash
for i in $(seq 1 60); do glab ci status | grep -q success && break; sleep 5; done
while ! curl -s localhost:8080; do sleep 2; done
(nohup node build.mjs &) ; sleep 2; echo started
pkill -9 -f workerd; sleep 1; pgrep -c workerd
pkill -f "sleep 300"          # a quoted pattern is not a sleep
python3 - <<'PY' … "sleep 300" … PY   # heredoc bodies are data
```

Measured over the last 7 days of real sessions: **3547 of 3598 bash calls allowed** (40 R1, 7 R2,
4 heredoc), and **512 of 528 bg_do snippets allowed** (3 R1, 10 R2, 3 R3), at ~0.06 ms per call.

## Scope

- `bash` — the whole command, following `bash -c "…"` payloads and unwrapping
  `timeout|nohup|env|nice|sudo|stdbuf|xargs`, plus `sleep(n)` inside `python3 -c`-style arguments.
- `bg_do` — the shell text of every `bg.run(…)` string literal (plain, f-string, triple-quoted).
  This complements the bg-do engine's own ban on `time.sleep` inside snippets.

Not detected, by design: a sleeping script written in one call and executed in another, sleeps inside
a package script or binary, non-`sleep` stalls (`read -t 300`, `timeout 300 tail -f`), and sleeps
reached through a variable (`cmd = "sleep 300"; bg.run(cmd)` — string literals only, no dataflow).

## Escape hatch

Genuinely time-based waits exist (measuring reclaim after N seconds, a rate window). Add a reason:

```bash
sleep 60 # guard:allow-sleep measuring RSS reclaim between two samples
```

The marker alone is not enough — a reason of at least 3 characters is required. Every use raises a
TUI warning with a per-session counter, so blanket bypassing is visible rather than silent.

## Failure mode

Fails **open**: a missing wasm (fresh clone, no cargo) or an unparseable command allows the call. A
guard that blocks work because its own artifact is missing would be worse than the habit it fixes.

## Layout and packaging

```
pi/sleep-guard/
  src/lib.rs              rules + unit tests (host-native)
  extensions/index.ts     tool_call hook, wasm loading, reason text
  Cargo.toml Cargo.lock
nix/sleep-guard.nix       buildRustPackage: wasm + cargo test, installs the pi package
```

It is deliberately **outside** `pi/extensions/` (pi auto-loads that directory) so the nix-built copy
is the only one registered — otherwise the hook would run twice. `nix/sleep-guard.nix` installs
`index.ts` and `sleep_guard.wasm` side by side into
`$out/lib/pi-extensions/sleep-guard/extensions/`, which install.sh's existing profile-scan loop
registers in `~/.pi/agent/settings.json`.

## Working on it

```bash
cargo test                                              # rules, fast
cargo build --release --target wasm32-unknown-unknown   # local artifact
pi -e ./pi/sleep-guard                                  # run pi with the local build
nix build .#packages.x86_64-linux.default               # what actually ships (runs cargo test too)
nix profile upgrade dotfiles                            # activate; extensions load at session start
```

`index.ts` tries the sibling `sleep_guard.wasm` first (store layout), then
`../target/wasm32-unknown-unknown/release/sleep_guard.wasm` (local cargo build).

Verdict codes cross the wasm boundary as integers (`0` allow, `1..5` rules, `6` hatch used, `9` parse
error); the human-readable reasons live in `index.ts` so they can be reworded without a rebuild.

## Tuning

Thresholds are constants at the top of `src/lib.rs` (`R1_MAX`, `R2_MAX`, `R3_MAX`), with the wrapper,
shell and interpreter name lists beside them. Change, `cargo test`, rebuild.

Rationale, the parser evaluation (regex vs tree-sitter vs shfmt vs napi.rs/cgo vs brush-parser) and
the remaining guardrail candidates live in `PLAN-guardrails.md` at the repo root.
