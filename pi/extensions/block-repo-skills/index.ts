// Trust is all-or-nothing in pi, so this keeps a trusted repo's AGENTS.md and
// extensions while hiding its skills from the model and from /skill: commands.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dropRepoSkills, isRepoSkillCommand, leakedSkills } from "./skills.ts";

const FLAG = "allow-repo-skills";
const STATUS_KEY = "block-repo-skills";

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY, text);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG, {
		description: "Allow repo-provided skills (.pi/skills, .agents/skills) for this run",
		type: "boolean",
		default: false,
	});

	const allowed = (): boolean => pi.getFlag(FLAG) === true;
	let reportedLeak = "";

	pi.on("session_start", async (_event, ctx) => {
		reportedLeak = "";
		const count = pi.getCommands().filter(isRepoSkillCommand).length;
		if (count === 0) {
			setStatus(ctx, undefined);
			return;
		}
		setStatus(ctx, allowed() ? `repo skills: ${count} allowed` : `repo skills blocked: ${count}`);
		if (!ctx.hasUI) {
			return;
		}
		if (allowed()) {
			ctx.ui.notify(`block-repo-skills: ${count} repo skill(s) allowed via --${FLAG}.`, "info");
		} else {
			ctx.ui.notify(`block-repo-skills: hiding ${count} repo skill(s) from the model. Use --${FLAG} to enable.`, "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (allowed()) {
			return;
		}

		const removed = dropRepoSkills(event.systemPromptOptions);
		const leaked = leakedSkills(event.systemPrompt, removed);
		if (leaked.length === 0) {
			setStatus(ctx, removed.length > 0 ? `repo skills blocked: ${removed.length}` : undefined);
			return;
		}

		setStatus(ctx, `repo skills LEAKED: ${leaked.length}`);
		const names = leaked.map((skill) => skill.name).join(", ");
		if (ctx.hasUI && names !== reportedLeak) {
			reportedLeak = names;
			ctx.ui.notify(`block-repo-skills: ${names} still in the system prompt; another extension may force it.`, "error");
		}
	});

	pi.on("input", async (event, ctx) => {
		if (allowed() || event.source === "extension") {
			return;
		}

		const text = event.text.trimStart();
		if (!text.startsWith("/skill:")) {
			return;
		}

		const token = text.slice(1).split(/\s+/, 1)[0];
		const blocked = pi
			.getCommands()
			.some((command) => command.name === token && isRepoSkillCommand(command));
		if (!blocked) {
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Blocked /${token}: repo skills are disabled by block-repo-skills.`, "warning");
		}
		return { action: "handled" };
	});
}
