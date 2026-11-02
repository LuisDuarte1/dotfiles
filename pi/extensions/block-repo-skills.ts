// Block project/repo-provided skills while keeping project trust (AGENTS.md,
// CLAUDE.md, project extensions) fully functional.

// Pi 0.79.0 loads skills from a trusted repo (.pi/skills, .agents/skills in cwd
// and ancestors). Trust is all-or-nothing, so we strip repo skills post-load.

import type {
	ExtensionAPI,
	ExtensionContext,
	Skill,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const FLAG = "allow-repo-skills";
const STATUS_KEY = "block-repo-skills";

// Repo skills (both .pi/skills and .agents/skills, including ancestor dirs) are
// always tagged with sourceInfo.scope === "project" by pi's resource loader.
export function isRepoSkill(skill: Skill): boolean {
	return skill.sourceInfo?.scope === "project";
}

// Returns true when the slash command is a repo-scoped skill command, e.g. the
// `skill:foo` invocation token registered for a project skill.
export function isRepoSkillCommand(command: SlashCommandInfo): boolean {
	return command.source === "skill" && command.sourceInfo?.scope === "project";
}

export interface StripResult {
	systemPrompt: string;
	removed: Skill[];
}

// Rebuild the skills block without repo skills by replacing the exact block pi
// emitted (formatSkillsForPrompt over all skills) with the filtered block.
export function stripRepoSkills(systemPrompt: string, skills: Skill[]): StripResult {
	const removed = skills.filter(isRepoSkill);
	if (removed.length === 0) {
		return { systemPrompt, removed };
	}

	const fullBlock = formatSkillsForPrompt(skills);
	if (fullBlock.length === 0 || !systemPrompt.includes(fullBlock)) {
		return { systemPrompt, removed };
	}

	const kept = skills.filter((skill) => !isRepoSkill(skill));
	const keptBlock = formatSkillsForPrompt(kept);
	// split/join avoids `$` being interpreted as a replacement pattern when a
	// skill description contains `$`.
	return { systemPrompt: systemPrompt.split(fullBlock).join(keptBlock), removed };
}

// Count repo (project-scoped) skill commands. getCommands() is fully populated
// by session_start, so this is reliable for the startup notice.
function countRepoSkills(pi: ExtensionAPI): number {
	return pi.getCommands().filter(isRepoSkillCommand).length;
}

// Keep the footer indicator in sync with the current policy. Shows the count
// of repo skills and whether they are blocked or allowed.
function updateStatus(ctx: ExtensionContext, count: number, allowed: boolean): void {
	if (!ctx.hasUI) {
		return;
	}
	if (count === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} else if (allowed) {
		ctx.ui.setStatus(STATUS_KEY, `repo skills: ${count} allowed`);
	} else {
		ctx.ui.setStatus(STATUS_KEY, `repo skills blocked: ${count}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG, {
		description: "Allow repo-provided skills (.pi/skills, .agents/skills) for this run",
		type: "boolean",
		default: false,
	});

	const allowed = (): boolean => pi.getFlag(FLAG) === true;

	pi.on("session_start", async (_event, ctx) => {
		const count = countRepoSkills(pi);
		updateStatus(ctx, count, allowed());
		if (count === 0 || !ctx.hasUI) {
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

		const skills = event.systemPromptOptions.skills ?? [];
		const { systemPrompt, removed } = stripRepoSkills(event.systemPrompt, skills);

		// Keep the footer count authoritative on every turn from the actual loaded
		// skills (also covers /reload, which re-discovers resources).
		updateStatus(ctx, removed.length, false);
		if (removed.length === 0 || systemPrompt === event.systemPrompt) {
			return;
		}
		return { systemPrompt };
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
