import assert from "node:assert/strict";
import test from "node:test";
import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { dropRepoSkills, isRepoSkillCommand, leakedSkills } from "./skills.ts";

function skill(name: string, scope: "user" | "project"): Skill {
	return {
		name,
		description: `${name} skill`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "local", scope, origin: "top-level" },
		disableModelInvocation: false,
	} as Skill;
}

test("dropRepoSkills removes only project skills from the prompt options", () => {
	const options = { skills: [skill("mine", "user"), skill("repo-a", "project"), skill("other", "user"), skill("repo-b", "project")] };

	const removed = dropRepoSkills(options);

	assert.deepEqual(removed.map((s) => s.name), ["repo-a", "repo-b"]);
	assert.deepEqual(options.skills.map((s) => s.name), ["mine", "other"]);
});

test("dropRepoSkills leaves options alone when there are no repo skills", () => {
	const skills = [skill("mine", "user")];
	const options = { skills };

	assert.deepEqual(dropRepoSkills(options), []);
	assert.equal(options.skills, skills);
});

test("leakedSkills reports removed skills that are still in the rendered prompt", () => {
	const removed = [skill("repo-a", "project"), skill("repo-b", "project")];
	const forced = "<skills>\n  <location>/skills/repo-a/SKILL.md</location>\n</skills>";

	assert.deepEqual(leakedSkills(forced, removed).map((s) => s.name), ["repo-a"]);
	assert.deepEqual(leakedSkills("<skills>\n</skills>", removed), []);
});

test("isRepoSkillCommand matches only project skill commands", () => {
	const command = (source: string, scope: string) => ({ name: "skill:x", source, sourceInfo: { scope } }) as SlashCommandInfo;

	assert.equal(isRepoSkillCommand(command("skill", "project")), true);
	assert.equal(isRepoSkillCommand(command("skill", "user")), false);
	assert.equal(isRepoSkillCommand(command("extension", "project")), false);
});
