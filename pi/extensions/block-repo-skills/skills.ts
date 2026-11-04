import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

// Pi tags every repo skill (.pi/skills, .agents/skills, also in ancestor dirs)
// with the "project" scope, whichever directory it was discovered in.
export function isRepoSkill(skill: Skill): boolean {
	return skill.sourceInfo?.scope === "project";
}

export function isRepoSkillCommand(command: SlashCommandInfo): boolean {
	return command.source === "skill" && command.sourceInfo?.scope === "project";
}

// Pi renders the prompt from these options, so filtering them never depends on
// the prompt text, whose format changed in pi 1.x and silently broke matching.
export function dropRepoSkills(options: { skills: Skill[] }): Skill[] {
	const removed = options.skills.filter(isRepoSkill);
	if (removed.length > 0) {
		options.skills = options.skills.filter((skill) => !isRepoSkill(skill));
	}
	return removed;
}

// A prompt forced by another handler ignores the options above, so check the
// rendered text itself instead of trusting the filter worked.
export function leakedSkills(systemPrompt: string, removed: Skill[]): Skill[] {
	return removed.filter((skill) => systemPrompt.includes(skill.filePath));
}
