import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ManagedObserver } from "../extensions/subagents/managed-observer.ts";
import {
	createSubagentsUiExtension,
	SUBAGENTS_UI_COMMAND,
	SUBAGENTS_UI_PANEL_KEY,
	SUBAGENTS_UI_STATUS_KEY,
} from "../extensions/subagents-ui/index.ts";
import { SubagentsOverlay, type OverlaySnapshot, type SessionViewState } from "../extensions/subagents-ui/component.ts";
import {
	OBSERVER_STALE_MS,
	compactCount,
	formatHistoryNav,
	formatSessionCountRows,
	formatSessionCounts,
	formatSessionTitle,
	formatSessionUsage,
	sessionCounts,
	sessionHelpText,
	shortLabel,
} from "../extensions/subagents-ui/render.ts";
import { OBSERVER_EVENT, OBSERVER_VERSION, type ObserverSnapshot } from "../extensions/subagents/observer-events.ts";
import {
	SESSION_VIEW_CHANGED_EVENT,
	SESSION_VIEW_EVENT,
	SESSION_VIEW_REQUEST_EVENT,
	SESSION_VIEW_QUERY_EVENT,
	parseSessionViewReply,
	type SessionViewHistoryRow,
	type SessionViewReply,
} from "../extensions/subagents/session-view.ts";
import type { RecordedUsageProjection } from "../extensions/subagents/observability.ts";

type Handler = (event?: unknown, ctx?: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown>;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<unknown>;

class FakeScheduler {
	callback: (() => void) | undefined;
	setCount = 0;
	clearCount = 0;
	setInterval(callback: () => void): unknown { this.callback = callback; this.setCount += 1; return this.setCount; }
	clearInterval(): void { this.callback = undefined; this.clearCount += 1; }
	tick(): void { this.callback?.(); }
}

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

class FakePi {
	readonly events = new FakeEvents();
	readonly handlers = new Map<string, Handler>();
	readonly commands = new Map<string, { handler: CommandHandler }>();
	readonly shortcuts = new Map<string, { handler: ShortcutHandler }>();
	readonly entries: unknown[] = [];
	on(name: string, handler: Handler): void { this.handlers.set(name, handler); }
	registerCommand(name: string, options: { handler: CommandHandler }): void { this.commands.set(name, options); }
	registerShortcut(shortcut: string, options: { handler: ShortcutHandler }): void { this.shortcuts.set(shortcut, options); }
	registerEntryRenderer(): void {}
	appendEntry(customType: string, data: unknown): void { this.entries.push({ customType, data }); }
}

function task(overrides: Partial<ObserverSnapshot["tasks"][number]> = {}): ObserverSnapshot["tasks"][number] {
	return {
		id: "scan",
		ordinal: 1,
		role: "explorer",
		episode: 0,
		status: "running",
		executionPhase: "child-execution",
		route: { provider: "openai", model: "gpt-4.1", thinking: "off" },
		assistantTurns: 2,
		elapsedMs: 4_000,
		replayed: false,
		headline: "scan the bounded facts",
		activeTools: [],
		...overrides,
	};
}

function settledTask(overrides: Partial<ObserverSnapshot["tasks"][number]> = {}): ObserverSnapshot["tasks"][number] {
	return task({
		id: "done",
		ordinal: 2,
		status: "succeeded",
		executionPhase: "settled",
		elapsedMs: 5_000,
		...overrides,
	});
}

function snapshot(overrides: Partial<ObserverSnapshot> = {}): ObserverSnapshot {
	return {
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
		aggregateAssistantTurns: 2,
		elapsedMs: 4_000,
		tasks: [task()],
		...overrides,
	};
}

function owner(overrides: { sessionId?: string; leafId?: string | null; branch?: string[] } = {}) {
	const sessionId = overrides.sessionId ?? "parent_session-1";
	const leafId = overrides.leafId === undefined ? "leaf_entry-1" : overrides.leafId;
	const branch = overrides.branch ?? (leafId ? [leafId] : []);
	return {
		getSessionId: () => sessionId,
		getLeafId: () => leafId,
		getBranch: () => branch.map((id) => ({ id })),
	};
}

function context(options: {
	mode?: ExtensionContext["mode"];
	statuses?: Array<string | undefined>;
	widgets?: Array<{ key: string; lines: string[] | undefined }>;
	working?: Array<string | undefined>;
	footers?: unknown[];
	session?: ReturnType<typeof owner>;
	custom?: (factory: (tui: TUI, theme: unknown, kb: unknown, done: (value: null) => void) => unknown, options?: { overlay?: boolean }) => unknown;
} = {}): ExtensionContext {
	const statuses = options.statuses ?? [];
	const widgets = options.widgets ?? [];
	const working = options.working ?? [];
	const footers = options.footers ?? [];
	return {
		mode: options.mode ?? "tui",
		isProjectTrusted: () => true,
		sessionManager: options.session ?? owner(),
		ui: {
			setStatus(key: string, text: string | undefined) { statuses.push(key === SUBAGENTS_UI_STATUS_KEY ? text : `other:${key}`); },
			setWidget(key: string, content: string[] | undefined) { widgets.push({ key, lines: content }); },
			setWorkingMessage(message?: string) { working.push(message); },
			setFooter(value: unknown) { footers.push(value); },
			notify() {},
			confirm: async () => false,
			custom: options.custom ?? (async () => null),
		},
	} as unknown as ExtensionContext;
}

function install(options: Parameters<typeof createSubagentsUiExtension>[0] = {}) {
	const pi = new FakePi();
	createSubagentsUiExtension(options)(pi as unknown as ExtensionAPI);
	return pi;
}

async function openWith(
	pi: FakePi,
	ctx: ExtensionContext,
	via: "command" | "shortcut" = "command",
): Promise<void> {
	if (via === "command") {
		const command = pi.commands.get(SUBAGENTS_UI_COMMAND);
		assert.ok(command);
		void command.handler("", ctx);
	} else {
		const shortcut = pi.shortcuts.get("ctrl+alt+f");
		assert.ok(shortcut);
		void shortcut.handler(ctx);
	}
	await new Promise((resolve) => setImmediate(resolve));
}

function captureCtx(target: { overlay?: SubagentsOverlay }): ExtensionContext {
	return context({
		custom: (factory) => {
			target.overlay = factory({ requestRender() {} } as TUI, undefined, undefined, () => {}) as SubagentsOverlay;
			// The real host keeps the overlay promise pending until dismissal.
			return new Promise<null>(() => {});
		},
	});
}

const usageProjection = (overrides: Partial<RecordedUsageProjection> = {}): RecordedUsageProjection => ({
	status: "complete",
	usage: { input: 12_345, output: 2_001, cacheRead: 0, cacheWrite: 0, totalTokens: 14_346, cost: 1.25 },
	assistantTurns: 537,
	metrics: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete", totalTokens: "complete", cost: "complete" },
	turnsCoverage: "complete",
	episodes: { recorded: 49, missing: 0, orphaned: 0, unprovable: false },
	conflicts: 0,
	...overrides,
});

function historyRow(overrides: Partial<SessionViewHistoryRow> = {}): SessionViewHistoryRow {
	return {
		handle: "session_11111111-1111-4111-8111-111111111111",
		role: "worker",
		state: "idle",
		episode: 1,
		latestOutcome: "succeeded",
		acceptedEpisodes: 1,
		onCurrentBranch: true,
		legacy: false,
		reportComplete: true,
		retained: false,
		recordedUsage: usageProjection({ usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0.5 }, assistantTurns: 2, episodes: { recorded: 1, missing: 0, orphaned: 0, unprovable: false } }),
		...overrides,
	};
}

function sessionReply(overrides: Partial<SessionViewReply> = {}): SessionViewReply {
	return {
		version: 4,
		requestId: "ui-1",
		ownerSessionId: "parent_session-1",
		anchor: "leaf_entry-1",
		generation: "Gen1",
		revision: 1,
		inventory: { state: "ready", complete: true, unreadableRecords: 0 },
		summary: { agents: 1, acceptedEpisodes: 1, states: { idle: 1, queued: 0, running: 0, interrupted: 0, closed: 0 }, liveAgents: 0 },
		live: [],
		history: { state: "ready", pageSize: 20, page: 0, totalRows: 1, totalPages: 1, rows: [historyRow()] },
		usage: usageProjection(),
		...overrides,
	};
}

const overlayModel = (session: SessionViewState, snapshotValue?: ObserverSnapshot): OverlaySnapshot =>
	({ snapshot: snapshotValue, receivedAt: 0, session });

/** Emit the pending request's reply through the fake event bus. */
function answer(pi: FakePi, reply: SessionViewReply): void {
	pi.events.emit(SESSION_VIEW_EVENT, reply);
}

function lastRequest(pi: FakePi): { version: number; requestId: string; page: number } {
	const request = [...pi.events.emitted].reverse().find(entry => entry.name === SESSION_VIEW_REQUEST_EVENT);
	assert.ok(request, "a session-view request was emitted");
	return request.data as { version: number; requestId: string; page: number };
}

function requestCount(pi: FakePi): number {
	return pi.events.emitted.filter(entry => entry.name === SESSION_VIEW_REQUEST_EVENT).length;
}

test("core timeout uses one interval and closing the overlay cancels it", async () => {
	let clock = 0, sequence = 0;
	const timers = new Map<number, () => void>();
	const pi = install({ now: () => clock, setInterval: callback => { timers.set(++sequence, callback); return sequence; }, clearInterval: handle => { timers.delete(handle as number); } });
	let panel: SubagentsOverlay | undefined;
	const ctx = context({ custom: factory => new Promise(resolve => { panel = factory({ requestRender() {} } as TUI, undefined, undefined, () => resolve(null)) as SubagentsOverlay; }) });
	await pi.handlers.get("session_start")?.({}, ctx);
	await openWith(pi, ctx);
	for (let index = 0; index < 10; index++) {
		clock += 250;
		for (const callback of [...timers.values()]) callback();
		assert.equal(timers.size, 1, "watch ticks never spawn additional intervals");
	}
	panel!.handleInput("ctrl+alt+f");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(timers.size, 0, "ordinary close cancels the pending watch too");
});

test("a session reply alone supplies fresh live rows and a clock", async () => {
	const pi = install({ now: () => 100 });
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	await openWith(pi, ctx);
	const reply = sessionReply({ requestId: lastRequest(pi).requestId, live: [task({ id: "ReplyLive", episode: 3 })], summary: { agents: 1, acceptedEpisodes: 3, liveAgents: 1, states: { idle: 0, queued: 0, running: 1, interrupted: 0, closed: 0 } } });
	pi.events.emit(SESSION_VIEW_EVENT, reply);
	const text = held.overlay!.render(80).join("\n");
	assert.match(text, /1 live/);
	assert.match(text, /ReplyLiv ep3 explorer/);
	await pi.handlers.get("session_shutdown")?.({}, ctx);
});

test("physical layout stays bounded with wrapped counts, long history and all ten live identities", () => {
	const heavyTasks = Array.from({ length: 10 }, (_, index) => task({ id: `session_${String(index).padStart(8, "0")}`, ordinal: index + 1, headline: "long assignment ".repeat(30), activeTools: ["read", "bash"] }));
	const heavyOverlay = new SubagentsOverlay(overlayModel({ kind: "ready", reply: sessionReply() }, snapshot({ tasks: heavyTasks })), { terminal: { rows: 24 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	for (const width of [80, 40]) {
		const frame = heavyOverlay.render(width, 24);
		assert.ok(frame.length <= 24, `physical rows bounded at width ${width}: ${frame.length}`);
		for (const line of frame) assert.ok(visibleWidth(line) <= width);
	}
	const seenLive = new Set<string>();
	for (let index = 0; index < 100; index++) {
		const text = heavyOverlay.render(80, 24).join("\n");
		for (const match of text.matchAll(/(\d{8}) ep0 explorer/g)) seenLive.add(match[1]!);
		heavyOverlay.handleInput("down");
	}
	assert.equal(seenLive.size, 10, "every live identity is reachable through live overflow");

	const rows = Array.from({ length: 20 }, (_, index) => historyRow({ handle: `session_${String(index + 100).padStart(8, "0")}`, onCurrentBranch: false, legacy: true }));
	const reply = sessionReply({ history: { state: "ready", pageSize: 20, page: 0, totalRows: 20, totalPages: 1, rows } });
	const pinnedTasks = Array.from({ length: 2 }, (_, index) => task({ id: `session_${String(index).padStart(8, "0")}`, ordinal: index + 1, headline: "" }));
	const overlay = new SubagentsOverlay(overlayModel({ kind: "ready", reply }, snapshot({ tasks: pinnedTasks })), { terminal: { rows: 24 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	overlay.handleInput("enter");
	for (let index = 0; index < 100; index++) overlay.handleInput("up");
	const seen = new Set<string>();
	for (let index = 0; index < 100; index++) {
		const frame = overlay.render(80, 24);
		assert.ok(frame.length <= 24);
		const text = frame.join("\n");
		for (const match of text.matchAll(/000001\d\d/g)) seen.add(match[0]);
		overlay.handleInput("down");
	}
	assert.equal(seen.size, 20, "every wrapped historical identity is reachable while live rows stay pinned");
});

test("session-scoped title, counts and recorded usage stay distinct from live turns", () => {
	assert.equal(formatSessionTitle(undefined), "Subagents · session");
	assert.equal(formatSessionTitle("parent_session-1"), "Subagents · session parent…");
	const counts = sessionCounts(snapshot(), sessionReply(), "ready", undefined, false);
	const countRows = formatSessionCountRows(counts);
	assert.equal(countRows[0]?.text, "1 live (t2)");
	assert.match(countRows[1]?.text ?? "", /^1 agents · 1 episodes · 1 idle · 0 int · 0 closed$/);
	assert.match(formatSessionCounts(counts).text, /1 live \(t2\)/);
	assert.equal(counts.limitedLive, false);
	const awaitingHistory = sessionCounts(snapshot(), undefined, "ready", undefined, false);
	assert.equal(awaitingHistory.limitedLive, true);
	assert.match(formatSessionCounts(awaitingHistory).text, /limited live observation/);
	const usage = formatSessionUsage(usageProjection());
	assert.match(usage?.text ?? "", /^recorded Σ537 turns · ↑12k ↓2\.0k · \$1\.25$/);
	assert.match(formatSessionUsage(usageProjection({ status: "incomplete", usage: { input: 100, output: null, cacheRead: 0, cacheWrite: 0, totalTokens: null, cost: null }, assistantTurns: 12 }))?.text ?? "", /partial/);
	assert.match(formatSessionUsage(usageProjection({ status: "unavailable", usage: { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null }, assistantTurns: null, metrics: { input: "unavailable", output: "unavailable", cacheRead: "unavailable", cacheWrite: "unavailable", totalTokens: "unavailable", cost: "unavailable" }, turnsCoverage: "unavailable" }))?.text ?? "", /\$/);
	assert.equal(compactCount(null), "?");
	assert.equal(sessionHelpText({ liveOverflow: false, historyOpen: false, historyOverflow: false }), "enter history · ctrl+alt+f close");
	assert.equal(sessionHelpText({ liveOverflow: true, historyOpen: true, historyOverflow: true }), "↑↓ live · ↑↓ rows · enter collapse · pgup/pgdn page · ctrl+alt+f close");
});

test("short agent labels disambiguate collisions and history navigation reports honest ranges", () => {
	const first = "session_11111111-1111-4111-8111-111111111111";
	const second = "session_11111111-2222-4222-8222-222222222222";
	const labels = new Map([first, second].map(handle => [handle, shortLabel(handle, [first, second])]));
	assert.equal(labels.get(first), "11111111-1111-4111".slice(0, 12));
	assert.equal(labels.get(second), "11111111-2222".slice(0, 12));
	assert.equal(shortLabel("session_abcdef01-0000-0000-0000-000000000000"), "abcdef01");
	const history = { state: "ready" as const, pageSize: 20, page: 0, totalRows: 37, totalPages: 2, rows: [] };
	assert.equal(formatHistoryNav(history).text, "history 1–20 of 37 · page 1/2 · pgup/pgdn");
	assert.equal(formatHistoryNav({ ...history, page: 1 }).text, "history 21–37 of 37 · page 2/2 · pgup/pgdn");
	assert.equal(formatHistoryNav({ ...history, totalRows: 0, totalPages: 0 }).text, "history 0–0 of 0 · page 1/1 · pgup/pgdn");
});

test("component renders pinned live rows and a collapsed history row at 80x24 with ten active", () => {
	const liveTasks = Array.from({ length: 10 }, (_, index) => task({ id: `session_${String(index).padStart(8, "0")}`, ordinal: index + 1, headline: `task ${index}` }));
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply: sessionReply({ summary: { agents: 37, acceptedEpisodes: 49, states: { idle: 24, queued: 0, running: 0, interrupted: 1, closed: 2 }, liveAgents: 10 }, history: { state: "ready", pageSize: 20, page: 0, totalRows: 27, totalPages: 2, rows: [] }, live: [] }) }, snapshot({ tasks: liveTasks, requestedTasks: 10, admittedTasks: 10, launchedChildren: 10, activeChildren: 10 })),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const lines = overlay.render(80, 40);
	assert.ok(lines.length <= 40, `panel fits 80x40, got ${lines.length}`);
	assert.match(lines[0] ?? "", /Subagents · session parent…/);
	const text = lines.join("\n");
	assert.equal((text.match(/● [0-9]{8} ep0 explorer/g) ?? []).length, 10, "all ten identified live rows stay visible");
	assert.match(text, /running · 10 agents/);
	assert.match(text, /task 0/, "headline stays on the agent entry, not batched at the bottom");
	assert.match(text, /37 agents · 49 episodes/);
	assert.match(text, /▸ 27 retained agents · enter/);
	assert.doesNotMatch(text, /batch/, "no batch title");
	assert.doesNotMatch(text, /run [a-z0-9]/, "no run-prefix session title");
	// History paging never scrolls the live area away.
	overlay.handleInput("enter");
	const expanded = overlay.render(80, 40).join("\n");
	assert.match(expanded, /history 1–20 of 27 · page 1\/2/);
	assert.equal((expanded.match(/● [0-9]{8} ep0 explorer/g) ?? []).length, 10, "live rows stay pinned under history");
});

test("live route renders on the primary row while headline and tools stay on the secondary line", () => {
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply: sessionReply() }, snapshot({
			tasks: [
				task({ id: "session_00000001", headline: "Read-only C-ROUTEROS", activeTools: ["read"] }),
				task({ id: "session_00000002", ordinal: 2, headline: "Read-only C-ADGUARD", activeTools: [], route: null }),
			],
			requestedTasks: 2,
			admittedTasks: 2,
			launchedChildren: 2,
			activeChildren: 2,
		})),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const text = overlay.render(80, 30).join("\n");
	const first = text.indexOf("00000001");
	const second = text.indexOf("00000002");
	assert.ok(first >= 0 && second > first);
	const firstBlock = text.slice(first, second);
	assert.match(firstBlock, /running[^\n]*openai gpt-4\.1 thinking:off/, "route shares the primary row with status and elapsed");
	assert.match(firstBlock, /Read-only C-ROUTEROS/);
	assert.match(firstBlock, /read/);
	const secondBlock = text.slice(second);
	assert.match(secondBlock, /route unavailable/);
	assert.match(secondBlock, /Read-only C-ADGUARD/);
});

test("detail text keeps visible spaces across zero-width separators and wrapped lines", () => {
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply: sessionReply() }, snapshot({
			tasks: [task({ headline: "Read-only\u200bC-ROUTEROS and more words here", activeTools: ["read", "bash"] })],
		})),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const text = overlay.render(80, 24).join("\n");
	assert.match(text, /Read-only C-ROUTEROS/);
	assert.match(text, /read, bash/);
	const wrapped = overlay.render(36, 24).join("\n");
	assert.match(wrapped, /Read-only C-ROUTEROS/);
});

test("themed overlay renders bounded per-root destination, apply, recovery and release outcomes", () => {
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
	const reply = sessionReply({
		history: { state: "ready", pageSize: 20, page: 0, totalRows: 1, totalPages: 1, rows: [historyRow({
			state: "closed", retained: true,
			roots: [
				{ id: "rootone", destination: "/work/alpha", status: "applied", release: "released" },
				{ id: "roottwo", destination: "/work/beta", status: "unknown", recovery: "required", release: "remaining" },
			],
			release: { status: "partial", remaining: 1 },
		})] },
	});
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply }),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0, theme });
	overlay.handleInput("enter");
	const text = overlay.render(120, 30).join("\n");
	assert.match(text, /rootone applied\/released \/work\/alpha/, "a released root keeps its own apply and release facts in the themed panel");
	assert.match(text, /roottwo unknown!\/remaining \/work\/beta/, "an unreleased root shows its recovery need and remaining release");
});

test("themed overlay keeps scratch-only cleanup failure separate from fully released roots", () => {
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
	const reply = sessionReply({
		history: { state: "ready", pageSize: 20, page: 0, totalRows: 1, totalPages: 1, rows: [historyRow({
			state: "closed", retained: true,
			// A never-frozen candidate: no applied root, yet every owned root was released.
			roots: [
				{ id: "rootone", destination: "/work/alpha", status: "not-applied", release: "released" },
				{ id: "roottwo", destination: "/work/beta", status: "not-applied", release: "released" },
			],
			release: { status: "partial", remaining: 1 },
		})] },
	});
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply }),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0, theme });
	overlay.handleInput("enter");
	const text = overlay.render(120, 30).join("\n");
	assert.match(text, /rootone not-applied\/released \/work\/alpha/);
	assert.match(text, /roottwo not-applied\/released \/work\/beta/);
	assert.doesNotMatch(text, /not-applied\/partial/, "a session-scratch failure is never repeated as a per-root failure");
	assert.match(text, /cleanup=partial remaining=1/, "the aggregate cleanup failure stays visible in the themed panel");
});

test("history reaches every retained handle across pages with enter, pageUp and pageDown", () => {
	const handles = Array.from({ length: 37 }, (_, index) => `session_${String(index + 10).padStart(8, "0")}-${String(index).padStart(4, "0")}-4000-8000-${String(index).padStart(12, "0")}`);
	const page = (index: number): SessionViewReply => sessionReply({
		summary: { agents: 37, acceptedEpisodes: 49, states: { idle: 35, queued: 0, running: 0, interrupted: 0, closed: 2 }, liveAgents: 0 },
		history: {
			state: "ready", pageSize: 20, page: index,
			totalRows: 37, totalPages: 2,
			rows: handles.slice(index * 20, index * 20 + 20).map((handle, ordinal) => historyRow({ handle, episode: 1 + ((ordinal + index * 20) % 2) })),
		},
		usage: usageProjection({ assistantTurns: 49, usage: { input: 49_000, output: 9_000, cacheRead: 0, cacheWrite: 0, totalTokens: 58_000, cost: 9.5 } }),
	});
	const pages: number[] = [];
	const overlay = new SubagentsOverlay(overlayModel({ kind: "idle" }), { terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0, onPage: target => pages.push(target) });
	overlay.update(overlayModel({ kind: "ready", reply: page(0) }));
	overlay.handleInput("enter");
	const first = overlay.render(80, 40).join("\n");
	assert.match(first, /history 1–20 of 37 · page 1\/2/);
	overlay.handleInput("\u001b[6~"); // pageDown
	assert.deepEqual(pages, [1]);
	assert.match(overlay.render(80, 40).join("\n"), /history 1–20 of 37/, "the old page stays until the new reply lands");
	overlay.update(overlayModel({ kind: "ready", reply: page(1) }));
	const second = overlay.render(80, 40).join("\n");
	assert.match(second, /history 21–37 of 37 · page 2\/2/);
	overlay.handleInput("\u001b[6~");
	assert.deepEqual(pages, [1], "paging past the last page requests nothing");
	overlay.handleInput("\u001b[5~"); // pageUp
	assert.deepEqual(pages, [1, 0]);
	const seen = [page(0).history.rows, page(1).history.rows].flat().map(row => row.handle);
	assert.equal(new Set(seen).size, 37, "both pages cover every retained handle exactly once");
	assert.match(second, /recorded Σ49 turns/);
});

test("tiny terminals keep live rows reachable through explicit live-only overflow", () => {
	const liveTasks = Array.from({ length: 6 }, (_, index) => task({ id: `session_${String(index).padStart(8, "0")}`, ordinal: index + 1, headline: "" }));
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply: sessionReply() }, snapshot({ tasks: liveTasks, requestedTasks: 6, admittedTasks: 6, launchedChildren: 6, activeChildren: 6 })),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const lines = overlay.render(80, 10).join("\n");
	assert.match(lines, /live \d+–\d+\/6 · ↑↓ live/, "live overflow is explicit");
	const before = overlay.render(80, 10);
	overlay.handleInput("down");
	const after = overlay.render(80, 10);
	assert.notDeepEqual(after, before, "arrows scroll the live window");
	assert.match(after.join("\n"), /live 2–\d+\/6 · ↑↓ live/);
});

test("registered consumer queries on open, correlates replies and ignores late or foreign answers", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	await openWith(pi, ctx);
	const first = lastRequest(pi);
	assert.equal(first.version, 4);
	assert.equal(first.page, 0);
	assert.match(first.requestId, /^[A-Za-z0-9]+$/);
	// A late reply for an older request cannot replace the pending one.
	answer(pi, sessionReply({ requestId: "ui-stale" }));
	assert.match(held.overlay?.render(120).join("\n") ?? "", /history loading/);
	// A foreign owner reply with the right request id fails fast; it can never answer this scope.
	answer(pi, sessionReply({ requestId: first.requestId, ownerSessionId: "another_session" }));
	assert.match(held.overlay?.render(120).join("\n") ?? "", /history unavailable \(owner_changed\)/);
	// Enter retries through the core contract and the matching reply lands.
	held.overlay?.handleInput("enter");
	const retry = lastRequest(pi);
	const paged = { state: "ready" as const, pageSize: 20, page: 0, totalRows: 37, totalPages: 2, rows: Array.from({ length: 20 }, (_, index) => historyRow({ handle: `session_${String(index).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}` })) };
	answer(pi, sessionReply({ requestId: retry.requestId, history: paged, summary: { agents: 37, acceptedEpisodes: 49, states: { idle: 35, queued: 0, running: 0, interrupted: 0, closed: 2 }, liveAgents: 0 } }));
	const text = held.overlay?.render(120).join("\n") ?? "";
	assert.match(text, /Subagents · session parent…/);
	assert.match(text, /history 1–20 of 37 · page 1\/2/);
	assert.match(text, /✓ [0-9a-f]{8} worker ep1 idle succeeded/);
	held.overlay?.handleInput("enter");
	assert.match(held.overlay?.render(120).join("\n") ?? "", /▸ 37 retained agents · enter/);
	// Page navigation requests the next page; an out-of-order older reply stays ignored.
	held.overlay?.handleInput("enter");
	const second = lastRequest(pi);
	assert.equal(second.page, 0, "no page change yet");
	held.overlay?.handleInput("\u001b[6~");
	const third = lastRequest(pi);
	assert.equal(third.page, 1);
	answer(pi, sessionReply({ requestId: second.requestId, history: paged }));
	assert.match(held.overlay?.render(120).join("\n") ?? "", /history loading/, "stale request answers never repaint");
});

test("wall-clock changes cannot trigger the monotonic core wait deadline", async () => {
	const scheduler = new FakeScheduler();
	const pi = install({ setInterval: callback => scheduler.setInterval(callback), clearInterval: () => scheduler.clearInterval() });
	const held: { overlay?: SubagentsOverlay } = {}, ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx); await openWith(pi, ctx);
	const original = Date.now, jumped = Date.now() + 3_600_000;
	try { Date.now = () => jumped; scheduler.tick(); assert.match(held.overlay!.render(120).join("\n"), /history loading/); }
	finally { Date.now = original; await pi.handlers.get("session_shutdown")?.({}, ctx); }
});

test("missing core replies surface a bounded unavailable state instead of loading forever", async () => {
	const scheduler = new FakeScheduler();
	let clock = 1_000;
	const pi = install({ setInterval: (callback) => scheduler.setInterval(callback), clearInterval: () => scheduler.clearInterval(), now: () => clock });
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	await openWith(pi, ctx);
	lastRequest(pi);
	assert.match(held.overlay?.render(120).join("\n") ?? "", /history loading/);
	for (let tick = 0; tick < 16; tick++) { clock += 250; scheduler.tick(); }
	const timedOut = held.overlay?.render(120).join("\n") ?? "";
	assert.match(timedOut, /history unavailable \(core_timeout\)/);
	assert.match(timedOut, /▸ ⚠ history unavailable/, "unavailable history is visible, never an empty success");
	const audits = pi.entries.filter((entry: any) => entry.customType === SESSION_VIEW_QUERY_EVENT) as Array<{ data: Record<string, unknown> }>;
	assert.equal(audits.length, 1);
	assert.equal(audits[0]!.data.source, "ui"); assert.equal(audits[0]!.data.state, "timeout");
	assert.equal(audits[0]!.data.durationMs, 4_000);
	// Enter retries through the core contract.
	const before = requestCount(pi);
	held.overlay?.handleInput("enter");
	assert.ok(requestCount(pi) > before, "enter on unavailable history requeries");
});

test("a foreign observer cannot invalidate a history-only cached panel", async () => {
	const pi = install(), held: { overlay?: SubagentsOverlay } = {}, ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx); await openWith(pi, ctx);
	answer(pi, sessionReply({ requestId: lastRequest(pi).requestId }));
	const requests = requestCount(pi);
	pi.events.emit(OBSERVER_EVENT, snapshot({ parentSessionId: "foreign-session" }));
	assert.equal(requestCount(pi), requests);
	assert.doesNotMatch(held.overlay!.render(120).join("\n"), /history loading/);
});

test("reloaded UI instances cannot collide with an earlier instance request id", async () => {
	const first = install(), second = install();
	for (const pi of [first, second]) { const held: { overlay?: SubagentsOverlay } = {}; const ctx = captureCtx(held); await pi.handlers.get("session_start")?.({}, ctx); await openWith(pi, ctx); }
	assert.notEqual(lastRequest(first).requestId, lastRequest(second).requestId);
});

test("timed-out history accepts only its correlated late reply and preserves cached rows during refresh failure", async () => {
	const scheduler = new FakeScheduler(); let clock = 1_000;
	const pi = install({ setInterval: callback => scheduler.setInterval(callback), clearInterval: () => scheduler.clearInterval(), now: () => clock });
	const held: { overlay?: SubagentsOverlay } = {}; const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx); await openWith(pi, ctx);
	const first = lastRequest(pi);
	clock += 4_000; scheduler.tick();
	assert.match(held.overlay!.render(120).join("\n"), /core_timeout/);
	answer(pi, sessionReply({ requestId: first.requestId }));
	assert.doesNotMatch(held.overlay!.render(120).join("\n"), /core_timeout/);
	held.overlay!.handleInput("enter");
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	const refresh = lastRequest(pi); clock += 4_000; scheduler.tick();
	const cached = held.overlay!.render(120).join("\n");
	assert.match(cached, /core_timeout/); assert.match(cached, /cached/); assert.match(cached, /11111111/);
	answer(pi, sessionReply({ requestId: first.requestId, summary: { agents: 999, acceptedEpisodes: 999, states: { idle: 999, queued: 0, running: 0, interrupted: 0, closed: 0 }, liveAgents: 0 } }));
	assert.doesNotMatch(held.overlay!.render(120).join("\n"), /999 agents/);
	answer(pi, sessionReply({ requestId: refresh.requestId, inventory: { state: "unavailable", reason: "core_query_failed", complete: false, unreadableRecords: 0 }, summary: null, usage: null,
		history: { state: "unavailable", reason: "core_query_failed", page: 0, pageSize: 20, totalRows: 0, totalPages: 0, rows: [] } }));
	assert.match(held.overlay!.render(120).join("\n"), /core_query_failed/);
	assert.match(held.overlay!.render(120).join("\n"), /11111111/);
	let trusted = false; ctx.isProjectTrusted = () => trusted;
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	assert.doesNotMatch(held.overlay!.render(120).join("\n"), /11111111/);
	assert.match(held.overlay!.render(120).join("\n"), /project_trust_required/);
	trusted = true;
});

test("a retired generation cannot recover a timed-out query after a new generation is observed", async () => {
	const scheduler = new FakeScheduler(); let clock = 1_000;
	const pi = install({ setInterval: callback => scheduler.setInterval(callback), clearInterval: () => scheduler.clearInterval(), now: () => clock });
	const held: { overlay?: SubagentsOverlay } = {}; const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ phase: "settled", tasks: [settledTask()], activeChildren: 0, settledTasks: 1 }));
	await openWith(pi, ctx); const old = lastRequest(pi);
	clock += 4_000; scheduler.tick();
	pi.events.emit(OBSERVER_EVENT, snapshot({ generation: "Gen2", runId: "Run2", phase: "settled", tasks: [settledTask()], activeChildren: 0, settledTasks: 1 }));
	const fresh = lastRequest(pi); assert.notEqual(fresh.requestId, old.requestId);
	answer(pi, sessionReply({ requestId: old.requestId }));
	assert.match(held.overlay!.render(120).join("\n"), /history loading/);
	answer(pi, sessionReply({ requestId: fresh.requestId, generation: "Gen2" }));
	assert.doesNotMatch(held.overlay!.render(120).join("\n"), /history loading/);
});

test("lifecycle invalidation after a timeout starts a new correlated query instead of waiting forever", async () => {
	const scheduler = new FakeScheduler(); let clock = 1_000;
	const pi = install({ setInterval: callback => scheduler.setInterval(callback), clearInterval: () => scheduler.clearInterval(), now: () => clock });
	const held: { overlay?: SubagentsOverlay } = {}; const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx); await openWith(pi, ctx);
	const old = lastRequest(pi); clock += 4_000; scheduler.tick();
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	assert.notEqual(lastRequest(pi).requestId, old.requestId);
	answer(pi, sessionReply({ requestId: old.requestId }));
	assert.match(held.overlay!.render(120).join("\n"), /history loading/);
	answer(pi, sessionReply({ requestId: lastRequest(pi).requestId }));
	assert.doesNotMatch(held.overlay!.render(120).join("\n"), /history loading/);
});

test("changed events coalesce into one requery of the current page while the overlay is open", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	await openWith(pi, ctx);
	const first = lastRequest(pi);
	const paged = { state: "ready" as const, pageSize: 20, page: 0, totalRows: 37, totalPages: 2, rows: Array.from({ length: 20 }, (_, index) => historyRow({ handle: `session_${String(index).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}` })) };
	answer(pi, sessionReply({ requestId: first.requestId, history: paged, summary: { agents: 37, acceptedEpisodes: 49, states: { idle: 35, queued: 0, running: 0, interrupted: 0, closed: 2 }, liveAgents: 0 } }));
	held.overlay?.handleInput("enter");
	held.overlay?.handleInput("\u001b[6~");
	assert.equal(lastRequest(pi).page, 1);
	const pageRequest = lastRequest(pi);
	// Invalidation while a request is pending arms exactly one requery.
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	assert.equal(requestCount(pi), 2, "no immediate duplicate request while pending");
	answer(pi, sessionReply({ requestId: pageRequest.requestId, history: { ...paged, page: 1, rows: paged.rows.slice(0, 17) } }));
	assert.equal(requestCount(pi), 3, "the armed requery fires once after the pending reply");
	assert.equal(lastRequest(pi).page, 1);
	// The armed requery's own reply clears the pending state; then a change requeries immediately.
	const requery = lastRequest(pi);
	answer(pi, sessionReply({ requestId: requery.requestId, history: { ...paged, page: 1, rows: paged.rows.slice(0, 17) } }));
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	assert.equal(requestCount(pi), 4);
	// A closed overlay never requeries.
	const closeRequest = lastRequest(pi);
	answer(pi, sessionReply({ requestId: closeRequest.requestId }));
	await pi.handlers.get("session_shutdown")?.({});
	pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	assert.equal(requestCount(pi), 4);
});

test("live transitions move a handle between live and history without double counting", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	let observerRevision = 0;
	const observer = new ManagedObserver("RunLive", { repo: "/fixture", parentSessionId: "parent_session-1", anchor: "leaf_entry-1", branch: ["leaf_entry-1"] }, "Gen1",
		[{ id: "LiveHandle1", role: "explorer", episode: 1, replayed: false }], () => 1_000,
		value => pi.events.emit(OBSERVER_EVENT, value), () => ++observerRevision);
	observer.begin();
	await openWith(pi, ctx);
	const request = lastRequest(pi);
	observer.childStarted("LiveHandle1");
	answer(pi, sessionReply({ requestId: request.requestId }));
	const liveText = held.overlay?.render(120).join("\n") ?? "";
	assert.match(liveText, /1 live \(t0\)/);
	assert.match(liveText, /● \S+ ep\d+ explorer/);
	// The live handle leaves the history section; settled work returns to it.
	observer.childStopped("LiveHandle1");
	observer.finish(false, false);
	const settledText = held.overlay?.render(120).join("\n") ?? "";
	assert.match(settledText, /No live agents; retained work is in history\./);
	assert.doesNotMatch(settledText, /● \S+ ep\d+ explorer/, "no fresh observation, no live row");
});

test("owner lifecycle resets dismiss an open overlay and reject its retired generation", async () => {
	for (const event of ["session_start", "session_tree", "session_shutdown"]) {
		const pi = install(); let closed = 0;
		const ctx = context({ custom: factory => new Promise(resolve => {
			factory({ requestRender() {} } as TUI, undefined, undefined, () => { closed++; resolve(null); });
		}) });
		await pi.handlers.get("session_start")?.({}, ctx);
		pi.events.emit(OBSERVER_EVENT, snapshot());
		const opened = openWith(pi, ctx);
		await pi.handlers.get(event)?.({}, ctx);
		await opened;
		assert.equal(closed, 1);
		let rendered = "";
		const newCtx = context({ custom: async factory => {
			rendered = (factory({ requestRender() {} } as TUI, undefined, undefined, () => {}) as SubagentsOverlay).render(120).join("\n"); return null;
		} });
		if (event === "session_shutdown") await pi.handlers.get("session_start")?.({}, newCtx);
		pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 100 }));
		await openWith(pi, newCtx);
		assert.match(rendered, /No observed subagent work/);
	}
});

test("widget and status stay off unless explicitly enabled", async () => {
	const pi = install();
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const ctx = context({ statuses, widgets });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	assert.deepEqual(statuses, []);
	assert.deepEqual(widgets, []);
});

test("explicit widget opt-in mirrors the live hierarchy in status and panel", async () => {
	const pi = install({ enableWidget: true });
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const ctx = context({ statuses, widgets });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	assert.equal(statuses.at(-1) !== undefined, true);
	assert.equal(widgets.at(-1)?.key, SUBAGENTS_UI_PANEL_KEY);
});

test("headless modes ignore observer snapshots and session-view traffic", async () => {
	for (const mode of ["rpc", "print"] as const) {
		const pi = install();
		const ctx = context({ mode });
		await pi.handlers.get("session_start")?.({}, ctx);
		pi.events.emit(OBSERVER_EVENT, snapshot());
		await openWith(pi, ctx);
		assert.equal(requestCount(pi), 0, `${mode} never queries session history`);
		pi.events.emit(SESSION_VIEW_EVENT, sessionReply());
		pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
		assert.equal(requestCount(pi), 0);
	}
});

test("missing heartbeats freeze elapsed time and label live status unknown", async () => {
	let clock = 10_000;
	const pi = install({ now: () => clock });
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	await openWith(pi, ctx);
	const request = lastRequest(pi);
	answer(pi, sessionReply({ requestId: request.requestId }));
	clock += OBSERVER_STALE_MS + 1;
	const staleText = held.overlay?.render(120).join("\n") ?? "";
	assert.match(staleText, /unknown/);
	assert.match(staleText, /4\.0s/, "elapsed time freezes without heartbeats");
	// A fresh observation revives the live label.
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 1, elapsedMs: 6_000, tasks: [task({ elapsedMs: 6_000 })] }));
	assert.match(held.overlay?.render(120).join("\n") ?? "", /running/);
});

test("foreign owners and stale revisions cannot repaint an open panel", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	await openWith(pi, ctx);
	const request = lastRequest(pi);
	answer(pi, sessionReply({ requestId: request.requestId }));
	const text = held.overlay?.render(120).join("\n") ?? "";
	pi.events.emit(OBSERVER_EVENT, snapshot({ parentSessionId: "another" }));
	assert.equal(held.overlay?.render(120).join("\n") ?? "", text, "foreign owner snapshot changes nothing");
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 0 }));
	assert.equal(held.overlay?.render(120).join("\n") ?? "", text, "stale revision changes nothing");
});

test("session start and shutdown clear retained observations, the widget and pending queries", async () => {
	const scheduler = new FakeScheduler();
	const pi = install({ setInterval: (callback) => scheduler.setInterval(callback), clearInterval: () => scheduler.clearInterval(), now: () => 0 });
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const ctx = context({ statuses, widgets });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	const held: { overlay?: SubagentsOverlay } = {};
	const openCtx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, openCtx);
	await openWith(pi, openCtx);
	const request = lastRequest(pi);
	// A tree change mid-flight drops the pending request; its late reply cannot land.
	await pi.handlers.get("session_tree")?.({}, context({ statuses, widgets }));
	answer(pi, sessionReply({ requestId: request.requestId }));
	assert.equal(requestCount(pi), 1);
	await pi.handlers.get("session_shutdown")?.({});
	assert.equal(statuses.length, 0);
	assert.equal(widgets.length, 0);
});

test("narrow terminals wrap session rows and keep the close chip hit-testable", () => {
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply: sessionReply({ history: { state: "ready", pageSize: 20, page: 0, totalRows: 1, totalPages: 1, rows: [historyRow({ handle: "session_11111111-1111-4111-8111-111111111111", latestOutcome: "failed", state: "interrupted", onCurrentBranch: false, legacy: true })] } }) }),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	overlay.handleInput("enter");
	const lines = overlay.render(40, 30);
	assert.ok(lines.length > 0);
	assert.ok(lines.every(line => visibleWidth(line) <= 40));
	const range = overlay.handleMouse({ type: "click", button: "left", x: lines[0]!.length - 3, y: 0 });
	assert.deepEqual(range, { handled: true }, "the close chip stays clickable");
	const text = lines.join("\n");
	assert.match(text, /off-branch/);
	assert.match(text, /legacy/);
	assert.match(text, /interrupted/);
	assert.match(text, /failed/);
});

test("live observations widen an open panel without filling the terminal", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	await openWith(pi, ctx);
	const request = lastRequest(pi);
	answer(pi, sessionReply({ requestId: request.requestId }));
	const narrow = held.overlay?.render(80).length ?? 0;
	pi.events.emit(OBSERVER_EVENT, snapshot({ tasks: [task({ headline: "wider observation headline ".repeat(4).trim() })] }));
	const wide = held.overlay?.desiredWidth(200) ?? 0;
	assert.ok(wide > 80, "content grows the panel");
	assert.ok(wide <= 200);
	void narrow;
});

test("themable rows keep hierarchy colors across the session layout", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (color: string, text: string) => `{${color}}${text}{/${color}}`,
	};
	const overlay = new SubagentsOverlay(
		overlayModel({ kind: "ready", reply: sessionReply() }, snapshot()),
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0, theme });
	const lines = overlay.render(80, 24);
	assert.ok(lines.length > 0);
	assert.match(lines[0] ?? "", /<accent>Subagents/);
	assert.ok(lines.every(line => line.startsWith("{selectedBg}")), "panel rows keep the selected background");
});

test("registered command and shortcut open the overlay without closing on stray keys", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	await openWith(pi, ctx, "shortcut");
	assert.ok(held.overlay);
	held.overlay?.handleInput("q");
	held.overlay?.handleInput("escape");
	assert.ok(held.overlay);
	let closed = 0;
	const later: { overlay?: SubagentsOverlay } = {};
	const closeCtx = context({ custom: factory => new Promise(resolve => {
		later.overlay = factory({ requestRender() {} } as TUI, undefined, undefined, () => { closed++; resolve(null); }) as SubagentsOverlay;
	}) });
	await pi.handlers.get("session_start")?.({}, closeCtx);
	await openWith(pi, closeCtx);
	later.overlay?.handleInput("ctrl+alt+f");
	assert.equal(closed, 1, "ctrl+alt+f closes");
});
