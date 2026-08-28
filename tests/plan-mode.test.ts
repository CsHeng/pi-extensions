import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import planMode, {
	PLAN_MODE_ENTRY_TYPE,
	PLAN_MODE_TOOLS,
} from "../extensions/plan-mode/index.ts";

interface FakeCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface FakeEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

class FakePi {
	readonly commands = new Map<string, FakeCommand>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly flags = new Map<string, boolean>();
	readonly handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	readonly notifications: string[] = [];
	readonly statuses: Array<string | undefined> = [];
	readonly toolSources = new Map<string, string>();
	activeTools = ["read", "bash", "edit", "write", "custom-tool"];
	branch: FakeEntry[] = [];
	allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "custom-tool"];

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	getAllTools(): Array<{ name: string; sourceInfo: { source: string } }> {
		return this.allTools.map((name) => ({
			name,
			sourceInfo: { source: this.toolSources.get(name) ?? "builtin" },
		}));
	}

	getFlag(name: string): boolean | undefined {
		return this.flags.get(name);
	}

	on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown): void {
		this.handlers.set(name, handler);
	}

	registerCommand(name: string, command: FakeCommand): void {
		this.commands.set(name, command);
	}

	registerFlag(name: string, definition: { default?: boolean }): void {
		if (!this.flags.has(name)) this.flags.set(name, definition.default ?? false);
	}

	registerTool(): never {
		throw new Error("plan mode must not register model-facing tools");
	}

	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
	}
}

function context(pi: FakePi): ExtensionContext {
	return {
		cwd: "/workspace",
		hasUI: true,
		mode: "rpc",
		sessionManager: { getEntries: () => pi.branch },
		ui: {
			notify: (message: string) => pi.notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => pi.statuses.push(value),
			theme: { fg: (_tone: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
}

async function invoke(pi: FakePi, eventName: string, event: unknown, ctx: ExtensionContext): Promise<unknown> {
	const handler = pi.handlers.get(eventName);
	if (!handler) throw new Error(`missing handler ${eventName}`);
	return handler(event, ctx);
}

async function command(pi: FakePi, commandName: string, ctx: ExtensionContext): Promise<void> {
	const registered = pi.commands.get(commandName);
	if (!registered) throw new Error(`missing command ${commandName}`);
	await registered.handler("", ctx);
}

test("plan profile uses exact read-only tools and default restores the prior set", async () => {
	const pi = new FakePi();
	planMode(pi as unknown as ExtensionAPI);
	const ctx = context(pi);
	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);

	assert.deepEqual([...pi.commands.keys()].sort(), ["default", "plan"]);
	assert.equal(pi.handlers.has("agent_end"), false);
	await command(pi, "plan", ctx);

	assert.deepEqual(pi.activeTools, PLAN_MODE_TOOLS);
	assert.deepEqual(pi.entries, [{
		customType: PLAN_MODE_ENTRY_TYPE,
		data: {
			profile: "plan",
			toolsBeforePlan: ["read", "bash", "edit", "write", "custom-tool"],
		},
	}]);

	await command(pi, "plan", ctx);
	assert.equal(pi.entries.length, 1);
	await command(pi, "default", ctx);
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "custom-tool"]);
	assert.deepEqual(pi.entries.at(-1), {
		customType: PLAN_MODE_ENTRY_TYPE,
		data: { profile: "default", toolsBeforePlan: null },
	});
});

test("plan profile resumes before the next model turn and injects only a compact instruction", async () => {
	const pi = new FakePi();
	pi.branch = [{
		type: "custom",
		customType: PLAN_MODE_ENTRY_TYPE,
		data: { profile: "plan", toolsBeforePlan: ["read", "bash", "edit", "write"] },
	}];
	planMode(pi as unknown as ExtensionAPI);
	const ctx = context(pi);

	await invoke(pi, "session_start", { type: "session_start", reason: "resume" }, ctx);
	assert.deepEqual(pi.activeTools, PLAN_MODE_TOOLS);
	const promptResult = await invoke(pi, "before_agent_start", { systemPrompt: "base prompt" }, ctx) as { systemPrompt: string };
	assert.match(promptResult.systemPrompt, /PLAN PROFILE ACTIVE/);
	assert.match(promptResult.systemPrompt, /read-only/);
	assert.doesNotMatch(promptResult.systemPrompt, /todo|review|execute the plan|workflow/i);

	await command(pi, "default", ctx);
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write"]);
});

test("startup flag enters plan profile and missing read-only tools fail closed", async () => {
	const pi = new FakePi();
	pi.flags.set("plan", true);
	pi.allTools = ["read", "bash", "edit", "write"];
	planMode(pi as unknown as ExtensionAPI);
	const ctx = context(pi);

	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(pi.activeTools, ["read"]);
	assert.match(pi.notifications.at(-1) ?? "", /missing read-only tools: grep, find, ls/);
	assert.deepEqual(pi.entries.at(-1), {
		customType: PLAN_MODE_ENTRY_TYPE,
		data: {
			profile: "plan",
			toolsBeforePlan: ["read", "bash", "edit", "write", "custom-tool"],
		},
	});
});

test("plan profile excludes a custom tool that shadows a read-only built-in name", async () => {
	const pi = new FakePi();
	pi.toolSources.set("read", "package:test-extension");
	planMode(pi as unknown as ExtensionAPI);
	const ctx = context(pi);

	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await command(pi, "plan", ctx);

	assert.deepEqual(pi.activeTools, ["grep", "find", "ls"]);
	assert.match(pi.notifications.at(-1) ?? "", /missing read-only tools: read/);
});
