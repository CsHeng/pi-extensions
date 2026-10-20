import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSkillBlock, type ExtensionAPI, type ExtensionContext, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";

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
	const directory = join(root, name);
	const path = join(directory, "SKILL.md");
	await mkdir(directory, { recursive: true });
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
			baseDir: directory,
		},
	};
}

async function skillFixture(t: test.TestContext): Promise<{ root: string; pi: FakePi }> {
	const root = await mkdtemp(join(tmpdir(), "multi-skill-mentions-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const pi = new FakePi();
	pi.skillCommands = [
		await createSkill(root, "alpha-skill", "Alpha guidance", "Alpha body"),
		await createSkill(root, "beta-skill", "Beta guidance", "Beta body"),
	];
	multiSkillMentions(pi as unknown as ExtensionAPI);
	return { root, pi };
}

function countBlocks(text: string): number {
	return text.match(/^<skill name=/gm)?.length ?? 0;
}

function bodyCount(text: string, body: string): number {
	return text.split(body).length - 1;
}

test("leading dollar prefix expands once per skill with a clean user tail", async (t) => {
	const { root, pi } = await skillFixture(t);
	const result = await invoke(
		pi,
		"input",
		{ source: "interactive", text: "$alpha-skill $beta-skill inspect the change" },
		context(),
	) as { action: string; text: string; images?: unknown };

	assert.equal(result.action, "transform");
	assert.equal("images" in result, false);
	assert.equal(countBlocks(result.text), 1);
	assert.match(result.text, /^<skill name="alpha-skill, beta-skill" location="[^"]+">\n/);
	assert.ok(result.text.endsWith("\n\ninspect the change"));
	assert.equal(bodyCount(result.text, "Alpha body"), 1);
	assert.equal(bodyCount(result.text, "Beta body"), 1);
	assert.match(result.text, new RegExp(`## Skill: alpha-skill\\nLocation: ${join(root, "alpha-skill", "SKILL.md")}\\nReferences are relative to ${join(root, "alpha-skill")}\\.`));
	assert.match(result.text, new RegExp(`## Skill: beta-skill\\nLocation: ${join(root, "beta-skill", "SKILL.md")}\\nReferences are relative to ${join(root, "beta-skill")}\\.`));
	assert.equal(result.text.includes("$alpha-skill"), false, "consumed selectors must not remain in the user tail");

	// Pi's native parser must accept the grouped envelope and split off only the user tail.
	const parsed = parseSkillBlock(result.text);
	assert.ok(parsed);
	assert.equal(parsed.name, "alpha-skill, beta-skill");
	assert.equal(parsed.location, join(root, "alpha-skill", "SKILL.md"));
	assert.equal(parsed.userMessage, "inspect the change");
	assert.equal(bodyCount(parsed.content, "Alpha body"), 1);
	assert.equal(bodyCount(parsed.content, "Beta body"), 1);
});

test("leading slash and mixed selections group in encounter order regardless of token kind", async (t) => {
	const { root, pi } = await skillFixture(t);
	const cases = [
		"/skill:alpha-skill /skill:beta-skill inspect",
		"/skill:alpha-skill $beta-skill inspect",
		"$alpha-skill /skill:beta-skill inspect",
		"$beta-skill /skill:alpha-skill inspect",
	];
	for (const prompt of cases) {
		const result = await invoke(pi, "input", { source: "interactive", text: prompt }, context()) as { action: string; text: string };
		assert.equal(result.action, "transform", prompt);
		assert.equal(countBlocks(result.text), 1, prompt);
		const first = prompt.startsWith("$beta-skill") ? "beta-skill" : "alpha-skill";
		const second = first === "alpha-skill" ? "beta-skill" : "alpha-skill";
		assert.match(result.text, new RegExp(`^<skill name="${first}, ${second}" location="${join(root, first, "SKILL.md")}">`), prompt);
		assert.ok(result.text.endsWith("\n\ninspect"), prompt);
		assert.equal(bodyCount(result.text, "Alpha body"), 1, prompt);
		assert.equal(bodyCount(result.text, "Beta body"), 1, prompt);
	}
});

test("repeated selections deduplicate in encounter order without duplicating bodies", async (t) => {
	const { pi } = await skillFixture(t);
	const result = await invoke(
		pi,
		"input",
		{ source: "interactive", text: "/skill:beta-skill $alpha-skill /skill:beta-skill $alpha-skill later" },
		context(),
	) as { action: string; text: string };

	assert.equal(result.action, "transform");
	assert.equal(countBlocks(result.text), 1);
	assert.match(result.text, /^<skill name="beta-skill, alpha-skill"/);
	assert.equal(bodyCount(result.text, "Alpha body"), 1);
	assert.equal(bodyCount(result.text, "Beta body"), 1);
	assert.ok(result.text.endsWith("\n\nlater"));
});

test("a single leading slash selection keeps the native expansion path", async (t) => {
	const { pi } = await skillFixture(t);
	assert.deepEqual(
		await invoke(pi, "input", { source: "interactive", text: "/skill:alpha-skill inspect the change" }, context()),
		{ action: "continue" },
	);
});

test("a single dollar selection uses the native single-envelope shape", async (t) => {
	const { root, pi } = await skillFixture(t);
	const result = await invoke(pi, "input", { source: "interactive", text: "$alpha-skill inspect" }, context()) as { action: string; text: string };
	const path = join(root, "alpha-skill", "SKILL.md");
	const base = join(root, "alpha-skill");

	assert.equal(result.action, "transform");
	assert.equal(
		result.text,
		`<skill name="alpha-skill" location="${path}">\nReferences are relative to ${base}.\n\nAlpha body\n</skill>\n\ninspect`,
	);
});

test("dollar mentions outside the leading prefix still select skills and keep their text", async (t) => {
	const { pi } = await skillFixture(t);
	const result = await invoke(
		pi,
		"input",
		{ source: "interactive", text: "inspect $alpha-skill and compare with $beta-skill" },
		context(),
	) as { action: string; text: string };

	assert.equal(result.action, "transform");
	assert.equal(countBlocks(result.text), 1);
	assert.match(result.text, /^<skill name="alpha-skill, beta-skill"/);
	assert.ok(result.text.endsWith("\n\ninspect $alpha-skill and compare with $beta-skill"));
	assert.equal(bodyCount(result.text, "Alpha body"), 1);
	assert.equal(bodyCount(result.text, "Beta body"), 1);
});

test("ordinary user prose keeps leading whitespace when later dollar mentions select skills", async t => {
	const { pi } = await skillFixture(t);
	const prompt = "  inspect $alpha-skill and compare with $beta-skill\n";
	const result = await invoke(pi, "input", { source: "interactive", text: prompt }, context()) as { action: string; text: string };
	assert.equal(result.action, "transform");
	assert.equal(result.text.slice(result.text.indexOf("</skill>") + "</skill>\n\n".length), prompt);
});

test("literal, escaped, unknown and non-leading slash text stays prose", async (t) => {
	const { pi } = await skillFixture(t);
	const unchanged = [
		"$HOME stays literal",
		"\\$alpha-skill stays escaped",
		"$$alpha-skill stays escaped",
		"$unknown-skill is not loaded",
		"inspect /skill:alpha-skill later",
		"/skill:unknown-skill inspect",
		"see $alpha-skillish for an unrelated token",
	];
	for (const prompt of unchanged) {
		assert.deepEqual(await invoke(pi, "input", { source: "interactive", text: prompt }, context()), { action: "continue" }, prompt);
	}
	assert.deepEqual(
		await invoke(pi, "input", { source: "extension", text: "$alpha-skill $beta-skill inspect" }, context()),
		{ action: "continue" },
	);
});

test("a dollar token concatenated with an identifier boundary stays literal", async (t) => {
	const { pi } = await skillFixture(t);
	const result = await invoke(
		pi,
		"input",
		{ source: "interactive", text: "$alpha-skill$beta-skill inspect" },
		context(),
	) as { action: string; text: string };

	assert.equal(result.action, "transform");
	assert.match(result.text, /^<skill name="alpha-skill"/);
	assert.equal(bodyCount(result.text, "Beta body"), 0);
	assert.ok(result.text.endsWith("\n\n$beta-skill inspect"));
});

test("attached images and the interactive/RPC source survive the transform", async (t) => {
	const { pi } = await skillFixture(t);
	const images = [{ type: "image" as const, data: "ZmFrZQ==", mimeType: "image/png" }];
	for (const source of ["interactive", "rpc"] as const) {
		const result = await invoke(
			pi,
			"input",
			{ source, text: "$alpha-skill look at this", images },
			context(),
		) as { action: string; text: string; images?: unknown };
		assert.equal(result.action, "transform", source);
		assert.equal(result.text.endsWith("\n\nlook at this"), true, source);
		assert.equal("images" in result, false, `${source}: the host keeps the original attachments`);
	}
});

test("a selected skill read failure restores input and submits nothing partial", async (t) => {
	const { pi } = await skillFixture(t);
	pi.skillCommands = [
		...pi.skillCommands,
		{
			name: "skill:missing-skill",
			description: "Missing skill",
			source: "skill",
			sourceInfo: {
				path: "/missing/skill/SKILL.md",
				source: "/missing/skill/SKILL.md",
				scope: "user",
				origin: "top-level",
			},
		},
	];
	const notifications: string[] = [];
	const editorText: string[] = [];
	const prompt = "$alpha-skill /skill:missing-skill inspect";

	const result = await invoke(pi, "input", { source: "interactive", text: prompt }, context({ notifications, editorText }));

	assert.deepEqual(result, { action: "handled" });
	assert.deepEqual(editorText, [prompt]);
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
