//! Classifies shell commands for blind waits (`sleep` and its disguises). Rules live here rather
//! than in the extension so they are unit-testable on the host and identical in the wasm build.

use brush_parser::{Parser, ParserOptions, ast};

pub const ALLOW: u32 = 0;
pub const R1_STALL: u32 = 1;
pub const R2_SLEEP_THEN_ACT: u32 = 2;
pub const R3_COARSE_POLL: u32 = 3;
pub const R4_UNBOUNDED: u32 = 4;
pub const UNTERMINATED_HEREDOC: u32 = 5;
pub const ALLOW_VIA_HATCH: u32 = 6;
pub const ALLOW_PARSE_ERROR: u32 = 9;

/// Longest bash command seen in a week of real sessions was 17.8 KB.
pub const BUF_LEN: usize = 65536;

const HATCH: &str = "guard:allow-sleep";
const R1_MAX: f64 = 15.0;
const R2_MAX: f64 = 5.0;
const R3_MAX: f64 = 30.0;
const SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "ksh"];
const WRAPPERS: [&str; 7] = ["timeout", "nohup", "env", "nice", "sudo", "stdbuf", "xargs"];
const INTERPRETERS: [&str; 6] = ["python", "python3", "node", "bun", "perl", "ruby"];
const BLIND_STDIN: [&str; 2] = ["/dev/zero", "/dev/null"];
const GREPS: [&str; 4] = ["grep", "egrep", "fgrep", "rg"];

struct Cmd {
    name: String,
    arg: String,
    in_loop: bool,
}

pub fn is_block(code: u32) -> bool {
    matches!(code, R1_STALL | R2_SLEEP_THEN_ACT | R3_COARSE_POLL | R4_UNBOUNDED | UNTERMINATED_HEREDOC)
}

/// `# guard:allow-sleep <why>` opts a call out, but only with a reason attached.
fn has_hatch(src: &str) -> bool {
    src.find(HATCH).is_some_and(|i| src[i + HATCH.len()..].trim_start().trim_end().len() >= 3)
}

pub fn classify_bash(src: &str) -> u32 {
    if has_hatch(src) {
        return ALLOW_VIA_HATCH;
    }
    let mut cmds = vec![];
    match collect(src, false, 0, &mut cmds) {
        Ok(()) => {}
        Err(code) => return code,
    }
    verdict(&cmds)
}

/// bg_do snippets are Python/xonsh: the shell lives inside `bg.run("…")` payloads.
pub fn classify_snippet(code: &str) -> u32 {
    if has_hatch(code) {
        return ALLOW_VIA_HATCH;
    }
    for payload in bg_run_payloads(code) {
        let v = classify_bash(&payload);
        if is_block(v) {
            return v;
        }
    }
    ALLOW
}

fn verdict(cmds: &[Cmd]) -> u32 {
    let sleeps: Vec<usize> = cmds.iter().enumerate().filter(|(_, c)| c.name == "sleep").map(|(i, _)| i).collect();
    for i in sleeps {
        let c = &cmds[i];
        let Ok(n) = c.arg.parse::<f64>() else { return R4_UNBOUNDED };
        if c.in_loop {
            if n > R3_MAX {
                return R3_COARSE_POLL;
            }
            continue;
        }
        if n > R1_MAX {
            return R1_STALL;
        }
        // Stalling before doing work is the anti-pattern; a trailing `sleep` is just a wait.
        let leading = cmds[..i].iter().all(|p| p.name == "cd");
        let followed_by_work = cmds[i + 1..].iter().any(|p| p.name != "cd");
        if leading && followed_by_work && n > R2_MAX {
            return R2_SLEEP_THEN_ACT;
        }
    }
    ALLOW
}

fn collect(src: &str, in_loop: bool, depth: usize, out: &mut Vec<Cmd>) -> Result<(), u32> {
    let parsed = Parser::new(std::io::Cursor::new(src.to_string()), &ParserOptions::default()).parse_program();
    let prog = match parsed {
        Ok(p) => p,
        Err(e) => {
            let msg = e.to_string();
            return Err(if msg.contains("here document") { UNTERMINATED_HEREDOC } else { ALLOW_PARSE_ERROR });
        }
    };
    for cc in &prog.complete_commands {
        walk_list(cc, in_loop, depth, out);
    }
    Ok(())
}

fn walk_list(l: &ast::CompoundList, in_loop: bool, depth: usize, out: &mut Vec<Cmd>) {
    for item in &l.0 {
        walk_pipeline(&item.0.first, in_loop, depth, out);
        for ao in &item.0.additional {
            let p = match ao {
                ast::AndOr::And(p) | ast::AndOr::Or(p) => p,
            };
            walk_pipeline(p, in_loop, depth, out);
        }
    }
}

fn walk_pipeline(p: &ast::Pipeline, in_loop: bool, depth: usize, out: &mut Vec<Cmd>) {
    for (i, c) in p.seq.iter().enumerate() {
        let drained = p.seq[i + 1..].iter().any(ends_early);
        walk_cmd(c, in_loop, depth, drained, out);
    }
}

/// A consumer that exits on its own takes the `tail -f` feeding it down with SIGPIPE,
/// so `timeout N tail -f … | grep -m1 ready` ends on the event, not after N seconds.
fn ends_early(c: &ast::Command) -> bool {
    let ast::Command::Simple(s) = c else { return false };
    let Some((name, args)) = words(s) else { return false };
    let stops = |a: &String| {
        matches!(a.as_str(), "--quiet" | "--silent") || a.starts_with("--max-count") || short_flag(a, "mq", "efmABCdD")
    };
    name == "head" || (GREPS.contains(&name.as_str()) && args.iter().take_while(|a| *a != "--").any(stops))
}

/// Letters after an option that takes a value belong to that value, so in `grep -eq` the
/// `q` is the pattern, not `--quiet`.
fn short_flag(arg: &str, flags: &str, valued: &str) -> bool {
    let Some(cluster) = arg.strip_prefix('-').filter(|c| !c.starts_with('-')) else { return false };
    cluster.chars().find(|c| flags.contains(*c) || valued.contains(*c)).is_some_and(|c| flags.contains(c))
}

fn walk_cmd(c: &ast::Command, in_loop: bool, depth: usize, drained: bool, out: &mut Vec<Cmd>) {
    match c {
        ast::Command::Simple(s) => simple(s, in_loop, depth, drained, out),
        ast::Command::Compound(cc, _) => compound(cc, in_loop, depth, out),
        ast::Command::Function(f) => compound(&f.body.0, in_loop, depth, out),
        ast::Command::ExtendedTest(..) => {}
    }
}

fn compound(c: &ast::CompoundCommand, in_loop: bool, depth: usize, out: &mut Vec<Cmd>) {
    use ast::CompoundCommand as C;
    match c {
        C::ForClause(f) => walk_list(&f.body.list, true, depth, out),
        C::ArithmeticForClause(f) => walk_list(&f.body.list, true, depth, out),
        C::WhileClause(w) | C::UntilClause(w) => {
            walk_list(&w.0, in_loop, depth, out);
            walk_list(&w.1.list, true, depth, out);
        }
        C::BraceGroup(g) => walk_list(&g.list, in_loop, depth, out),
        C::Subshell(s) => walk_list(&s.list, in_loop, depth, out),
        C::IfClause(i) => {
            walk_list(&i.condition, in_loop, depth, out);
            walk_list(&i.then, in_loop, depth, out);
            for e in i.elses.iter().flatten() {
                walk_list(&e.body, in_loop, depth, out);
            }
        }
        C::CaseClause(cc) => {
            for item in &cc.cases {
                if let Some(l) = &item.cmd {
                    walk_list(l, in_loop, depth, out);
                }
            }
        }
        C::Coprocess(cp) => walk_cmd(&cp.body, in_loop, depth, false, out),
        C::Arithmetic(_) => {}
    }
}

fn words(cmd: &ast::SimpleCommand) -> Option<(String, Vec<String>)> {
    let raw_name = cmd.word_or_name.as_ref()?.value.clone();
    let mut args: Vec<String> = vec![];
    if let Some(sfx) = &cmd.suffix {
        for item in &sfx.0 {
            if let ast::CommandPrefixOrSuffixItem::Word(w) = item {
                args.push(w.value.clone());
            }
        }
    }
    Some((raw_name, args))
}

/// `read -t N` never sees a newline from /dev/zero, so it is `sleep N` in disguise; from
/// /dev/null it returns at once, but the intent is the same blind wait.
fn blind_read(cmd: &ast::SimpleCommand, args: &[String]) -> Option<String> {
    use ast::{
        CommandPrefixOrSuffixItem as I, IoFileRedirectKind as K, IoFileRedirectTarget as T, IoRedirect as R,
    };
    let mut items = cmd.prefix.iter().flat_map(|p| &p.0).chain(cmd.suffix.iter().flat_map(|s| &s.0));
    let blind = items.any(|i| match i {
        I::IoRedirect(R::File(fd, K::Read | K::ReadAndWrite, T::Filename(w))) => {
            fd.unwrap_or(0) == 0 && BLIND_STDIN.contains(&unquote(&w.value).as_str())
        }
        _ => false,
    });
    if !blind {
        return None;
    }
    let mut it = args.iter();
    while let Some(flags) = it.next().and_then(|a| a.strip_prefix('-')) {
        if let Some(i) = flags.find(|c| "adinNptu".contains(c)) {
            let val = if i + 1 < flags.len() { flags[i + 1..].to_string() } else { it.next()?.clone() };
            if flags[i..].starts_with('t') {
                return Some(val);
            }
        }
    }
    None
}

/// `tail --pid` ends with that process, so only a plain follow waits out the whole timeout.
/// `-k` and `-s` take a value of their own, which must not be mistaken for the duration.
fn blind_tail(args: &[String]) -> Option<String> {
    let mut i = 0;
    while args.get(i).is_some_and(|a| a.starts_with('-')) {
        i += if matches!(args[i].as_str(), "-k" | "-s" | "--kill-after" | "--signal") { 2 } else { 1 };
    }
    let dur = args.get(i)?;
    let (cmd, rest) = args.get(i + 1..)?.split_first()?;
    let follows = rest.iter().any(|a| a.starts_with("--follow") || short_flag(a, "fF", "cns"));
    let pid = rest.iter().any(|a| a.starts_with("--pid"));
    (cmd == "tail" && follows && !pid).then(|| dur.clone())
}

fn simple(cmd: &ast::SimpleCommand, in_loop: bool, depth: usize, drained: bool, out: &mut Vec<Cmd>) {
    let Some((raw_name, args)) = words(cmd) else { return };
    if raw_name == "timeout" && !drained {
        if let Some(n) = blind_tail(&args) {
            out.push(Cmd { name: "sleep".into(), arg: n, in_loop });
            return;
        }
    }

    // `timeout 20 bash -c '…'` hides the real command one level down.
    let (name, args) = if WRAPPERS.contains(&raw_name.as_str()) {
        let rest: Vec<String> = args
            .iter()
            .skip_while(|a| a.starts_with('-') || a.parse::<f64>().is_ok())
            .cloned()
            .collect();
        match rest.split_first() {
            Some((n, r)) => (n.clone(), r.to_vec()),
            None => (raw_name, args),
        }
    } else {
        (raw_name, args)
    };

    if name == "read" {
        if let Some(n) = blind_read(cmd, &args) {
            out.push(Cmd { name: "sleep".into(), arg: n, in_loop });
            return;
        }
    }
    if name == "sleep" {
        out.push(Cmd { name, arg: args.first().cloned().unwrap_or_default(), in_loop });
        return;
    }
    if SHELLS.contains(&name.as_str()) && depth < 2 {
        if let Some(payload) = args.iter().position(|a| a == "-c").and_then(|i| args.get(i + 1)) {
            let _ = collect(&unquote(payload), in_loop, depth + 1, out);
        }
        return;
    }
    if INTERPRETERS.contains(&name.as_str()) {
        if let Some(n) = args.join(" ").split("sleep(").nth(1).and_then(|t| t.split(')').next()) {
            out.push(Cmd { name: "sleep".into(), arg: n.trim().to_string(), in_loop });
        }
    }
    out.push(Cmd { name, arg: String::new(), in_loop });
}

fn unquote(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        return s[1..s.len() - 1].to_string();
    }
    s.to_string()
}

/// Pulls the shell text out of `bg.run("…")` / `bg.run(f'''…''')` calls.
fn bg_run_payloads(code: &str) -> Vec<String> {
    let mut out = vec![];
    let bytes = code.as_bytes();
    let mut from = 0;
    while let Some(rel) = code[from..].find("bg.run(") {
        let mut i = from + rel + "bg.run(".len();
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i < bytes.len() && (bytes[i] == b'f' || bytes[i] == b'r' || bytes[i] == b'b') {
            i += 1;
        }
        from = i;
        if i >= bytes.len() || (bytes[i] != b'"' && bytes[i] != b'\'') {
            continue;
        }
        let q = bytes[i];
        let triple = bytes.len() > i + 2 && bytes[i + 1] == q && bytes[i + 2] == q;
        let (open, close) = if triple { (i + 3, 3) } else { (i + 1, 1) };
        let needle: String = std::iter::repeat_n(q as char, close).collect();
        if let Some(end) = code[open..].find(&needle) {
            out.push(code[open..open + end].to_string());
            from = open + end + close;
        }
    }
    out
}

// --- wasm entry points: JS writes UTF-8 into the buffer and gets a verdict code back.

static mut BUF: [u8; BUF_LEN] = [0; BUF_LEN];

#[unsafe(no_mangle)]
pub extern "C" fn buffer() -> *mut u8 {
    unsafe { &raw mut BUF as *mut u8 }
}

fn buf_str(len: usize) -> &'static str {
    let slice = unsafe { &(&raw const BUF).as_ref().unwrap()[..len.min(BUF_LEN)] };
    std::str::from_utf8(slice).unwrap_or("")
}

#[unsafe(no_mangle)]
pub extern "C" fn classify_bash_buf(len: usize) -> u32 {
    classify_bash(buf_str(len))
}

#[unsafe(no_mangle)]
pub extern "C" fn classify_snippet_buf(len: usize) -> u32 {
    classify_snippet(buf_str(len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[track_caller]
    fn check(expected: u32, cmd: &str) {
        let got = classify_bash(cmd);
        assert_eq!(got, expected, "classify_bash({cmd:?}) = {got}, want {expected}");
    }

    #[test]
    fn blocks_the_real_offenders() {
        check(R1_STALL, "sleep 290; glab ci status --branch x");
        check(R1_STALL, "sleep 400; tail -3 /tmp/x.log");
        check(R1_STALL, "cd /home/lduarte/workflows && sleep 420; glab ci status");
        check(R1_STALL, r#"bash -c "sleep 300; glab ci status""#);
        check(R1_STALL, "timeout 20 bash -c 'sleep 300; ls'");
        check(R1_STALL, r#"python3 -c "import time; time.sleep(300)"; ls"#);
        check(R1_STALL, r#"cd /x && sleep 20 && glab api "a" | python3 -c "[print(j) for j in d]""#);
    }

    #[test]
    fn thresholds_are_where_we_said() {
        check(ALLOW, "sleep 15");
        check(R1_STALL, "sleep 16");
        check(ALLOW, "sleep 5; check");
        check(R2_SLEEP_THEN_ACT, "sleep 6; check");
        check(ALLOW, "for i in $(seq 1 40); do grep -q done /tmp/l && break; sleep 30; done");
        check(R3_COARSE_POLL, "for i in $(seq 1 40); do grep -q done /tmp/l && break; sleep 31; done");
    }

    #[test]
    fn keeps_legitimate_waits() {
        check(ALLOW, "while ! curl -s localhost:8080; do sleep 2; done");
        check(ALLOW, "(nohup node b.mjs &) ; sleep 2; echo started");
        check(ALLOW, "pkill -9 -f workerd; sleep 1; pgrep -c workerd");
        check(ALLOW, "timeout 300 curl -s http://x");
        check(ALLOW, "for i in $(seq 1 40); do s=$(glab api jobs/1); sleep 15; done");
    }

    #[test]
    fn the_readme_allowed_examples_stay_allowed() {
        check(ALLOW, "for i in $(seq 1 60); do glab ci status | grep -q success && break; sleep 5; done");
        check(ALLOW, "while ! curl -s localhost:8080; do sleep 2; done");
        check(ALLOW, "(nohup node build.mjs &) ; sleep 2; echo started");
        check(ALLOW, "pkill -9 -f workerd; sleep 1; pgrep -c workerd");
        check(ALLOW, r#"pkill -f "sleep 300""#);
        check(ALLOW, "python3 - <<'PY'\nprint(\"sleep 300\")\nPY\n");
        check(ALLOW, "read -t 5 < /dev/zero");
        check(ALLOW, "read -t 300 line < some.fifo");
        check(ALLOW, "read -r line");
        check(ALLOW, "timeout 60 tail -f log | grep -m1 ready");
        check(ALLOW, "timeout 5 tail -f log");
        check(ALLOW, "timeout 1500 tail --pid=63681 -f /dev/null");
    }

    #[test]
    fn blind_read_is_a_sleep() {
        check(R1_STALL, "read -t 840 < /dev/zero 2>/dev/null; ~/.cache/bench/status.sh");
        check(R1_STALL, "cd ~/bench && read -t 840 < /dev/zero 2>/dev/null; date +%T");
        check(R1_STALL, "read -r -t 300 _ </dev/null || true");
        check(R1_STALL, "read -rt 60 0</dev/zero");
        check(R1_STALL, "read -p go -t60 < '/dev/zero'");
        check(R1_STALL, "timeout 900 bash -c 'read -t 840 < /dev/zero'");
        check(R2_SLEEP_THEN_ACT, "read -t 6 < /dev/zero; check");
        check(R3_COARSE_POLL, "until grep -q EXIT l; do read -t 60 < /dev/zero; done");
        check(R4_UNBOUNDED, "read -t $WAIT < /dev/zero; check");
        assert_eq!(classify_snippet("bg.run(\"read -t 600 < /dev/zero; check\")"), R1_STALL);
    }

    #[test]
    fn reads_that_wait_on_input_are_not_sleeps() {
        check(ALLOW, "read -t 300 line < some.fifo; echo $line");
        check(ALLOW, "read -t 300 -p 'continue? ' answer");
        check(ALLOW, "read -t 300 < <(:); check");
        check(ALLOW, "read -d '' -r body < /dev/null; echo \"$body\"");
        check(ALLOW, "read -t 300 2>/dev/null; check");
        check(ALLOW, "until grep -q EXIT l; do read -t 30 < /dev/zero 2>/dev/null; done; true");
        check(ALLOW, "for i in $(seq 50); do pgrep x || break; read -t 0.5 < /dev/zero; done");
    }

    #[test]
    fn blind_tail_is_a_sleep() {
        check(R1_STALL, "timeout 300 tail -f log");
        check(R1_STALL, "timeout 60 tail -n0 -F log | grep --line-buffered ready");
        check(R1_STALL, "timeout 60 tail -f log | grep -emissing");
        check(R1_STALL, "timeout -s INT 60 tail -fn0 log 2>&1 | tee out");
        check(R1_STALL, "timeout --kill-after 5 60 tail --follow=name log > out");
        check(R2_SLEEP_THEN_ACT, "timeout 10 tail -f log; check");
        check(R3_COARSE_POLL, "for f in a b; do timeout 60 tail -f $f; done");
        check(R4_UNBOUNDED, "timeout 5m tail -f log");
    }

    #[test]
    fn tails_that_end_on_an_event_are_not_sleeps() {
        check(ALLOW, "timeout 60 tail -f log | grep -m 1 ready; check");
        check(ALLOW, "timeout 60 tail -f log | grep -Eq 'ready|failed' && check");
        check(ALLOW, "timeout 60 tail -F log | grep --max-count=1 ready");
        check(ALLOW, "timeout 60 tail -f log | grep --line-buffered x | head -5");
        check(ALLOW, "timeout 60 tail -n 50 log; check");
        check(ALLOW, "timeout 600 pnpm exec vitest run 2>&1 | tail -60");
        check(ALLOW, "timeout 60 bash -c 'tail -f log | grep -m1 ready'");
    }

    #[test]
    fn a_quoted_sleep_is_not_a_sleep() {
        check(ALLOW, r#"pkill -f "sleep 300""#);
        check(ALLOW, r#"pgrep -fa "sleep 300" | head -5; pkill -f "sleep 300""#);
        check(ALLOW, r#"echo "sleep 999""#);
        check(ALLOW, "python3 - <<'PY'\nimport re\nre.compile(r\"sleep 300\")\nPY\n");
    }

    #[test]
    fn unbounded_sleeps_are_blocked() {
        check(R4_UNBOUNDED, "sleep $WAIT; check");
        check(R4_UNBOUNDED, "sleep 5m; check");
    }

    #[test]
    fn heredoc_shapes_parse() {
        check(ALLOW, "cat <<'EOF' && echo done\nhi\nEOF\n");
        check(ALLOW, "python3 - <<'EOF' 2>&1 | grep x\nprint(1)\nEOF\n");
        check(ALLOW, "cat <<-'EOF' && echo d\n\thi\n\tEOF\n");
        // The model really sends these, and bash rejects them too.
        check(UNTERMINATED_HEREDOC, "git commit -q -F - <<'EOF' && git log --oneline -1");
    }

    #[test]
    fn escape_hatch_needs_a_reason() {
        assert_eq!(classify_bash("sleep 300 # guard:allow-sleep measuring GC reclaim"), ALLOW_VIA_HATCH);
        assert_eq!(classify_bash("sleep 300 # guard:allow-sleep"), R1_STALL);
    }

    #[test]
    fn bg_run_payloads_are_classified() {
        assert_eq!(classify_snippet("jid = bg.run(\"sleep 300; check\")"), R1_STALL);
        assert_eq!(classify_snippet("jid = bg.run('npm run dev')\nprint(jid)"), ALLOW);
        assert_eq!(classify_snippet("bg.run(f\"cd {d} && sleep 290; glab ci status\")"), R1_STALL);
        assert_eq!(classify_snippet("bg.run(\"\"\"sleep 600; ls\"\"\")"), R1_STALL);
        assert_eq!(classify_snippet("bg.run(\"pkill -f 'sleep 300'\"); bg.run(\"sleep 1; echo ok\")"), ALLOW);
        assert_eq!(classify_snippet("bg.run(\"trap '' INT; sleep 400\")  # guard:allow-sleep SIGINT fixture"), ALLOW_VIA_HATCH);
    }
}
