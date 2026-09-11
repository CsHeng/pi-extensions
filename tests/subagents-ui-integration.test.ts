import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { OBSERVER_EVENT, OBSERVER_VERSION, type ObserverSnapshot } from "../extensions/subagents/observer-events.ts";
import { createSubagentsUiExtension, SUBAGENTS_UI_COMMAND } from "../extensions/subagents-ui/index.ts";
import { SubagentsOverlay } from "../extensions/subagents-ui/component.ts";

class FakeEvents {
	readonly listeners = new Map<string, Array<(data: unknown) => void>>();
	on(name: string, listener: (data: unknown) => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
	}
	emit(name: string, data: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(data);
	}
}

test("UI consumer projects v2 observer snapshots through the registered overlay without default chrome", async () => {
	const events = new FakeEvents();
	const statuses: unknown[] = [];
	const widgets: unknown[] = [];
	const working: unknown[] = [];
	const footers: unknown[] = [];
	const entries: unknown[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }>();
	const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<unknown> }>();
	let overlay: SubagentsOverlay | undefined;
	let overlayFlag = false;
	const pi = {
		events,
		registerTool() {},
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }) {
			commands.set(name, options);
		},
		registerShortcut(name: string, options: { handler: (ctx: ExtensionContext) => Promise<unknown> }) {
			shortcuts.set(name, options);
		},
		registerEntryRenderer() {},
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		getActiveTools() { return []; },
	};
	createSubagentsUiExtension()(pi as unknown as ExtensionAPI);
	const tui = { requestRender() {} } as TUI;
	const ctx = {
		mode: "tui",
		sessionManager: {
			getSessionId: () => "parent_session-1",
			getLeafId: () => "leaf_entry-1",
			getBranch: () => [{ id: "leaf_entry-1" }],
		},
		ui: {
			setStatus(_key: string, value: unknown) { statuses.push(value); },
			setWidget(_key: string, value: unknown) { widgets.push(value); },
			setWorkingMessage(value: unknown) { working.push(value); },
			setFooter(value: unknown) { footers.push(value); },
			notify() {},
			custom: async (factory: (tui: TUI, theme: unknown, kb: unknown, done: (value: null) => void) => unknown, options: { overlay?: boolean }) => {
				overlayFlag = options.overlay === true;
				overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
				return null;
			},
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	const snapshot: ObserverSnapshot = {
		version: OBSERVER_VERSION,
		parentSessionId: "parent_session-1",
		anchor: "leaf_entry-1",
		generation: "gen-1",
		runId: "run-1",
		revision: 0,
		phase: "running",
		requestedTasks: 1,
		admittedTasks: 1,
		launchedChildren: 1,
		activeChildren: 1,
		settledTasks: 0,
		aggregateAssistantTurns: 1,
		elapsedMs: 1000,
		tasks: [{
			id: "scan",
			ordinal: 1,
			role: "explorer",
			episode: 0,
			status: "running",
			executionPhase: "child-execution",
			route: { provider: "openai", model: "gpt-4.1", thinking: "medium" },
			assistantTurns: 1,
			elapsedMs: 1000,
			replayed: false,
		}],
	};
	events.emit(OBSERVER_EVENT, snapshot);
	assert.deepEqual(statuses, []);
	assert.deepEqual(widgets, []);
	const command = commands.get(SUBAGENTS_UI_COMMAND);
	assert.ok(command);
	await command.handler("", ctx);
	assert.equal(overlayFlag, true);
	const text = overlay?.render(80).join("\n") ?? "";
	assert.match(text, /thinking:medium/);
	assert.match(text, /launched 1 running 1 finished 0/);
	events.emit(OBSERVER_EVENT, { ...snapshot, revision: 1, phase: "settled", activeChildren: 0, settledTasks: 1 });
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
	assert.deepEqual(entries, []);
	assert.ok(shortcuts.has("ctrl+alt+f"));
});
