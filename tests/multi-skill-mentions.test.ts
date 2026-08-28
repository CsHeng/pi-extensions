import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import multiSkillMentions from "../extensions/multi-skill-mentions/index.ts";

interface FakeCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface AutocompleteResult {
	prefix: string;
	items: Array<{ value: string; label: string; description?: string }>;
}

interface AutocompleteProvider {
	getSuggestions: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal },
	) => Promise<AutocompleteResult | null> | AutocompleteResult | null;
	applyCompletion: (...args: unknown[]) => unknown;
	shouldTriggerFileCompletion?: (...args: unknown[]) => boolean;
}

class FakePi {
	readonly commands = new Map<string, FakeCommand>();
	readonly handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	skillCommands: SlashCommandInfo[] = [];

	getCommands(): SlashCommandInfo[] {
		return [...this.skillCommands];
	}

	on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown): void {
		this.handlers.set(name, handler);
	}

	registerCommand(name: string, command: FakeCommand): void {
		this.commands.set(name, command);
	}
}

function context(options: {
	mode?: "tui" | "rpc";
	onAutocompleteProvider?: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
	notifications?: string[];
	editorText?: string[];
} = {}): ExtensionContext {
	return {
		cwd: "/workspace",
		hasUI: true,
		mode: options.mode ?? "rpc",
		ui: {
			addAutocompleteProvider: options.onAutocompleteProvider,
			notify: (message: string) => options.notifications?.push(message),
			setEditorText: (text: string) => options.editorText?.push(text),
		},
	} as unknown as ExtensionContext;
}

async function invoke(pi: FakePi, eventName: string, event: unknown, ctx: ExtensionContext): Promise<unknown> {
	const handler = pi.handlers.get(eventName);
	if (!handler) throw new Error(`missing handler ${eventName}`);
	return handler(event, ctx);
}

async function createSkill(root: string, name: string, description: string, body: string): Promise<SlashCommandInfo> {
	const path = join(root, `${name}.md`);
	await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
	return {
		name: `skill:${name}`,
		description,
		source: "skill",
		sourceInfo: {
			path,
			source: path,
			scope: "user",
			origin: "top-level",
		},
	};
}

test("input expands multiple loaded skill mentions once and preserves the prompt", async (t) => {
	const skillRoot = await mkdtemp(join(tmpdir(), "multi-skill-mentions-"));
	t.after(async () => rm(skillRoot, { recursive: true, force: true }));
	const pi = new FakePi();
	pi.skillCommands = [
		await createSkill(skillRoot, "alpha-skill", "Alpha guidance", "Alpha body"),
		await createSkill(skillRoot, "beta-skill", "Beta guidance", "Beta body"),
	];
	multiSkillMentions(pi as unknown as ExtensionAPI);
	const prompt = "$alpha-skill $beta-skill $alpha-skill inspect $HOME and \\$beta-skill";

	const result = await invoke(
		pi,
		"input",
		{ source: "interactive", text: prompt },
		context(),
	) as { action: string; text: string };

	assert.equal(result.action, "transform");
	assert.equal(result.text.match(/<skill name="alpha-skill"/g)?.length, 1);
	assert.equal(result.text.match(/<skill name="beta-skill"/g)?.length, 1);
	assert.match(result.text, /Alpha body/);
	assert.match(result.text, /Beta body/);
	assert.ok(result.text.endsWith(prompt));
});

test("input delegates when no loaded skill is mentioned or the source is an extension", async () => {
	const pi = new FakePi();
	multiSkillMentions(pi as unknown as ExtensionAPI);
	const ctx = context();

	assert.deepEqual(
		await invoke(pi, "input", { source: "interactive", text: "$HOME stays literal" }, ctx),
		{ action: "continue" },
	);
	assert.deepEqual(
		await invoke(pi, "input", { source: "extension", text: "$anything" }, ctx),
		{ action: "continue" },
	);
});

test("input handles a selected skill read failure without submitting a partial prompt", async () => {
	const pi = new FakePi();
	pi.skillCommands = [{
		name: "skill:missing-skill",
		description: "Missing skill",
		source: "skill",
		sourceInfo: {
			path: "/missing/skill/SKILL.md",
			source: "/missing/skill/SKILL.md",
			scope: "user",
			origin: "top-level",
		},
	}];
	const notifications: string[] = [];
	const editorText: string[] = [];
	multiSkillMentions(pi as unknown as ExtensionAPI);

	const result = await invoke(
		pi,
		"input",
		{ source: "interactive", text: "$missing-skill inspect" },
		context({ notifications, editorText }),
	);

	assert.deepEqual(result, { action: "handled" });
	assert.deepEqual(editorText, ["$missing-skill inspect"]);
	assert.match(notifications.at(-1) ?? "", /Could not load selected skills/);
});

test("TUI autocomplete offers fuzzy skill mentions and delegates unrelated input", async (t) => {
	const skillRoot = await mkdtemp(join(tmpdir(), "multi-skill-autocomplete-"));
	t.after(async () => rm(skillRoot, { recursive: true, force: true }));
	const pi = new FakePi();
	pi.skillCommands = [await createSkill(skillRoot, "alpha-skill", "Alpha guidance", "Alpha body")];
	let factory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	multiSkillMentions(pi as unknown as ExtensionAPI);
	await invoke(pi, "session_start", { reason: "startup" }, context({
		mode: "tui",
		onAutocompleteProvider: (value) => { factory = value; },
	}));
	assert.ok(factory);
	const delegated = { prefix: "delegate", items: [] };
	const current: AutocompleteProvider = {
		getSuggestions: () => delegated,
		applyCompletion: () => undefined,
		shouldTriggerFileCompletion: () => true,
	};
	const provider = factory(current);

	assert.deepEqual(
		await provider.getSuggestions(["Use $alp"], 0, 8, { signal: new AbortController().signal }),
		{
			prefix: "$alp",
			items: [{ value: "$alpha-skill ", label: "$alpha-skill", description: "Alpha guidance" }],
		},
	);
	assert.equal(
		await provider.getSuggestions(["plain text"], 0, 10, { signal: new AbortController().signal }),
		delegated,
	);
});

test("help command reports the number of available skills", async (t) => {
	const skillRoot = await mkdtemp(join(tmpdir(), "multi-skill-help-"));
	t.after(async () => rm(skillRoot, { recursive: true, force: true }));
	const pi = new FakePi();
	pi.skillCommands = [await createSkill(skillRoot, "alpha-skill", "Alpha guidance", "Alpha body")];
	const notifications: string[] = [];
	multiSkillMentions(pi as unknown as ExtensionAPI);

	await pi.commands.get("skill-mentions")?.handler("", context({ notifications }));

	assert.match(notifications.at(-1) ?? "", /\(1 skills available\)/);
});
