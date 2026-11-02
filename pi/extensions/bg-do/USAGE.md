# bg_do — usage guide

`bg_do` runs **xonsh** code ("code mode") in a **persistent per-session REPL** with an
injected `bg` API for background-job orchestration. It is non-blocking: commands run in
the background so the agent is never blocked, and **jobs and variables persist across
`bg_do` calls** in the same session. Jobs also **survive a pi `/reload`** (the engine is
reattached automatically); they are killed only when pi fully exits.

## When to use (and when NOT to)
Use `bg_do` **only for long-running / non-terminating commands** — dev servers, file watchers,
`tail -f`, long builds, log follows: anything that keeps running or that you want to poll while
it runs.

**Do NOT** use `bg_do` for short, one-shot commands that finish on their own (`ls`, `cat`,
`git status`, a quick script, a normal build that just needs to complete). Run those with the
regular `bash` tool. If a command wouldn't benefit from being backgrounded/polled/killed, it
doesn't belong here.

## Output: what comes back
Both are captured and returned as the tool result:
- Python `print(...)`
- plain shell / pipeline stdout (bare commands like `echo x | tr a-z A-Z`)

Errors (exceptions / tracebacks) are returned as a tool error.

Job ids are always reported, even when the snippet fails: `bg.run` echoes
`[bg] started bg-1 (pid …) log …: <cmd>` the moment the job exists, and every result ends with
`[bg] jobs: bg-1 running, …`. **A traceback or timeout does not stop the jobs** — take the ids
from that footer and poll them in the next call instead of starting the work again.

Return **only what you need** — filter first with a pipeline, don't dump whole logs.

Note: Python `print(...)` and raw shell/pipeline output may interleave (stdio buffering). If exact
ordering matters within one call, stick to one or the other (e.g. all pipelines, or capture with `$(...)`).

## The `bg` API
```
bg.run(cmd, cwd=None) -> str            # start a shell command in the background; returns a job id ("bg-1")
bg.output(id, mode="new") -> list[str]  # Python list of lines. "new" = since last read (poll); "all" = everything
bg.lines(id) -> list[str]               # all lines so far (Python list)
bg.wait_for(id, regex, timeout=10.0) -> str | None   # block until a line matches; returns that line or None
bg.wait(id, timeout=None) -> dict       # block until the job exits; returns a snapshot
bg.kill(id, sig="TERM") -> True         # terminate the job (whole process group)
bg.get(id).snapshot() -> dict           # {id, cmd, running, returncode, lines, path}
bg.list() -> [snapshot]                 # all jobs this session
bg.path(id) -> str                      # backing log file (stdout+stderr merged) — for your own tail -f / shell
```

To wait, block on an *event*: `bg.wait_for(id, regex)` (until a matching line appears) or
`bg.wait(id, timeout=...)` (until the job exits).

## Pipes: reading a job's output with shell tools
`bg.output(id)` / `bg.lines(id)` return a **Python list** — so `bg.output(id) | grep` does
**NOT** work (`|` in Python is bitwise-OR, not a shell pipe; xonsh only pipes *between commands*).

To pipe a job's captured output through real shell tools, use the **`bgout` command** and pass
the id with `@(...)` (xonsh's Python→command substitution):

```python
bgout @(jid) | grep -i error | head              # native pipe; output is returned
bgout @(jid) | grep -i error | awk '{print $2}' | tail -1
n = $(bgout @(jid) | grep -c warning); print(n)  # capture a pipeline into a Python value
```

Or operate on the backing file directly:
```python
print($(tail -20 @(bg.path(jid))))
print($(grep -c warning @(bg.path(jid))).strip())
```

**Prefer pipelines** for slicing/searching output. Drop to Python only for structured logic
(branching on a count, JSON, etc.) — and even then, capture the pipeline result:
```python
fails = int($(bgout @(jid) | grep -ic fail) or 0)
if fails:
    bgout @(jid) | grep -i fail | tail -5
```

## Timeouts (`timeout_seconds`)
Each call gets **120s** by default and **600s** max — set `timeout_seconds` (the parameter is
*not* called `timeout`, though that spelling is accepted as an alias). Asking for more than 600 is
an **error**, not a clamp.

A snippet that exceeds its timeout is interrupted, but **the jobs keep running** — don't restart
them. Prefer short calls: start the job in one call, then poll it in later calls
(`bg.wait_for(id, rx, timeout=...)`, `bg.output(id)`) instead of blocking for many minutes in one.

## Rules
- Do **NOT** use the `subprocess` module, `Popen`, `os.system`, `os.fork`, or `multiprocessing`.
  Manage every process through the `bg` API.
- To wait, block on an event: `bg.wait_for(id, regex)` for a readiness/error line, or
  `bg.wait(id, timeout=...)` for completion.
- Use `print(...)` for Python values; write bare pipelines for shell output.
- For **streaming** pipes, force line-buffering so `wait_for`/`output` see lines promptly:
  `bg.run("tail -f app.log | grep --line-buffered -i error")` or wrap a tool with `stdbuf -oL`.
- Always `bg.kill(id)` jobs you no longer need.

## Examples (pipeline-first)

Build: exit code + recent output + error count — all via pipelines:
```python
jid = bg.run("make -j4 2>&1"); bg.wait(jid)
print("exit", bg.get(jid).snapshot()["returncode"])
bgout @(jid) | tail -20
bgout @(jid) | grep -ic error
```

Readiness, then show the matching lines:
```python
jid = bg.run("npm run dev")
print(bg.wait_for(jid, r"listening on|error", timeout=30) or "timeout")
bgout @(jid) | grep -iE "listening|error" | tail -3
```

Start now, carve the log later (jobs persist across bg_do calls):
```python
# call 1
srv = bg.run("python -m http.server 8000"); print(srv)
```
```python
# later call — pipe the accumulated log
bgout @(srv) | grep -E "GET|POST|error" | tail -10
```
```python
bg.kill(srv)
```

Top clients (grep|awk|sort|uniq|head):
```python
jid = bg.run("cat access.log"); bg.wait(jid)
bgout @(jid) | awk '{print $1}' | sort | uniq -c | sort -rn | head -5
```

Extract a CSV column, unique values (skip header):
```python
jid = bg.run("cat data.csv"); bg.wait(jid)
bgout @(jid) | tail -n +2 | cut -d, -f2 | sort -u
```

Branch on a pipeline result (capture a count into Python):
```python
jid = bg.run("./run-tests.sh 2>&1"); bg.wait(jid)
fails = int($(bgout @(jid) | grep -c FAIL) or 0)
print("FAILED" if fails else "passed", fails)
bgout @(jid) | grep -E "FAIL|Error" | head        # show them
```

Combine two jobs' output with one pipeline:
```python
a = bg.run("echo apple; echo avocado"); b = bg.run("echo banana; echo berry")
bg.wait(a); bg.wait(b)
cat @(bg.path(a)) @(bg.path(b)) | sort | paste -sd,
```

Streaming pipe (line-buffered) + readiness + transform:
```python
jid = bg.run("tail -f app.log | grep --line-buffered -i error")
bg.wait_for(jid, r"error", timeout=30)
bgout @(jid) | sed 's/^/ERR> /' | tail -5
bg.kill(jid)
```

Progress at a glance:
```python
jid = bg.run("npm test 2>&1"); bg.wait(jid)
bgout @(jid) | tail -1        # final summary line
bgout @(jid) | grep -c PASS   # passing tests
```

## From the TUI
`/bg` lists background jobs and their status.
