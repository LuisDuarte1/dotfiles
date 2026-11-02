//! Classifies shell commands for blind `sleep` use. Rules live here rather than in the
//! extension so they are unit-testable on the host and identical in the wasm build.

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
        for c in &item.0.first.seq {
            walk_cmd(c, in_loop, depth, out);
        }
        for ao in &item.0.additional {
            let p = match ao {
                ast::AndOr::And(p) | ast::AndOr::Or(p) => p,
            };
            for c in &p.seq {
                walk_cmd(c, in_loop, depth, out);
            }
        }
    }
}

fn walk_cmd(c: &ast::Command, in_loop: bool, depth: usize, out: &mut Vec<Cmd>) {
    match c {
        ast::Command::Simple(s) => simple(s, in_loop, depth, out),
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
        C::Coprocess(cp) => walk_cmd(&cp.body, in_loop, depth, out),
        C::Arithmetic(_) => {}
    }
}

fn simple(cmd: &ast::SimpleCommand, in_loop: bool, depth: usize, out: &mut Vec<Cmd>) {
    let Some(raw_name) = cmd.word_or_name.as_ref().map(|w| w.value.clone()) else { return };
    let mut args: Vec<String> = vec![];
    if let Some(sfx) = &cmd.suffix {
        for item in &sfx.0 {
            if let ast::CommandPrefixOrSuffixItem::Word(w) = item {
                args.push(w.value.clone());
            }
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
