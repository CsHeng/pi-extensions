import assert from "node:assert/strict";
import test from "node:test";
import type { EntryRenderer, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createSubagentsUiExtension, SUBAGENTS_UI_ENTRY_TYPE, SUBAGENTS_UI_PANEL_KEY, SUBAGENTS_UI_STATUS_KEY } from "../extensions/subagents-ui/index.ts";
import { SNAPSHOT_EVENT, type SnapshotV1 } from "../extensions/subagents/events.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

class FakeEvents {
	readonly listeners = new Map<string, Array<(data: unknown) => void>>();
	on(name: string, listener: (data: unknown) => void): void {
		const list = this.listeners.get(name) ?? [];
		list.push(listener);
		this.listeners.set(name, list);
	}
	emit(name: string, data: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(data);
	}
}

class FakePi {
	readonly events = new FakeEvents();
	readonly handlers = new Map<string, Handler>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly renderers = new Map<string, EntryRenderer>();
	readonly commands = new Map<string, unknown>();
	readonly shortcuts: string[] = [];
	on(name: string, handler: Handler): void { this.handlers.set(name, handler); }
	registerCommand(name: string, options: unknown): void { this.commands.set(name, options); }
	registerShortcut(shortcut: string): void { this.shortcuts.push(shortcut); }
	registerEntryRenderer(type: string, renderer: EntryRenderer): void { this.renderers.set(type, renderer); }
	appendEntry(customType: string, data: unknown): void { this.entries.push({ customType, data }); }
}

function snapshot(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
	return {
		version: 1,
		runId: "run-1",
		phase: "running",
		requestedTasks: 1,
		admittedTasks: 1,
		launchedChildren: 1,
		activeChildren: 1,
		settledTasks: 0,
		aggregateAssistantTurns: 2,
		elapsedMs: 4_000,
		peakConcurrency: 1,
		cancellationRequested: false,
		tasks: [{
			id: "scan",
			ordinal: 1,
			role: "explorer",
			status: "running",
			executionPhase: "child-execution",
			assistantTurns: 2,
			elapsedMs: 4_000,
			inactiveForMs: 0,
			activeTools: ["read"],
			errorCount: 0,
			cancellationRequested: false,
		}],
		...overrides,
	};
}

function context(
	mode: ExtensionContext["mode"],
	statuses: Array<string | undefined>,
	widgets: Array<{ key: string; lines: string[] | undefined }>,
	working: Array<string | undefined>,
	footers: unknown[],
): ExtensionContext {
	return {
		mode,
		ui: {
			setStatus(key: string, text: string | undefined) {
				if (key === SUBAGENTS_UI_STATUS_KEY) statuses.push(text);
			},
			setWidget(key: string, content: string[] | undefined) {
				widgets.push({ key, lines: content });
			},
			setWorkingMessage(message?: string) { working.push(message); },
			setFooter(value: unknown) { footers.push(value); },
			notify() {},
			confirm: async () => false,
			custom: async () => null,
		},
	} as unknown as ExtensionContext;
}

test("TUI snapshots update keyed status and panel without touching working or footer surfaces", async () => {
	const pi = new FakePi();
	createSubagentsUiExtension()(pi as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const working: Array<string | undefined> = [];
	const footers: unknown[] = [];
	const ctx = context("tui", statuses, widgets, working, footers);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(SNAPSHOT_EVENT, snapshot());
	assert.equal(statuses.at(-1)?.startsWith("SA 1/1 active"), true);
	assert.equal(widgets.at(-1)?.key, SUBAGENTS_UI_PANEL_KEY);
	pi.events.emit(SNAPSHOT_EVENT, snapshot({ phase: "settled", activeChildren: 0, settledTasks: 1 }));
	assert.equal(statuses.at(-1), undefined);
	assert.equal(pi.entries[0]?.customType, SUBAGENTS_UI_ENTRY_TYPE);
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
	assert.ok(pi.shortcuts.includes("ctrl+alt+f"));
	const renderer = pi.renderers.get(SUBAGENTS_UI_ENTRY_TYPE);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	assert.ok(renderer?.({ data: pi.entries[0]?.data } as never, { expanded: false }, theme));
});

test("headless modes ignore snapshots and malformed events", async () => {
	const pi = new FakePi();
	createSubagentsUiExtension()(pi as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const working: Array<string | undefined> = [];
	const footers: unknown[] = [];
	await pi.handlers.get("session_start")?.({}, context("rpc", statuses, widgets, working, footers));
	pi.events.emit(SNAPSHOT_EVENT, snapshot());
	pi.events.emit(SNAPSHOT_EVENT, { version: 1, prompt: "SECRET" });
	assert.deepEqual(statuses, []);
	assert.deepEqual(widgets, []);
	assert.deepEqual(pi.entries, []);
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
});
