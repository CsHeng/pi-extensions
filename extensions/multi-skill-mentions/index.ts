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
const SKILL_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
const NAME_CHARACTER_PATTERN = /[A-Za-z0-9_-]/;
const DOLLAR_MENTION_PATTERN = new RegExp(`\\$(${SKILL_NAME_PATTERN})`, "g");
const SELECTOR_PATTERN = new RegExp(`\\$(?<dollar>${SKILL_NAME_PATTERN})|/skill:(?<slash>${SKILL_NAME_PATTERN})`, "y");

type SkillCommand = SlashCommandInfo & {
	source: "skill";
	skillName: string;
};

type SelectorKind = "dollar" | "slash";

interface LeadingSelection {
	selected: SkillCommand[];
	kinds: SelectorKind[];
	end: number;
}

interface NormalizedSelection {
	selected: SkillCommand[];
	tail: string;
	leadingKinds: SelectorKind[];
}

interface ResolvedSkill {
	name: string;
	path: string;
	baseDir: string;
	body: string;
}

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

/**
 * Match one complete selection token at an exact position. The sticky pattern keeps the token
 * anchored so leading-prefix parsing never has to re-scan the rest of the prompt.
 */
function selectorAt(
	text: string,
	position: number,
	skillsByName: Map<string, SkillCommand>,
): { skill: SkillCommand; kind: SelectorKind; end: number } | undefined {
	SELECTOR_PATTERN.lastIndex = position;
	const match = SELECTOR_PATTERN.exec(text);
	if (!match || match.index !== position) return undefined;
	const kind: SelectorKind = match.groups?.dollar ? "dollar" : "slash";
	const name = match.groups?.dollar ?? match.groups?.slash;
	if (name === undefined) return undefined;
	const end = position + match[0].length;
	if (NAME_CHARACTER_PATTERN.test(text[end] ?? "")) return undefined;
	const skill = skillsByName.get(name);
	if (!skill) return undefined;
	return { skill, kind, end };
}

/** Consume a leading run of known `$name` / `/skill:name` selectors in either order. */
function readLeadingSelection(text: string, skillsByName: Map<string, SkillCommand>): LeadingSelection {
	const selected: SkillCommand[] = [];
	const kinds: SelectorKind[] = [];
	let end = 0;
	let cursor = /^\s*/.exec(text)?.[0].length ?? 0;
	for (;;) {
		const match = selectorAt(text, cursor, skillsByName);
		if (!match) break;
		selected.push(match.skill);
		kinds.push(match.kind);
		end = match.end;
		const separator = /^\s+/.exec(text.slice(end));
		if (!separator) break;
		cursor = end + separator[0].length;
	}
	if (selected.length === 0) return { selected, kinds, end: 0 };
	return { selected, kinds, end };
}

/** Collect known `$name` mentions from ordinary text, leaving that text untouched. */
function collectDollarMentions(text: string, skillsByName: Map<string, SkillCommand>, from = 0): SkillCommand[] {
	const mentioned: SkillCommand[] = [];
	for (const match of text.matchAll(DOLLAR_MENTION_PATTERN)) {
		const index = match.index;
		if (index < from) continue;
		const previousCharacter = index > 0 ? text[index - 1] : undefined;
		const nextIndex = index + match[0].length;
		const nextCharacter = text[nextIndex];

		if (previousCharacter === "\\" || previousCharacter === "$" || /[a-zA-Z0-9_]/.test(previousCharacter ?? "")) {
			continue;
		}
		if (NAME_CHARACTER_PATTERN.test(nextCharacter ?? "")) {
			continue;
		}

		const skillName = match[1];
		if (!skillName) continue;
		const skill = skillsByName.get(skillName);
		if (skill) mentioned.push(skill);
	}
	return mentioned;
}

/**
 * Normalize one prompt into the selected skills and the remaining user tail. A leading selection
 * prefix is consumed so the tail is clean; later dollar mentions still select skills without being
 * removed from the user's own text. Repeated selections keep their first encounter position.
 */
function normalizeSelections(text: string, skills: SkillCommand[]): NormalizedSelection {
	const skillsByName = new Map(skills.map((skill) => [skill.skillName, skill]));
	const leading = readLeadingSelection(text, skillsByName);
	const selected = new Map<string, SkillCommand>();
	const add = (skill: SkillCommand) => {
		if (!selected.has(skill.skillName)) selected.set(skill.skillName, skill);
	};

	for (const skill of leading.selected) add(skill);
	// Scan the original text so escape/identifier boundaries still see the surrounding characters.
	for (const skill of collectDollarMentions(text, skillsByName, leading.end)) add(skill);

	return {
		selected: [...selected.values()],
		tail: leading.end > 0 ? text.slice(leading.end).replace(/^\s+/, "") : text,
		leadingKinds: leading.kinds,
	};
}

/**
 * Pi's native expansion handles one leading `/skill:name` and its arguments. Multi or mixed
 * selections need this adapter, so keep the uncomplicated native path when nothing else is selected.
 */
function defersToNativeSelection(text: string, normalized: NormalizedSelection): boolean {
	return normalized.selected.length === 1
		&& normalized.leadingKinds.length === 1
		&& normalized.leadingKinds[0] === "slash"
		&& text.startsWith(`/${SKILL_COMMAND_PREFIX}`);
}

async function resolveSkill(skill: SkillCommand): Promise<ResolvedSkill> {
	const content = await readFile(skill.sourceInfo.path, "utf8");
	const { body } = parseFrontmatter<Record<string, unknown>>(content);
	return {
		name: skill.skillName,
		path: skill.sourceInfo.path,
		baseDir: skill.sourceInfo.baseDir ?? dirname(skill.sourceInfo.path),
		body: body.trim(),
	};
}

/**
 * One native-compatible envelope: Pi parses a single leading `<skill>` block and renders the
 * remaining text as the user message. The `name` and `location` fields are Pi's compatibility
 * anchors, so a grouped envelope keeps every selected name visible and uses a real selected source
 * for its single location while each section states its own path and reference base.
 */
function buildSkillEnvelope(resolved: ResolvedSkill[]): string {
	const names = resolved.map((skill) => skill.name).join(", ");
	const content = resolved.length === 1
		? `References are relative to ${resolved[0]!.baseDir}.\n\n${resolved[0]!.body}`
		: resolved
			.map((skill) => [
				`## Skill: ${skill.name}`,
				`Location: ${skill.path}`,
				`References are relative to ${skill.baseDir}.`,
				"",
				skill.body,
			].join("\n"))
			.join("\n\n");
	return `<skill name="${names}" location="${resolved[0]!.path}">\n${content}\n</skill>`;
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

		const normalized = normalizeSelections(event.text, getSkillCommands(pi));
		if (normalized.selected.length === 0 || defersToNativeSelection(event.text, normalized)) {
			return { action: "continue" };
		}

		let envelope: string;
		try {
			const resolved = await Promise.all(normalized.selected.map(resolveSkill));
			envelope = buildSkillEnvelope(resolved);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setEditorText(event.text);
			ctx.ui.notify(`Could not load selected skills: ${message}`, "error");
			return { action: "handled" };
		}

		return {
			action: "transform",
			text: normalized.tail ? `${envelope}\n\n${normalized.tail}` : envelope,
		};
	});

	pi.registerCommand("skill-mentions", {
		description: "Show how to explicitly select multiple skills in one prompt",
		handler: async (_args, ctx) => {
			const count = getSkillCommands(pi).length;
			ctx.ui.notify(
				`Type $ or /skill: to select skills. Select several in one prompt, for example: $alpha-skill /skill:beta-skill review this change. (${count} skills available)`,
				"info",
			);
		},
	});
}
