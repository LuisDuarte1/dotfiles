export interface SimpleCommand {
	words: string[];
	text: string;
	input?: string;
}

interface Heredoc {
	delim: string;
	strip: boolean;
	target: SimpleCommand;
}

type Pending = "redirect" | "heredoc" | "heredoc-strip" | "herestring";

// Splits bash into simple commands with quotes removed and redirection targets dropped, so a
// caller can tell a word that runs from one that is only an argument. It never rejects input.
export function splitCommands(src: string): SimpleCommand[] {
	const out: SimpleCommand[] = [];
	const heredocs: Heredoc[] = [];
	let i = 0;

	const matching = (open: string, close: string, from: number): number => {
		let depth = 0;
		for (let j = from; j < src.length; j++) {
			if (src[j] === open) depth++;
			else if (src[j] === close && --depth === 0) return j;
		}
		return src.length;
	};

	const nested = (stop: string): string => {
		const from = i;
		list(stop);
		return src.slice(from, i);
	};

	const dollar = (): string => {
		const next = src[i + 1];
		if (next === "(" && src[i + 2] === "(") {
			const end = matching("(", ")", i + 1);
			const text = src.slice(i, end + 1);
			i = end + 1;
			return text;
		}
		if (next === "(") {
			i += 2;
			return `$(${nested(")")}`;
		}
		if (next === "{") {
			const end = matching("{", "}", i + 1);
			const text = src.slice(i, end + 1);
			i = end + 1;
			return text;
		}
		if (next === "'") {
			let j = i + 2;
			while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
			const text = src.slice(i + 2, j);
			i = j + 1;
			return text;
		}
		if (next === '"') {
			i += 2;
			return double();
		}
		i++;
		return "$";
	};

	const double = (): string => {
		let text = "";
		while (i < src.length && src[i] !== '"') {
			const c = src[i];
			if (c === "\\" && i + 1 < src.length) {
				const n = src[i + 1];
				if (n !== "\n") text += '$`"\\'.includes(n) ? n : c + n;
				i += 2;
			} else if (c === "`") {
				i++;
				text += `\`${nested("`")}`;
			} else if (c === "$") {
				text += dollar();
			} else {
				text += c;
				i++;
			}
		}
		i++;
		return text;
	};

	const readHeredocs = (): void => {
		for (const doc of heredocs.splice(0)) {
			const lines: string[] = [];
			while (i < src.length) {
				const nl = src.indexOf("\n", i);
				const end = nl < 0 ? src.length : nl;
				const line = src.slice(i, end);
				i = Math.min(end + 1, src.length);
				if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
				lines.push(line);
			}
			doc.target.input = lines.join("\n");
		}
	};

	function list(stop: string | undefined): void {
		let cmd: SimpleCommand = { words: [], text: "" };
		let start = -1;
		let word: string | undefined;
		let pending: Pending | undefined;

		const endWord = (): void => {
			if (word === undefined) return;
			if (pending === "heredoc" || pending === "heredoc-strip") {
				heredocs.push({ delim: word, strip: pending === "heredoc-strip", target: cmd });
			} else if (pending === "herestring") {
				cmd.input = word;
			} else if (pending !== "redirect") {
				cmd.words.push(word);
			}
			pending = undefined;
			word = undefined;
		};
		const endCommand = (): void => {
			endWord();
			if (cmd.words.length > 0) {
				cmd.text = src.slice(start, i).trim();
				out.push(cmd);
			}
			cmd = { words: [], text: "" };
			start = -1;
			pending = undefined;
		};
		const begin = (): string => {
			if (start < 0) start = i;
			word ??= "";
			return word;
		};

		while (i < src.length) {
			const c = src[i];
			if (c === stop) {
				endCommand();
				i++;
				return;
			}
			if (c === " " || c === "\t") {
				endWord();
				i++;
			} else if (c === "\n") {
				endCommand();
				i++;
				readHeredocs();
			} else if (c === "\\") {
				if (src[i + 1] !== "\n") word = begin() + (src[i + 1] ?? "");
				i += 2;
			} else if (c === "'") {
				const end = src.indexOf("'", i + 1);
				const close = end < 0 ? src.length : end;
				word = begin() + src.slice(i + 1, close);
				i = close + 1;
			} else if (c === '"') {
				const prefix = begin();
				i++;
				word = prefix + double();
			} else if (c === "`") {
				const prefix = begin();
				i++;
				word = `${prefix}\`${nested("`")}`;
			} else if (c === "$") {
				word = begin() + dollar();
			} else if (c === "#" && word === undefined) {
				const nl = src.indexOf("\n", i);
				i = nl < 0 ? src.length : nl;
			} else if ((c === "<" || c === ">") && src[i + 1] === "(") {
				const prefix = begin();
				i += 2;
				word = `${prefix}${c}(${nested(")")}`;
			} else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
				if (word !== undefined && /^\d+$/.test(word)) word = undefined;
				endWord();
				if (start < 0) start = i;
				if (src.startsWith("<<<", i)) {
					pending = "herestring";
					i += 3;
				} else if (src.startsWith("<<-", i)) {
					pending = "heredoc-strip";
					i += 3;
				} else if (src.startsWith("<<", i)) {
					pending = "heredoc";
					i += 2;
				} else {
					pending = "redirect";
					i++;
					while (i < src.length && ">&|".includes(src[i])) i++;
				}
			} else if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
				endCommand();
				const pair = src[i + 1] === c || (c === "|" && src[i + 1] === "&");
				i += pair && c !== "(" && c !== ")" ? 2 : 1;
			} else {
				word = begin() + c;
				i++;
			}
		}
		endCommand();
	}

	list(undefined);
	return out;
}

const PY_KEYWORDS = new Set([
	"if", "elif", "else", "for", "while", "def", "class", "return", "import", "from", "with", "try", "except",
	"finally", "raise", "assert", "del", "pass", "break", "continue", "global", "nonlocal", "lambda", "yield",
	"async", "await", "not",
]);

// xonsh runs a line as a command when it does not parse as Python; a first word followed by a
// space and anything but an operator is the shape that never parses, so it decides the mode.
function isSubprocessLine(line: string): boolean {
	const m = /^([A-Za-z_./~][\w./~+-]*)([\s\S]*)$/.exec(line);
	if (!m || PY_KEYWORDS.has(m[1])) return false;
	const rest = m[2];
	if (rest.trim() === "") return true;
	if (!/^\s/.test(rest)) return false;
	return !/^\s*(?:[-+*/%&|^@]?=(?!=)|==|!=|:|\b(?:in|is|and|or|if)\b)/.test(rest);
}

function lineEnd(code: string, from: number): number {
	let nl = code.indexOf("\n", from);
	while (nl > 0 && code[nl - 1] === "\\") nl = code.indexOf("\n", nl + 1);
	return nl < 0 ? code.length : nl;
}

function unescapePython(text: string): string {
	const map: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"', "\n": "" };
	return text.replace(/\\([\s\S])/g, (all, c: string) => map[c] ?? all);
}

function pythonString(code: string, at: number): { value: string; end: number } {
	let p = at;
	while (p > 0 && at - p < 2 && /[rRbBuUfF]/.test(code[p - 1])) p--;
	const raw = !(p > 0 && /\w/.test(code[p - 1])) && /r/i.test(code.slice(p, at));
	const quote = code[at];
	const triple = code.startsWith(quote.repeat(3), at);
	const close = triple ? quote.repeat(3) : quote;
	let j = at + close.length;
	while (j < code.length && !code.startsWith(close, j) && (triple || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
	const body = code.slice(at + close.length, Math.min(j, code.length));
	const end = code.startsWith(close, j) ? j + close.length : j;
	return { value: raw ? body : unescapePython(body), end };
}

// A bg_do snippet runs commands from three places: bare subprocess lines, `$(…)`-style captures,
// and string literals handed to Python calls such as bg.run(); print() is the Python echo.
export function snippetScripts(code: string): string[] {
	const scripts: string[] = [];
	const calls: string[] = [];
	let i = 0;
	let lineStart = true;
	while (i < code.length) {
		if (lineStart) {
			lineStart = false;
			while (code[i] === " " || code[i] === "\t") i++;
			const end = lineEnd(code, i);
			if (calls.length === 0 && isSubprocessLine(code.slice(i, end))) {
				scripts.push(code.slice(i, end));
				i = end;
				continue;
			}
		}
		const c = code[i];
		if (c === "\n") {
			lineStart = true;
			i++;
		} else if (c === "#") {
			const nl = code.indexOf("\n", i);
			i = nl < 0 ? code.length : nl;
		} else if (c === "'" || c === '"') {
			const str = pythonString(code, i);
			if (calls.at(-1) !== "print") scripts.push(str.value);
			i = str.end;
		} else if ((c === "$" || c === "!") && (code[i + 1] === "(" || code[i + 1] === "[")) {
			const open = code[i + 1];
			const close = open === "(" ? ")" : "]";
			let depth = 0;
			let j = i + 1;
			for (; j < code.length; j++) {
				if (code[j] === "'" || code[j] === '"') {
					const q = code.indexOf(code[j], j + 1);
					j = q < 0 ? code.length : q;
				} else if (code[j] === open) depth++;
				else if (code[j] === close && --depth === 0) break;
			}
			scripts.push(code.slice(i + 2, j));
			i = j + 1;
		} else if (c === "(" || c === "[" || c === "{") {
			calls.push(c === "(" ? (/(\w+)\s*$/.exec(code.slice(Math.max(0, i - 64), i))?.[1] ?? "") : "");
			i++;
		} else if (c === ")" || c === "]" || c === "}") {
			calls.pop();
			i++;
		} else {
			i++;
		}
	}
	return scripts;
}
