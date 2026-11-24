export type Kind = "bash" | "snippet";
export type Verdict = "allow" | "block" | "hatch";
export type Args = (string | null)[];

const HATCH = /guard:allow-pi(?![\w-])([^\n]*)/g;
const MAX_DEPTH = 6;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const RESERVED = new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const OPS = [";;&", ";;", ";&", ";", "&&", "&", "||", "|&", "|", "(", ")"];
const REDIRS = ["&>>", "&>", "<<<", "<<-", "<<", "<&", "<>", "<", ">>", ">&", ">|", ">"];

const PI_SUBCOMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);
const PI_EXITS_EARLY = new Set(["-h", "--help", "-v", "--version"]);
const PI_VALUED = new Set([
	"--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session",
	"--session-id", "--fork", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking",
	"--export", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode",
]);

interface Wrapper {
	valued: string[];
	positionals?: number;
	assignments?: boolean;
	lookups?: string[];
}

const WRAPPERS = new Map<string, Wrapper>([
	["nohup", { valued: [] }],
	["setsid", { valued: [] }],
	["exec", { valued: ["-a"] }],
	["nice", { valued: ["-n", "--adjustment"] }],
	["ionice", { valued: ["-c", "-n", "--class", "--classdata"] }],
	["timeout", { valued: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 }],
	["env", { valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"], assignments: true }],
	["command", { valued: [], lookups: ["-v", "-V"] }],
	["time", { valued: ["-f", "-o", "--format", "--output"] }],
	["stdbuf", { valued: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
	["sudo", { valued: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group"] }],
	[
		"xargs",
		{ valued: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs"] },
	],
]);

const PY_ESCAPES = new Map([["\\", "\\"], ["'", "'"], ['"', '"'], ["n", "\n"], ["t", "\t"], ["\n", ""]]);
const PY_STRING = /[rRbBuUfF]{0,2}('''|"""|'|")/y;
const BG_RUN = /\bbg\.(?:run|start)\(\s*/g;

interface Word {
	kind: "word";
	value: string;
	raw: string;
	literal: boolean;
}

interface Op {
	kind: "op";
	value: string;
}

interface Redir {
	kind: "redir";
	value: string;
	delim?: string;
	quoted?: boolean;
	body?: string;
}

type Token = Word | Op | Redir;

interface Simple {
	words: Word[];
	redirs: { redir: Redir; target?: Word }[];
}

const blankWord = (): Word => ({ kind: "word", value: "", raw: "", literal: true });

class Lexer {
	private pos = 0;
	private pending: Redir[] = [];
	private readonly src: string;
	private readonly lists: Token[][];

	constructor(src: string, lists: Token[][]) {
		this.src = src;
		this.lists = lists;
	}

	// `$(…)` and backticks run their commands even inside quotes or arguments, so each one
	// is lexed as its own command list rather than as part of the enclosing word.
	list(closer: boolean): void {
		const s = this.src;
		const tokens: Token[] = [];
		this.lists.push(tokens);
		let depth = 0;
		let word: Word | null = null;
		let start = 0;
		let delimFor: Redir | null = null;
		const end = () => {
			if (!word) return;
			word.raw = s.slice(start, this.pos);
			tokens.push(word);
			if (delimFor) {
				delimFor.delim = word.value;
				delimFor.quoted = /['"\\]/.test(word.raw);
				this.pending.push(delimFor);
				delimFor = null;
			}
			word = null;
		};
		const current = (): Word => {
			if (!word) {
				word = blankWord();
				start = this.pos;
			}
			return word;
		};

		while (this.pos < s.length) {
			const c = s[this.pos];
			const next = s[this.pos + 1];
			if (c === " " || c === "\t") {
				end();
				this.pos++;
			} else if (c === "\\" && next === "\n") {
				this.pos += 2;
			} else if (c === "\n") {
				end();
				tokens.push({ kind: "op", value: "\n" });
				this.pos++;
				this.heredocBodies();
			} else if (c === "#" && !word) {
				const eol = s.indexOf("\n", this.pos);
				this.pos = eol < 0 ? s.length : eol;
			} else if (c === ")" && closer && depth === 0) {
				end();
				this.pos++;
				return;
			} else if ((c === "<" || c === ">") && next === "(") {
				current().literal = false;
				this.pos += 2;
				this.list(true);
			} else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
				if (word && /^\d+$/.test(s.slice(start, this.pos))) word = null;
				else end();
				const value = REDIRS.find((r) => s.startsWith(r, this.pos)) ?? c;
				this.pos += value.length;
				const redir: Redir = { kind: "redir", value };
				tokens.push(redir);
				if (value === "<<" || value === "<<-") delimFor = redir;
			} else if (";&|()".includes(c)) {
				end();
				const value = OPS.find((o) => s.startsWith(o, this.pos)) ?? c;
				this.pos += value.length;
				if (value === "(") depth++;
				if (value === ")") depth--;
				tokens.push({ kind: "op", value });
			} else {
				const w = current();
				if (c === "'") {
					const close = s.indexOf("'", this.pos + 1);
					const stop = close < 0 ? s.length : close;
					w.value += s.slice(this.pos + 1, stop);
					this.pos = stop + 1;
				} else if (c === '"') {
					this.pos++;
					this.double(w, true);
				} else if (c === "\\") {
					w.value += next ?? "";
					this.pos += 2;
				} else if (!this.expansion(w, false)) {
					w.value += c;
					this.pos++;
				}
			}
		}
		end();
	}

	private double(w: Word, closed: boolean): void {
		const s = this.src;
		while (this.pos < s.length) {
			const c = s[this.pos];
			if (closed && c === '"') {
				this.pos++;
				return;
			}
			if (c === "\\" && this.pos + 1 < s.length) {
				const n = s[this.pos + 1];
				if (n !== "\n") w.value += '$`"\\'.includes(n) ? n : c + n;
				this.pos += 2;
			} else if (!this.expansion(w, true)) {
				w.value += c;
				this.pos++;
			}
		}
	}

	// The expansion's source text stays in the value, so an inline `bash -c "cd $d && …"`
	// script can still be scanned; only `literal` records that the value is not exact.
	private expansion(w: Word, quoted: boolean): boolean {
		const s = this.src;
		const from = this.pos;
		const next = s[from + 1];
		if (s[from] === "`") {
			let j = from + 1;
			while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
			const inner = s.slice(from + 1, Math.min(j, s.length)).replace(/\\([`$\\])/g, "$1");
			this.pos = j + 1;
			new Lexer(inner, this.lists).list(false);
		} else if (s[from] !== "$" || next === undefined) {
			return false;
		} else if (next === "(") {
			this.pos += 2;
			this.list(true);
		} else if (next === "{") {
			const close = s.indexOf("}", from);
			this.pos = close < 0 ? s.length : close + 1;
		} else if (next === "'" && !quoted) {
			let j = from + 2;
			while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
			this.pos = j + 1;
		} else if (/[A-Za-z_]/.test(next)) {
			this.pos = from + 1 + (/^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(from + 1, from + 256))?.[0].length ?? 1);
		} else if (/[0-9@*#?$!-]/.test(next)) {
			this.pos += 2;
		} else {
			return false;
		}
		w.value += s.slice(from, Math.min(this.pos, s.length));
		w.literal = false;
		return true;
	}

	private heredocBodies(): void {
		const s = this.src;
		for (const redir of this.pending.splice(0)) {
			const lines: string[] = [];
			while (this.pos < s.length) {
				const nl = s.indexOf("\n", this.pos);
				const eol = nl < 0 ? s.length : nl;
				const line = s.slice(this.pos, eol);
				this.pos = Math.min(eol + 1, s.length);
				if ((redir.value === "<<-" ? line.replace(/^\t+/, "") : line) === redir.delim) break;
				lines.push(line);
			}
			redir.body = lines.join("\n");
			if (!redir.quoted) new Lexer(redir.body, this.lists).double(blankWord(), false);
		}
	}
}

function simpleCommands(tokens: Token[]): Simple[] {
	const out: Simple[] = [];
	let cmd: Simple = { words: [], redirs: [] };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.kind === "op") {
			if (cmd.words.length > 0 || cmd.redirs.length > 0) out.push(cmd);
			cmd = { words: [], redirs: [] };
		} else if (t.kind === "redir") {
			const next = tokens[i + 1];
			const target = next?.kind === "word" ? next : undefined;
			if (target) i++;
			cmd.redirs.push({ redir: t, target });
		} else {
			cmd.words.push(t);
		}
	}
	if (cmd.words.length > 0 || cmd.redirs.length > 0) out.push(cmd);
	return out;
}

function skipWrapper(words: Word[], i: number, wrapper: Wrapper): number {
	let positionals = wrapper.positionals ?? 0;
	let options = true;
	while (i < words.length) {
		const { value, raw } = words[i];
		if (options && value === "--") {
			options = false;
			i++;
		} else if (options && value.startsWith("-")) {
			if (wrapper.lookups?.includes(value)) return -1;
			i += wrapper.valued.includes(value) ? 2 : 1;
		} else if (wrapper.assignments && ASSIGNMENT.test(raw)) {
			i++;
		} else if (positionals > 0) {
			positionals--;
			i++;
		} else {
			break;
		}
	}
	return i;
}

function resolve(words: Word[]): { name: string; args: Word[] } | null {
	let i = 0;
	while (i >= 0 && i < words.length) {
		const w = words[i];
		if (ASSIGNMENT.test(w.raw) || RESERVED.has(w.raw)) {
			i++;
			continue;
		}
		const name = w.value.slice(w.value.lastIndexOf("/") + 1);
		const wrapper = WRAPPERS.get(name);
		if (!wrapper) return { name, args: words.slice(i + 1) };
		i = skipWrapper(words, i + 1, wrapper);
	}
	return null;
}

// A shell child runs its `-c` string, or its stdin when it has no script file; any
// other command only reads a heredoc as data, so `cat > run.sh <<EOF` is not a launch.
function innerScripts(name: string, args: Word[], redirs: Simple["redirs"]): string[] {
	if (name === "eval") return [args.map((w) => w.value).join(" ")];
	if (!SHELLS.has(name)) return [];
	let inline = false;
	let stdin = false;
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i].value;
		if (a === "--") {
			i++;
			break;
		}
		if (!/^[-+]/.test(a)) break;
		if (/^-[A-Za-z]*c/.test(a)) inline = true;
		if (/^-[A-Za-z]*s/.test(a)) stdin = true;
		if (/^[-+][oO]$|^--(rcfile|init-file)$/.test(a)) i++;
	}
	if (inline) return i < args.length ? [args[i].value] : [];
	if (i < args.length && !stdin) return [];
	return redirs.flatMap(({ redir, target }) => {
		if (redir.value === "<<<") return target ? [target.value] : [];
		return redir.body === undefined ? [] : [redir.body];
	});
}

function scan(src: string, depth: number, found: Args[]): void {
	const lists: Token[][] = [];
	new Lexer(src, lists).list(false);
	for (const tokens of lists) {
		for (const cmd of simpleCommands(tokens)) {
			const target = resolve(cmd.words);
			if (!target) continue;
			if (target.name === "pi") {
				found.push(target.args.map((w) => (w.literal ? w.value : null)));
			} else if (depth < MAX_DEPTH) {
				for (const script of innerScripts(target.name, target.args, cmd.redirs)) scan(script, depth + 1, found);
			}
		}
	}
}

function pyString(code: string, at: number): { value: string; end: number } | null {
	PY_STRING.lastIndex = at;
	const m = PY_STRING.exec(code);
	if (!m) return null;
	const raw = /r/i.test(m[0]);
	const quote = m[1];
	let j = at + m[0].length;
	let value = "";
	while (j < code.length && !code.startsWith(quote, j)) {
		if (code[j] === "\\" && j + 1 < code.length) {
			const n = code[j + 1];
			value += raw ? code[j] + n : (PY_ESCAPES.get(n) ?? code[j] + n);
			j += 2;
		} else {
			value += code[j];
			j++;
		}
	}
	return { value, end: j + quote.length };
}

// bg_do snippets are xonsh: bare lines are shell already, but the usual launch is a
// Python string handed to `bg.run`, which only becomes shell once it is unescaped.
function bgRunPayloads(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(BG_RUN)) {
		let at = m.index + m[0].length;
		let payload: string | null = null;
		for (let lit = pyString(code, at); lit; lit = pyString(code, at)) {
			payload = (payload ?? "") + lit.value;
			at = lit.end;
			while (at < code.length && /\s/.test(code[at])) at++;
		}
		if (payload !== null) out.push(payload);
	}
	return out;
}

export function piLaunches(text: string, kind: Kind): Args[] {
	const found: Args[] = [];
	if (!text.includes("pi")) return found;
	scan(text, 0, found);
	if (kind === "snippet") for (const payload of bgRunPayloads(text)) scan(payload, 1, found);
	return found;
}

export function isOneShot(args: Args): boolean {
	if (PI_SUBCOMMANDS.has(args[0] ?? "")) return false;
	let oneShot = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") break;
		if (a === null) continue;
		if (PI_EXITS_EARLY.has(a)) return false;
		if (a === "-p" || a === "--print") {
			oneShot = true;
		} else if (a === "--mode") {
			const mode = args[++i];
			if (mode === "json" || mode === "rpc") oneShot = true;
		} else if (PI_VALUED.has(a)) {
			i++;
		}
	}
	return oneShot;
}

function hasHatch(text: string): boolean {
	return [...text.matchAll(HATCH)].some((m) => m[1].trim().length >= 3);
}

export function check(text: string, kind: Kind): Verdict {
	if (!piLaunches(text, kind).some(isOneShot)) return "allow";
	return hasHatch(text) ? "hatch" : "block";
}
