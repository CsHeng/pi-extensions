import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SNAPSHOT_EVENT, type SnapshotV1 } from "../extensions/subagents/events.ts";
import { createSubagentsUiExtension, SUBAGENTS_UI_STATUS_KEY } from "../extensions/subagents-ui/index.ts";

class FakeEvents {
	readonly listeners = new Map<string, Array<(data: unknown) => void>>();
	on(name: string, listener: (data: unknown) => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
	}
	emit(name: string, data: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(data);
	}
}

test("UI consumer renders core snapshots from a shared event bus without owning working or footer surfaces", async () => {
	const events = new FakeEvents();
	const statuses: Array<string | undefined> = [];
	const working: unknown[] = [];
	const footers: unknown[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		events,
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		appendEntry() {},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		getActiveTools() { return []; },
	};
	createSubagentsUiExtension()(pi as unknown as ExtensionAPI);
	const ctx = {
		mode: "tui",
		ui: {
			setStatus(key: string, text: string | undefined) { if (key === SUBAGENTS_UI_STATUS_KEY) statuses.push(text); },
			setWidget() {},
			setWorkingMessage(value: unknown) { working.push(value); },
			setFooter(value: unknown) { footers.push(value); },
			notify() {},
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	const snapshot: SnapshotV1 = {
		version: 1,
		runId: "run-1",
		phase: "running",
		requestedTasks: 1,
		admittedTasks: 1,
		launchedChildren: 1,
		activeChildren: 1,
		settledTasks: 0,
		aggregateAssistantTurns: 1,
		elapsedMs: 1000,
		peakConcurrency: 1,
		cancellationRequested: false,
		tasks: [{
			id: "scan",
			ordinal: 1,
			role: "explorer",
			status: "running",
			executionPhase: "child-execution",
			assistantTurns: 1,
			elapsedMs: 1000,
			inactiveForMs: 0,
			activeTools: ["read"],
			errorCount: 0,
			cancellationRequested: false,
		}],
	};
	events.emit(SNAPSHOT_EVENT, snapshot);
	assert.equal(statuses.at(-1)?.includes("SA 1/1 active"), true);
	events.emit(SNAPSHOT_EVENT, { ...snapshot, phase: "settled", activeChildren: 0, settledTasks: 1 });
	assert.equal(statuses.at(-1), undefined);
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
});
