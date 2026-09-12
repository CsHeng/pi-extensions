import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import fastGpt, { FAST_GPT_ENTRY_TYPE } from "../extensions/fast-gpt/index.ts";

interface FakeCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface FakeEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

interface FakeModel {
	provider: string;
	api: string;
	id: string;
}

class FakePi {
	readonly commands = new Map<string, FakeCommand>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	readonly notifications: Array<{ message: string; level: string }> = [];
	readonly statuses: Array<string | undefined> = [];
	readonly statusKeys: string[] = [];
	branch: FakeEntry[] = [];

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}

	on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown): void {
		this.handlers.set(name, handler);
	}

	registerCommand(name: string, command: FakeCommand): void {
		this.commands.set(name, command);
	}

	registerProvider(): never {
		throw new Error("fast-gpt must not override providers");
	}

	registerTool(): never {
		throw new Error("fast-gpt must not register model-facing tools");
	}
}

function openAiModel(): FakeModel {
	return { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol" };
}

function context(pi: FakePi, model: FakeModel = openAiModel()): ExtensionContext {
	return {
		cwd: "/workspace",
		hasUI: true,
		mode: "rpc",
		model,
		sessionManager: {
			getBranch: () => pi.branch,
			getEntries: () => {
				throw new Error("fast-gpt must restore from the active branch, not the complete session tree");
			},
		},
		ui: {
			notify: (message: string, level: string) => pi.notifications.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => {
				pi.statusKeys.push(key);
				pi.statuses.push(value);
			},
			theme: { fg: (_tone: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
}

async function invoke(pi: FakePi, eventName: string, event: unknown, ctx: ExtensionContext): Promise<unknown> {
	const handler = pi.handlers.get(eventName);
	if (!handler) throw new Error(`missing handler ${eventName}`);
	return handler(event, ctx);
}

async function command(pi: FakePi, ctx: ExtensionContext): Promise<void> {
	const registered = pi.commands.get("fast-gpt");
	if (!registered) throw new Error("missing command fast-gpt");
	await registered.handler("", ctx);
}

test("initial untouched state preserves official OpenAI request payloads", async () => {
	const pi = new FakePi();
	fastGpt(pi as unknown as ExtensionAPI);
	const ctx = context(pi);

	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const payload = { model: "gpt-5.6-sol", input: [], service_tier: "flex" };
	const result = await invoke(pi, "before_provider_request", { payload }, ctx);

	assert.equal(result, undefined);
	assert.deepEqual(payload, { model: "gpt-5.6-sol", input: [], service_tier: "flex" });
	assert.deepEqual(pi.entries, []);
	assert.equal(pi.statuses.at(-1), undefined);
});

test("command toggles correlated requests between priority and explicit default", async () => {
	const pi = new FakePi();
	fastGpt(pi as unknown as ExtensionAPI);
	const ctx = context(pi);
	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await command(pi, ctx);
	const original = { model: "gpt-5.6-sol", input: [{ role: "user" }], metadata: { trace: true } };
	const priority = await invoke(pi, "before_provider_request", { payload: original }, ctx);
	assert.deepEqual(priority, { ...original, service_tier: "priority" });
	assert.equal("service_tier" in original, false);
	assert.equal(pi.statusKeys.at(-1), "fast-gpt");
	assert.equal(pi.statuses.at(-1), "\u26A1");
	assert.deepEqual(pi.entries.at(-1), {
		customType: FAST_GPT_ENTRY_TYPE,
		data: { version: 1, selection: "priority" },
	});

	await command(pi, ctx);
	const standard = await invoke(pi, "before_provider_request", {
		payload: { ...original, service_tier: "priority" },
	}, ctx);
	assert.deepEqual(standard, { ...original, service_tier: "default" });
	assert.equal(pi.statuses.at(-1), undefined);
	assert.deepEqual(pi.entries.at(-1), {
		customType: FAST_GPT_ENTRY_TYPE,
		data: { version: 1, selection: "default" },
	});
});

test("payload transformation is limited to correlated official Responses models", async () => {
	const cases: Array<{ name: string; model: FakeModel; payload: unknown; expected?: Record<string, unknown> }> = [
		{
			name: "OpenAI Codex Responses",
			model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
			payload: { model: "gpt-5.6-sol", input: [] },
			expected: { model: "gpt-5.6-sol", input: [], service_tier: "priority" },
		},
		{
			name: "custom provider using Responses",
			model: { provider: "proxy", api: "openai-responses", id: "gpt-5.6-sol" },
			payload: { model: "gpt-5.6-sol" },
		},
		{
			name: "official provider using another API",
			model: { provider: "openai", api: "openai-completions", id: "gpt-5.6-sol" },
			payload: { model: "gpt-5.6-sol" },
		},
		{
			name: "payload for another model",
			model: openAiModel(),
			payload: { model: "gpt-5.6-terra" },
		},
		{ name: "null payload", model: openAiModel(), payload: null },
		{ name: "array payload", model: openAiModel(), payload: [] },
	];

	for (const scenario of cases) {
		const pi = new FakePi();
		fastGpt(pi as unknown as ExtensionAPI);
		const ctx = context(pi, scenario.model);
		await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await command(pi, ctx);
		const result = await invoke(pi, "before_provider_request", { payload: scenario.payload }, ctx);
		assert.deepEqual(result, scenario.expected, scenario.name);
	}
});

test("active branch state restores across startup and tree navigation", async () => {
	const pi = new FakePi();
	pi.branch = [{
		type: "custom",
		customType: FAST_GPT_ENTRY_TYPE,
		data: { version: 1, selection: "priority" },
	}];
	fastGpt(pi as unknown as ExtensionAPI);
	const ctx = context(pi);

	await invoke(pi, "session_start", { type: "session_start", reason: "resume" }, ctx);
	assert.equal(pi.statuses.at(-1), "\u26A1");
	assert.deepEqual(await invoke(pi, "before_provider_request", {
		payload: { model: "gpt-5.6-sol" },
	}, ctx), { model: "gpt-5.6-sol", service_tier: "priority" });

	pi.branch = [{
		type: "custom",
		customType: FAST_GPT_ENTRY_TYPE,
		data: { version: 1, selection: "default" },
	}];
	await invoke(pi, "session_tree", { type: "session_tree" }, ctx);
	assert.equal(pi.statuses.at(-1), undefined);
	assert.deepEqual(await invoke(pi, "before_provider_request", {
		payload: { model: "gpt-5.6-sol" },
	}, ctx), { model: "gpt-5.6-sol", service_tier: "default" });

	pi.branch = [];
	await invoke(pi, "session_tree", { type: "session_tree" }, ctx);
	assert.equal(await invoke(pi, "before_provider_request", {
		payload: { model: "gpt-5.6-sol" },
	}, ctx), undefined);
	assert.equal(pi.entries.length, 0);
});

test("invalid branch state fails back to untouched requests", async () => {
	const pi = new FakePi();
	pi.branch = [{
		type: "custom",
		customType: FAST_GPT_ENTRY_TYPE,
		data: { version: 1, selection: "turbo" },
	}];
	fastGpt(pi as unknown as ExtensionAPI);
	const ctx = context(pi);

	await invoke(pi, "session_start", { type: "session_start", reason: "resume" }, ctx);
	assert.equal(await invoke(pi, "before_provider_request", {
		payload: { model: "gpt-5.6-sol" },
	}, ctx), undefined);
	assert.match(pi.notifications.at(-1)?.message ?? "", /Invalid fast-gpt state/);
	assert.equal(pi.notifications.at(-1)?.level, "warning");
	assert.equal(pi.entries.length, 0);
});

test("model selection updates applicability without discarding priority selection", async () => {
	const pi = new FakePi();
	pi.branch = [{
		type: "custom",
		customType: FAST_GPT_ENTRY_TYPE,
		data: { version: 1, selection: "priority" },
	}];
	fastGpt(pi as unknown as ExtensionAPI);
	const ctx = context(pi);
	await invoke(pi, "session_start", { type: "session_start", reason: "resume" }, ctx);

	await invoke(pi, "model_select", {
		model: { provider: "anthropic", api: "anthropic-messages", id: "claude" },
	}, ctx);
	assert.equal(pi.statuses.at(-1), undefined);

	await invoke(pi, "model_select", { model: openAiModel() }, ctx);
	assert.equal(pi.statuses.at(-1), "\u26A1");
});
