import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { OBSERVER_EVENT, OBSERVER_VERSION, type ObserverSnapshot } from "../extensions/subagents/observer-events.ts";
import { SESSION_VIEW_EVENT, SESSION_VIEW_REQUEST_EVENT, type SessionViewReply } from "../extensions/subagents/session-view.ts";
import { createSubagentsUiExtension, SUBAGENTS_UI_COMMAND } from "../extensions/subagents-ui/index.ts";
import { SubagentsOverlay } from "../extensions/subagents-ui/component.ts";

class FakeEvents {
	readonly listeners = new Map<string, Array<(data: unknown) => void>>();
	readonly emitted: Array<{ name: string; data: unknown }> = [];
	on(name: string, listener: (data: unknown) => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
	}
	emit(name: string, data: unknown): void {
		this.emitted.push({ name, data });
		for (const listener of this.listeners.get(name) ?? []) listener(data);
	}
}

test("UI consumer projects observer snapshots through the registered overlay without default chrome", async () => {
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
		isProjectTrusted: () => true,
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
			custom: (factory: (tui: TUI, theme: unknown, kb: unknown, done: (value: null) => void) => unknown, options: { overlay?: boolean }) => {
				overlayFlag = options.overlay === true;
				overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
				// The real host keeps the overlay promise pending until dismissal.
				return new Promise<null>(() => {});
			},
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	const snapshot: ObserverSnapshot = {
		version: OBSERVER_VERSION,
		parentSessionId: "parent_session-1",
		anchor: "leaf_entry-1",
		generation: "Gen1",
		runId: "Run1",
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
			headline: "scan the bounded facts",
			activeTools: ["read"],
		}],
	};
	events.emit(OBSERVER_EVENT, snapshot);
	assert.deepEqual(statuses, []);
	assert.deepEqual(widgets, []);
	const command = commands.get(SUBAGENTS_UI_COMMAND);
	assert.ok(command);
	void command.handler("", ctx);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(overlayFlag, true);
	// Opening the session-scoped overlay queries retained history through the core contract.
	const requests = events.emitted.filter((entry: { name: string }) => entry.name === SESSION_VIEW_REQUEST_EVENT).map((entry: { data: unknown }) => entry.data as { version: number; requestId: string; page: number });
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.version, 4);
	assert.equal(requests[0]!.page, 0);
	const reply: SessionViewReply = {
		version: 4, requestId: requests[0]!.requestId, ownerSessionId: "parent_session-1", anchor: "leaf_entry-1", generation: "Gen1", revision: 1,
		inventory: { state: "ready", complete: true, unreadableRecords: 0 },
		summary: { agents: 2, acceptedEpisodes: 2, states: { idle: 0, queued: 0, running: 1, interrupted: 0, closed: 1 }, liveAgents: 1 },
		live: snapshot.tasks,
		history: { state: "ready", pageSize: 20, page: 0, totalRows: 1, totalPages: 1, rows: [{ handle: "session_22222222-2222-4222-8222-222222222222", role: "reviewer", state: "closed", episode: 1, latestOutcome: "succeeded", acceptedEpisodes: 1, onCurrentBranch: true, legacy: false, reportComplete: true, retained: true, recordedUsage: { status: "complete", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: 0.2 }, assistantTurns: 1, metrics: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete", totalTokens: "complete", cost: "complete" }, turnsCoverage: "complete", episodes: { recorded: 1, missing: 0, orphaned: 0, unprovable: false }, conflicts: 0 } }] },
		usage: { status: "complete", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: 0.2 }, assistantTurns: 1, metrics: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete", totalTokens: "complete", cost: "complete" }, turnsCoverage: "complete", episodes: { recorded: 1, missing: 0, orphaned: 0, unprovable: false }, conflicts: 0 },
	};
	events.emit(SESSION_VIEW_EVENT, reply);
	const text = overlay?.render(80).join("\n") ?? "";
	assert.match(text, /running\s+1\.0s\s+openai gpt-4\.1 thinking:medium/, "the route shares the primary row with status and elapsed");
	assert.match(text, /Subagents · session parent…/, "the title identifies the session, never a batch or run");
	assert.match(text, /1 live \(t1\)/);
	assert.match(text, /2 agents · 2 episodes · 0 idle · 0 int · 1 closed/);
	assert.match(text, /recorded Σ1 turns/);
	assert.match(text, /● scan ep0 explorer t1\s+running\s+1\.0s/);
	assert.match(text, /scan the bounded facts · read/);
	overlay?.handleInput("enter");
	const history = overlay?.render(80).join("\n") ?? "";
	assert.match(history, /■ 22222222 reviewer ep1 closed succeeded/);
	events.emit(OBSERVER_EVENT, { ...snapshot, revision: 1, phase: "settled", activeChildren: 0, settledTasks: 1 });
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
	assert.deepEqual(entries, []);
	assert.ok(shortcuts.has("ctrl+alt+f"));
});
