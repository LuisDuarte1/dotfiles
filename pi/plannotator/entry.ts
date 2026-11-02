import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import plannotator from "./index.ts";

type Method = (...args: unknown[]) => unknown;

// Upstream registers plan mode, review, last and its agent tools from one factory with no
// switches, so filter its registrations rather than carry a patch against its 2.5k-line index.ts.
const COMMANDS = new Set(["plannotator-annotate", "plannotator-review"]);

function allowed(method: PropertyKey, args: unknown[]): boolean {
	switch (method) {
		case "registerCommand":
			return COMMANDS.has(args[0] as string);
		case "registerTool":
		case "registerFlag":
		case "registerShortcut":
			return false;
		case "on":
			return args[0] !== "resources_discover"; // only offers the bundled skill for the CLI we don't install
		default:
			return true;
	}
}

export default function plannotatorSubset(pi: ExtensionAPI) {
	process.env.PLANNOTATOR_UPDATE_CHECK ??= "0"; // no daily GitHub release ping: the flake pins the version
	process.env.PLANNOTATOR_JINA ??= "0"; // fetch annotated URLs directly instead of through r.jina.ai
	process.env.PLANNOTATOR_SHARE ??= "disabled"; // no share button uploading content to plannotator's paste service
	const filtered = new Proxy(pi, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => (allowed(prop, args) ? (value as Method).apply(target, args) : undefined);
		},
	});
	return plannotator(filtered);
}
