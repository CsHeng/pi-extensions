import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	parseFrontmatter,
	type ExtensionAPI,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

const SKILL_COMMAND_PREFIX = "skill:";
const MAX_SUGGESTIONS = 20;
const SKILL_MENTION_PATTERN = /\$([a-z0-9](?:[a-z0-9-]{0,63}))/g;

type SkillCommand = SlashCommandInfo & {
	source: "skill";
	skillName: string;
};

function getSkillCommands(pi: ExtensionAPI): SkillCommand[] {
	return pi
		.getCommands()
		.filter(
			(command): command is SlashCommandInfo & { source: "skill" } =>
				command.source === "skill" && command.name.startsWith(SKILL_COMMAND_PREFIX),
		)
		.map((command) => ({
			...command,
			skillName: command.name.slice(SKILL_COMMAND_PREFIX.length),
		}))
		.sort((left, right) => left.skillName.localeCompare(right.skillName));
}

function extractMentionQuery(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[^a-zA-Z0-9_$\\])\$([a-zA-Z0-9-]*)$/);
	return match?.[1];
}

function getMentionedSkills(text: string, skills: SkillCommand[]): SkillCommand[] {
	const skillsByName = new Map(skills.map((skill) => [skill.skillName, skill]));
	const selected = new Map<string, SkillCommand>();

	for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
		const index = match.index;
		const previousCharacter = index > 0 ? text[index - 1] : undefined;
		const nextIndex = index + match[0].length;
		const nextCharacter = text[nextIndex];

		if (previousCharacter === "\\" || previousCharacter === "$" || /[a-zA-Z0-9_]/.test(previousCharacter ?? "")) {
			continue;
		}
		if (/[a-zA-Z0-9_-]/.test(nextCharacter ?? "")) {
			continue;
		}

		const skillName = match[1];
		if (!skillName) continue;
		const skill = skillsByName.get(skillName);
		if (skill) selected.set(skill.skillName, skill);
	}

	return [...selected.values()];
}

function createSkillAutocompleteProvider(
	pi: ExtensionAPI,
	current: AutocompleteProvider,
): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const query = extractMentionQuery(currentLine.slice(0, cursorCol));
			if (query === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const skills = getSkillCommands(pi);
			const matches = query
				? fuzzyFilter(skills, query, (skill) => `${skill.skillName} ${skill.description ?? ""}`)
				: skills;

			if (options.signal.aborted || matches.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items: AutocompleteItem[] = matches.slice(0, MAX_SUGGESTIONS).map((skill) => ({
				value: `$${skill.skillName} `,
				label: `$${skill.skillName}`,
				...(skill.description === undefined ? {} : { description: skill.description }),
			}));

			return {
				prefix: `$${query}`,
				items,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

async function expandSkill(skill: SkillCommand): Promise<string> {
	const content = await readFile(skill.sourceInfo.path, "utf8");
	const { body } = parseFrontmatter<Record<string, unknown>>(content);
	const skillBody = body.trim();
	const skillDirectory = dirname(skill.sourceInfo.path);

	return `<skill name="${skill.skillName}" location="${skill.sourceInfo.path}">\nReferences are relative to ${skillDirectory}.\n\n${skillBody}\n</skill>`;
}

export default function multiSkillMentions(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(pi, current));
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const mentionedSkills = getMentionedSkills(event.text, getSkillCommands(pi));
		if (mentionedSkills.length === 0) {
			return { action: "continue" };
		}

		try {
			const skillBlocks = await Promise.all(mentionedSkills.map(expandSkill));
			return {
				action: "transform",
				text: `${skillBlocks.join("\n\n")}\n\n${event.text}`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setEditorText(event.text);
			ctx.ui.notify(`Could not load selected skills: ${message}`, "error");
			return { action: "handled" };
		}
	});

	pi.registerCommand("skill-mentions", {
		description: "Show how to explicitly select multiple skills in one prompt",
		handler: async (_args, ctx) => {
			const count = getSkillCommands(pi).length;
			ctx.ui.notify(
				`Type $ to select skills. Add several mentions in one prompt, for example: $python-guidelines $testing-strategy review this change. (${count} skills available)`,
				"info",
			);
		},
	});
}
