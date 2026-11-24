import { snippetScripts, splitCommands } from "./shell.ts";

export interface Push {
	cwd?: string;
	remote?: string;
	refspecs: string[];
	all: boolean;
	deletes: boolean;
	tags: boolean;
}

export interface Hit {
	label: string;
	command: string;
	push?: Push;
}

export const GIT_PUSH = "git push";
const MAX_DEPTH = 4;

interface Wrapper {
	values?: string[];
	positionals?: number;
	subcommands?: string[];
	needsSubcommand?: boolean;
}

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "done", "fi", "while", "until"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const WRAPPERS = new Map<string, Wrapper>(Object.entries({
	time: {},
	sudo: { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"] },
	doas: { values: ["-u", "-C"] },
	env: { values: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
	nohup: {},
	exec: { values: ["-a"] },
	command: {},
	builtin: {},
	nice: { values: ["-n", "--adjustment"] },
	ionice: { values: ["-c", "-n", "-p", "--class", "--classdata"] },
	setsid: {},
	stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
	timeout: { values: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
	xargs: { values: ["-I", "-n", "-P", "-d", "-L", "-s", "-a", "-E", "--replace", "--max-args", "--max-procs"] },
	chronic: {},
	unbuffer: {},
	npx: { values: ["-p", "--package"] },
	bunx: {},
	pnpm: { values: ["-C", "--dir", "-F", "--filter"], subcommands: ["exec", "dlx", "x"] },
	yarn: { values: ["--cwd"], subcommands: ["exec", "dlx"] },
	bun: { subcommands: ["x", "exec"], needsSubcommand: true },
	npm: { values: ["-w", "--workspace", "-p", "--package"], subcommands: ["exec", "x"], needsSubcommand: true },
}));

const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"];
const WRANGLER_VALUES = ["-c", "--config", "-e", "--env", "--cwd", "--env-file"];
const FORGE_VALUES = ["-R", "--repo"];
const API_VALUES = new Set([
	"-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template",
	"--hostname", "--cache", "-p", "--preview", "--placeholder", "--form", "-R", "--repo",
]);
const API_BODY = new Set(["-f", "-F", "--field", "--raw-field", "--input", "--form"]);
const CURL_BODY = /^(?:-[dFT]|--data|--form|--upload-file|--json)/;
const PUSH_VALUES = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
const isOption = (word: string) => word.startsWith("-") && word !== "-";
const toolName = (word: string) => word.slice(word.lastIndexOf("/") + 1).replace(/@.*$/, "");

function joinDir(base: string | undefined, dir: string | undefined): string | undefined {
	if (dir === undefined) return "~";
	if (dir.startsWith("/") || dir.startsWith("~") || base === undefined) return dir;
	return `${base}/${dir}`;
}

function skipOptions(words: string[], i: number, values: readonly string[] = []): number {
	while (i < words.length && isOption(words[i])) {
		const flag = words[i++];
		if (flag === "--") break;
		if (values.includes(flag)) i++;
	}
	return i;
}

function positionals(args: string[], values: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") return out.concat(args.slice(i + 1));
		if (!isOption(args[i])) out.push(args[i]);
		else if (values.includes(args[i])) i++;
	}
	return out;
}

// Wrappers only change how a command runs, so the command they carry is what gets classified;
// `command -v` and `npm run` only look a command up or run a script, so nothing is carried.
function commandWords(words: string[]): string[] | undefined {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (isAssignment(word) || KEYWORDS.has(word)) {
			i++;
			continue;
		}
		const wrapper = WRAPPERS.get(word.slice(word.lastIndexOf("/") + 1));
		if (!wrapper) break;
		if (word === "command" && /^-[vV]$/.test(words[i + 1] ?? "")) return undefined;
		let j = skipOptions(words, i + 1, wrapper.values);
		if (wrapper.subcommands?.includes(words[j])) j = skipOptions(words, j + 1);
		else if (wrapper.needsSubcommand) break;
		i = j + (wrapper.positionals ?? 0);
	}
	return i < words.length ? words.slice(i) : undefined;
}

function shellScript(name: string, words: string[], input: string | undefined): string | undefined {
	if (name === "eval") return words.slice(1).join(" ");
	if (!SHELLS.has(name)) return undefined;
	for (let i = 1; i < words.length && isOption(words[i]); i++) {
		if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[i])) return words[i + 1] ?? "";
		if (/^[-+][A-Za-z]*o$/.test(words[i])) i++;
	}
	return words.slice(1).some((w) => !isOption(w)) ? undefined : input;
}

interface Request {
	method: string;
	endpoints: string[];
}

const methodOf = (explicit: string, body: boolean) => (explicit || (body ? "POST" : "GET")).toUpperCase();

function apiRequest(args: string[]): Request {
	let method = "";
	let body = false;
	const endpoints: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const joined = /^(?:-X|--method=)(.+)$/.exec(arg);
		if (arg === "-X" || arg === "--method") method = args[++i] ?? "";
		else if (joined) method = joined[1];
		else if (!isOption(arg)) endpoints.push(arg);
		else {
			body ||= API_BODY.has(arg.replace(/^(--[^=]+)=.*$/, "$1"));
			if (API_VALUES.has(arg)) i++;
		}
	}
	return { method: methodOf(method, body), endpoints };
}

function curlRequest(args: string[]): Request {
	let method = "";
	for (let i = 0; i < args.length; i++) {
		const joined = /^(?:-X|--request=)(.+)$/.exec(args[i]);
		if (args[i] === "-X" || args[i] === "--request") method = args[++i] ?? "";
		else if (joined) method = joined[1];
	}
	const body = args.some((arg) => CURL_BODY.test(arg));
	return { method: methodOf(method, body), endpoints: args.filter((arg) => arg.includes("://")) };
}

function urlEndpoint(url: string): string | undefined {
	const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
	if (!m) return undefined;
	if (/(^|@)api\.github\.com(:\d+)?$/i.test(m[1])) return m[2];
	const api = /\/api\/v[34]\/(.*)$/.exec(m[2]);
	return api?.[1];
}

// Covers the REST calls behind `repo transfer`, `repo delete` and the two merge commands, which
// agents reach for when the CLI lacks a flag; GitLab project ids and encoded paths are one segment.
export function apiAction(endpoint: string, method: string): string | undefined {
	const path = endpoint.replace(/^\/+/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
	const repo = String.raw`(?:repos/[^/]+/[^/]+|projects/[^/]+)`;
	if (method !== "GET" && new RegExp(`^${repo}/transfer$`).test(path)) return "repository transfer";
	if (method === "DELETE" && new RegExp(`^${repo}$`).test(path)) return "repository delete";
	if (method === "PUT" && /^projects\/[^/]+\/merge_requests\/[^/]+\/merge$/.test(path)) return "glab mr merge";
	if (method === "PUT" && /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(path)) return "gh pr merge";
	return undefined;
}

export function parsePush(args: string[]): Push | undefined {
	const push: Push = { refspecs: [], all: false, deletes: false, tags: false };
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			rest.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const name = arg.replace(/=.*$/, "");
			if (name === "--dry-run") return undefined;
			if (name === "--all" || name === "--mirror" || name === "--branches") push.all = true;
			else if (name === "--delete") push.deletes = true;
			else if (name === "--tags") push.tags = true;
			else if (name === "--repo") push.remote = arg.includes("=") ? arg.slice(7) : args[++i];
			else if (PUSH_VALUES.has(arg)) i++;
		} else if (isOption(arg)) {
			for (let k = 1; k < arg.length; k++) {
				if (arg[k] === "n") return undefined;
				if (arg[k] === "d") push.deletes = true;
				if (arg[k] === "o") {
					if (k === arg.length - 1) i++;
					break;
				}
			}
		} else {
			rest.push(arg);
		}
	}
	push.remote ??= rest.shift();
	push.refspecs = rest;
	return push;
}

function classify(name: string, args: string[], cwd: string | undefined): Omit<Hit, "command"> | undefined {
	if (args.some((a) => a === "--help" || a === "-h" || a === "-help" || a === "--dry-run" || a.startsWith("--dry-run="))) {
		return undefined;
	}
	switch (name) {
		case "wrangler": {
			const [sub, next] = positionals(args, WRANGLER_VALUES);
			if (sub === "deploy" || sub === "rollback") return { label: `wrangler ${sub}` };
			if (sub === "versions" && next === "deploy") return { label: "wrangler versions deploy" };
			return undefined;
		}
		case "gh":
		case "glab": {
			const [group, verb] = positionals(args, FORGE_VALUES);
			if (group === "api") {
				const { method, endpoints } = apiRequest(args.slice(args.indexOf("api") + 1));
				const label = endpoints[0] === undefined ? undefined : apiAction(endpoints[0], method);
				return label ? { label } : undefined;
			}
			if (name === "gh" && group === "pr" && verb === "merge") return { label: "gh pr merge" };
			if (name === "glab" && group === "mr" && (verb === "merge" || verb === "accept")) return { label: "glab mr merge" };
			if (group === "repo" && (verb === "delete" || verb === "transfer")) return { label: `repository ${verb}` };
			return undefined;
		}
		case "terraform": {
			const [sub] = positionals(args, []);
			return sub === "apply" || sub === "destroy" ? { label: `terraform ${sub}` } : undefined;
		}
		case "curl": {
			const { method, endpoints } = curlRequest(args);
			for (const url of endpoints) {
				const endpoint = urlEndpoint(url);
				const label = endpoint === undefined ? undefined : apiAction(endpoint, method);
				if (label) return { label };
			}
			return undefined;
		}
		case "git": {
			let dir = cwd;
			let i = 0;
			while (i < args.length && isOption(args[i])) {
				if (args[i] === "-C") dir = joinDir(dir, args[i + 1]);
				i += GIT_VALUES.includes(args[i]) ? 2 : 1;
			}
			if (args[i] !== "push") return undefined;
			const push = parsePush(args.slice(i + 1));
			return push ? { label: GIT_PUSH, push: { ...push, cwd: dir } } : undefined;
		}
		default:
			return undefined;
	}
}

function scan(script: string, cwd: string | undefined, depth: number, hits: Hit[]): void {
	if (depth > MAX_DEPTH) return;
	let dir = cwd;
	for (const cmd of splitCommands(script)) {
		const words = commandWords(cmd.words);
		if (!words) continue;
		const name = toolName(words[0]);
		if (name === "cd" || name === "pushd") {
			dir = joinDir(dir, words.slice(1).find((w) => !isOption(w)));
			continue;
		}
		const inner = shellScript(name, words, cmd.input);
		if (inner !== undefined) {
			scan(inner, dir, depth + 1, hits);
			continue;
		}
		const hit = classify(name, words.slice(1), dir);
		if (hit) hits.push({ ...hit, command: cmd.text });
	}
}

export function findGuarded(text: string, tool: "bash" | "bg_do"): Hit[] {
	const hits: Hit[] = [];
	for (const script of tool === "bg_do" ? snippetScripts(text) : [text]) scan(script, undefined, 0, hits);
	return hits;
}
