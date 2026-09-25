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
import { SubagentsOverlay } from "../extensions/subagents-ui/component.ts";
import { OBSERVER_EVENT, OBSERVER_VERSION, type ObserverSnapshot } from "../extensions/subagents/observer-events.ts";
import {
	EMPTY_OBSERVER_MESSAGE,
	OBSERVER_STALE_MS,
	closeMarkerColumns,
	formatGroupRow,
	formatLiveRow,
	formatSettledRow,
	formatStatus,
	formatTitle,
	helpText,
	settledSummary,
	taskColumns,
} from "../extensions/subagents-ui/render.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<unknown> | unknown;

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

class FakeScheduler {
	callback: (() => void) | undefined;
	clearCount = 0;
	setCount = 0;
	setInterval(callback: () => void): object {
		this.setCount += 1;
		this.callback = callback;
		return this;
	}
	clearInterval(handle: unknown): void {
		assert.equal(handle, this);
		this.callback = undefined;
		this.clearCount += 1;
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
		generation: "gen-1",
		runId: "run-1",
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

function mixedSnapshot(overrides: Partial<ObserverSnapshot> = {}): ObserverSnapshot {
	return snapshot({
		requestedTasks: 2,
		admittedTasks: 2,
		launchedChildren: 2,
		activeChildren: 1,
		settledTasks: 1,
		aggregateAssistantTurns: 4,
		tasks: [task(), settledTask()],
		...overrides,
	});
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
		await command.handler("", ctx);
		return;
	}
	const shortcut = pi.shortcuts.get("ctrl+alt+f");
	assert.ok(shortcut);
	await shortcut.handler(ctx);
}

function captureCtx(target: { overlay?: SubagentsOverlay }): ExtensionContext {
	return context({
		custom: async (factory) => {
			target.overlay = factory({ requestRender() {} } as TUI, undefined, undefined, () => {}) as SubagentsOverlay;
			return null;
		},
	});
}

test("successive real publishers label each run as its own batch and fold settled routes", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	let revision = 0;
	let batch = 0;
	for (const [run, beats] of [["first", 20], ["second", 0]] as const) {
		batch += 1;
		const observer = new ManagedObserver(run, { repo: "/fixture", parentSessionId: "parent_session-1", anchor: "leaf_entry-1", branch: ["leaf_entry-1"] }, "generation",
			[{ id: "task", role: "reviewer", episode: 1, replayed: false, route: { provider: "fixture", model: run, thinking: "off" } as never }], () => 0,
			value => pi.events.emit(OBSERVER_EVENT, value), () => ++revision);
		observer.begin(); observer.childStarted("task");
		for (let index = 0; index < beats; index++) observer.update([]);
		observer.childStopped("task"); observer.finish(false, false);
		await openWith(pi, ctx);
		const collapsed = held.overlay?.render(160).join("\n") ?? "";
		assert.match(collapsed, new RegExp(`Subagents · batch ${batch} · run ${run.slice(0, 4)}… · settled`));
		assert.doesNotMatch(collapsed, new RegExp(`fixture ${run} thinking:off`), "settled route stays folded");
		held.overlay?.handleInput("enter");
		const expanded = held.overlay?.render(160).join("\n") ?? "";
		assert.match(expanded, new RegExp(`fixture ${run} thinking:off`));
	}
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

test("actual render(width) wraps folded-out routes and derives a scrollable viewport", () => {
	const overlay = new SubagentsOverlay(
		{ snapshot: snapshot({ tasks: [settledTask({ route: { provider: "fixture", model: "宽模型".repeat(35), thinking: "high" } })] }), receivedAt: 0 },
		{ terminal: { rows: 10 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const folded = overlay.render(16);
	assert.ok(folded.length <= 8);
	assert.ok(folded.every(line => visibleWidth(line) <= 16));
	assert.equal(folded.join("\n").includes("宽模型"), false, "folded settled group hides routes");
	overlay.handleInput("enter");
	const expanded = overlay.render(16, 40);
	assert.match(expanded.join("\n"), /宽模型/);
	assert.ok(expanded.every(line => visibleWidth(line) <= 16));
	const paged = overlay.render(16);
	assert.ok(paged.some(line => line.trimStart().startsWith("↑ ") || line.trimStart().startsWith("↓ ")), "overflow markers appear");
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

test("row formatters keep live-first hierarchy, folded summaries, and honest help", () => {
	const tasks = [task(), settledTask()];
	const columns = taskColumns(tasks, "live");
	const live = formatLiveRow(task(), "live", columns);
	assert.equal(live.text, "● explorer t2  running   4.0s");
	assert.deepEqual(live.segments?.map(segment => segment.color), ["accent", "text", "accent", "text"]);
	const settled = formatSettledRow(settledTask(), columns);
	assert.match(settled.text, /^ {2}✓ explorer t2  succeeded 5\.0s  openai gpt-4\.1 thinking:off$/);
	assert.deepEqual(settled.segments?.map(segment => segment.color), ["dim"]);
	const summary = settledSummary(tasks);
	assert.deepEqual(summary, { count: 1, rangeText: "5.0s", turns: 2 });
	assert.equal(formatGroupRow(summary, false), "▸ 1 finished · 5.0s · 2 turns");
	assert.equal(formatGroupRow(summary, true), "▾ 1 finished · 5.0s · 2 turns");
	assert.equal(formatTitle(snapshot(), "live", { batch: 3 }), "Subagents · batch 3 · run run-… · running");
	assert.equal(formatTitle(snapshot(), "stale", { batch: 1 }), "Subagents · batch 1 · run run-… · stale");
	assert.equal(formatTitle(undefined, "empty"), "Subagents");
	assert.equal(formatStatus(snapshot()), "SA ●1 running · 0 finished · 4.0s");
	assert.equal(helpText({ overflow: false, hasGroup: false, expanded: false }), "ctrl+alt+f close");
	assert.equal(helpText({ overflow: false, hasGroup: true, expanded: false }), "enter expand · ctrl+alt+f close");
	assert.equal(helpText({ overflow: true, hasGroup: true, expanded: true }), "↑↓ scroll · enter collapse · ctrl+alt+f close");
});

test("registered command and shortcut open the live-first overlay without closing on stray keys", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ elapsedMs: 4_000, tasks: [task({ elapsedMs: 4_000 })] }));
	await openWith(pi, ctx);
	await openWith(pi, ctx, "shortcut");
	const rendered = held.overlay?.render(120).join("\n") ?? "";
	assert.match(rendered, /Subagents · batch 1 · run run-… · running/);
	assert.match(rendered, /1 running · 0 finished · 2 turns · 4\.0s/);
	assert.match(rendered, /● explorer t2\s+running\s+4\.0s/);
	assert.match(rendered, /scan the bounded facts/);
	assert.doesNotMatch(rendered, /gpt-4\.1/, "live rows keep tertiary route details folded away");
	assert.match(rendered, /ctrl\+alt\+f close/);
	assert.doesNotMatch(rendered, /↑↓ scroll|enter expand/, "help lists only keys that act now");
	for (const key of ["x", "R", "shift+r", "escape"]) held.overlay?.handleInput(key);
	assert.ok(held.overlay);
});

test("content-fitted overlay options keep the close chip hit-testable and rows filled", () => {
	const width = 90;
	const tui = { requestRender() {} } as TUI;
	const overlay = new SubagentsOverlay({ snapshot: mixedSnapshot(), receivedAt: 0 }, tui, () => {}, { now: () => 0 });
	const lines = overlay.render(width);
	assert.ok(lines.every(line => visibleWidth(line) === width), "every panel row fills the width");
	assert.equal(lines.filter(line => line.includes("✕")).length, 1);
	const chip = closeMarkerColumns(width);
	const live = lines.find(line => line.includes("explorer t2")) ?? "";
	assert.match(live, /running\s+4\.0s/, "live row carries role, turns and status in one aligned line");
	const detail = lines.find(line => line.includes("scan the bounded facts")) ?? "";
	assert.ok(detail.startsWith("     "), "objective is demoted to an indented line");
	assert.match(lines.join("\n"), /▸ 1 finished · 5\.0s · 2 turns/, "settled work folds into one summary row");
	let doneCount = 0;
	const closing = new SubagentsOverlay({ snapshot: mixedSnapshot(), receivedAt: 0 }, tui, () => { doneCount += 1; }, { now: () => 0 });
	closing.render(width);
	closing.handleMouse({ type: "click", button: "left", x: chip.start - 1, y: 0 });
	closing.handleMouse({ type: "click", button: "left", x: chip.start, y: 1 });
	closing.handleMouse({ type: "wheel", button: "none", x: chip.start, y: 0 });
	closing.handleMouse({ type: "click", button: "right", x: chip.start, y: 0 });
	assert.equal(doneCount, 0);
	assert.deepEqual(closing.handleMouse({ type: "press", button: "left", x: chip.start, y: 0 }), { handled: true });
	assert.equal(doneCount, 0);
	closing.handleMouse({ type: "click", button: "left", x: chip.end - 1, y: 0 });
	assert.equal(doneCount, 1);
});

test("group keys expand and fold settled work; arrows only scroll when something overflows", () => {
	const tui = { requestRender() {} } as TUI;
	const overlay = new SubagentsOverlay({ snapshot: mixedSnapshot(), receivedAt: 0 }, tui, () => {}, { now: () => 0 });
	const folded = overlay.render(120).join("\n");
	assert.doesNotMatch(folded, /gpt-4\.1 thinking:off/);
	assert.match(folded, /enter expand · ctrl\+alt\+f close/);
	overlay.handleInput("down");
	const opened = overlay.render(120).join("\n");
	assert.match(opened, /✓ explorer t2\s+succeeded 5\.0s  openai gpt-4\.1 thinking:off/);
	assert.match(opened, /enter collapse · ctrl\+alt\+f close/);
	overlay.handleInput("up");
	assert.doesNotMatch(overlay.render(120).join("\n"), /thinking:off/);
	overlay.handleInput("enter");
	assert.match(overlay.render(120).join("\n"), /thinking:off/);
	overlay.handleInput("enter");
	overlay.handleInput("down");
	assert.match(overlay.render(120).join("\n"), /thinking:off/, "down at offset 0 reopens the folded group when nothing overflows");
	const short = new SubagentsOverlay({ snapshot: mixedSnapshot(), receivedAt: 0 }, tui, () => {}, { now: () => 0 });
	const paged = short.render(60, 6);
	assert.ok(paged.some(line => line.trimStart().startsWith("↓ +")), "short viewport overflows");
	short.handleInput("down");
	const scrolled = short.render(60, 6);
	assert.ok(scrolled.some(line => line.trimStart().startsWith("↑ ")), "down scrolls instead of expanding under overflow");
});

test("live observations widen an open panel without filling the terminal", async () => {
	const pi = install();
	let layout: { width?: unknown } | undefined;
	let release: (() => void) | undefined;
	const tui = { requestRender() {}, terminal: { columns: 200, rows: 40 } } as unknown as TUI;
	const ctx = context({
		custom: (factory, options) => new Promise(resolve => {
			layout = (options as { overlayOptions?: { width?: unknown } }).overlayOptions;
			factory(tui, undefined, undefined, () => {});
			release = () => resolve(null);
		}),
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	const opening = openWith(pi, ctx);
	assert.equal(Number(layout?.width), 80);
	pi.events.emit(OBSERVER_EVENT, snapshot({
		tasks: [task({
			headline: "search confirm the governance entry against the old clauses and the source matrix now",
			route: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
		})],
	}));
	const widened = Number(layout?.width);
	assert.ok(widened > 80 && widened < 200, `panel width ${widened} must grow with content without filling the terminal`);
	release?.();
	await opening;
});

test("panel width grows with observed content and themed rows keep hierarchy colors", () => {
	const tui = { requestRender() {} } as TUI;
	const overlay = new SubagentsOverlay({ snapshot: undefined, receivedAt: 0 }, tui, () => {}, { now: () => 0 });
	assert.equal(overlay.desiredWidth(200), 80);
	overlay.update({ snapshot: mixedSnapshot({ tasks: [task({ headline: "search confirm the governance entry against the old clauses and the source matrix now" }), settledTask()] }), receivedAt: 0 });
	const width = overlay.desiredWidth(200);
	assert.ok(width > 80 && width < 200, `busy panel width ${width} must grow with content without filling the terminal`);
	const codes: Record<string, string> = { accent: "35", borderMuted: "34", dim: "90", text: "37" };
	const theme = {
		fg: (color: string, text: string) => `\u001b[${codes[color]}m${text}\u001b[0m`,
		bg: (_color: string, text: string) => `\u001b[44m${text}\u001b[0m`,
	};
	const themed = new SubagentsOverlay({ snapshot: mixedSnapshot(), receivedAt: 0 }, tui, () => {}, { now: () => 0, theme });
	const lines = themed.render(width);
	const plain = new SubagentsOverlay({ snapshot: mixedSnapshot(), receivedAt: 0 }, tui, () => {}, { now: () => 0 });
	assert.equal(lines.length, plain.render(width).length);
	assert.ok(lines.every(line => line.includes("44")), "panel background fills every row");
	const title = lines[0] ?? "";
	assert.ok(title.includes(`${codes.accent}mSubagents`), "title stays accent");
	const counts = lines.find(line => line.includes("1 running")) ?? "";
	assert.ok(counts.includes(`${codes.accent}m1 running`), "live count is the emphasized fact");
	assert.ok(counts.includes(`${codes.dim}m · 1 finished`), "settled counts stay secondary");
	const live = lines.find(line => line.includes("explorer t2")) ?? "";
	assert.ok(live.includes(`${codes.accent}m● `) && live.includes(`${codes.accent}mrunning`));
	const detail = lines.find(line => line.includes("scan the bounded facts")) ?? "";
	assert.ok(detail.includes(`${codes.dim}m`), "demoted objective is dim");
	const group = lines.find(line => line.includes("1 finished · 5.0s")) ?? "";
	assert.ok(group.includes(`${codes.dim}m▸`), "folded summary is dim");
});

test("explicit widget opt-in mirrors the live-first hierarchy in status and panel", async () => {
	const pi = install({ enableWidget: true });
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const ctx = context({ statuses, widgets });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	assert.deepEqual(statuses, [undefined, "SA ●1 running · 0 finished · 4.0s"]);
	assert.equal(widgets.length, 2);
	assert.equal(widgets[1]?.key, SUBAGENTS_UI_PANEL_KEY);
	assert.deepEqual(widgets[1]?.lines, [
		"1 running · 0 finished · 2 turns · 4.0s",
		"● explorer t2  running 4.0s",
		"    scan the bounded facts",
	]);
	pi.events.emit(OBSERVER_EVENT, mixedSnapshot({ revision: 1 }));
	const last = widgets.at(-1)?.lines ?? [];
	assert.match(last[last.length - 1] ?? "", /▸ 1 finished · 5\.0s · 2 turns/);
});

test("headless modes ignore observer snapshots", async () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const pi = install({ enableWidget: true });
		const statuses: Array<string | undefined> = [];
		const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
		const ctx = context({ mode, statuses, widgets });
		await pi.handlers.get("session_start")?.({}, ctx);
		pi.events.emit(OBSERVER_EVENT, snapshot());
		assert.deepEqual(statuses, []);
		assert.deepEqual(widgets, []);
		let opened = false;
		const openCtx = context({ mode, custom: async () => { opened = true; return null; } });
		await openWith(pi, openCtx);
		assert.equal(opened, false);
	}
});

test("late open shows the retained run without native polling", async () => {
	const scheduler = new FakeScheduler();
	const pi = install({ setInterval: callback => scheduler.setInterval(callback), clearInterval: handle => scheduler.clearInterval(handle) });
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 1, phase: "settled", activeChildren: 0, settledTasks: 1, elapsedMs: 5_000, tasks: [settledTask({ assistantTurns: 2, elapsedMs: 5_000 })] }));
	assert.equal(scheduler.setCount, 0, "settled observations need no repaint timer");
	await openWith(pi, ctx);
	const rendered = held.overlay?.render(120).join("\n") ?? "";
	assert.match(rendered, /· settled/);
	assert.match(rendered, /1 finished · 5\.0s · 2 turns/);
	assert.doesNotMatch(rendered, /stale|unknown/);
});

test("missing heartbeats freeze elapsed time and label the run stale", async () => {
	const scheduler = new FakeScheduler();
	let clock = 0;
	const pi = install({ now: () => clock, setInterval: callback => scheduler.setInterval(callback), clearInterval: handle => scheduler.clearInterval(handle) });
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 1, elapsedMs: 1_000, tasks: [task({ elapsedMs: 1_000 })] }));
	clock = OBSERVER_STALE_MS + 1;
	await openWith(pi, ctx);
	const rendered = held.overlay?.render(120).join("\n") ?? "";
	assert.match(rendered, /· stale/);
	assert.match(rendered, /1 unknown · 0 finished · 2 turns · 1\.0s frozen/);
	assert.match(rendered, /● explorer t2\s+unknown\s+1\.0s/);
	assert.doesNotMatch(rendered, /stale\/unknown/);
	scheduler.callback?.();
	pi.events.emit(OBSERVER_EVENT, snapshot({ runId: "run-2", revision: 2, generation: "gen-2", elapsedMs: 200, tasks: [task({ role: "worker", elapsedMs: 200 })] }));
	await openWith(pi, ctx);
	const fresh = held.overlay?.render(120).join("\n") ?? "";
	assert.match(fresh, /batch 2 · run run-… · running/);
	assert.match(fresh, /● worker t2\s+running\s+200ms/);
	assert.doesNotMatch(fresh, /stale|unknown/);
});

test("foreign owners and stale revisions cannot repaint an open panel", async () => {
	const pi = install();
	const held: { overlay?: SubagentsOverlay } = {};
	const ctx = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 1, tasks: [task({ headline: "kept headline" })] }));
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 2, parentSessionId: "parent_session-2", anchor: "leaf_entry-2", tasks: [task({ headline: "foreign headline" })] }));
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 0, tasks: [task({ headline: "old headline" })] }));
	await openWith(pi, ctx);
	let rendered = held.overlay?.render(120).join("\n") ?? "";
	assert.match(rendered, /kept headline/);
	assert.doesNotMatch(rendered, /foreign headline|old headline/);
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 2, phase: "settled", activeChildren: 0, settledTasks: 1, tasks: [settledTask({ headline: "kept headline" })] }));
	pi.events.emit(OBSERVER_EVENT, snapshot({ revision: 3, phase: "running", tasks: [task({ headline: "resurrected headline" })] }));
	rendered = held.overlay?.render(120).join("\n") ?? "";
	assert.match(rendered, /kept headline/);
	assert.doesNotMatch(rendered, /resurrected headline/);
});

test("session start and shutdown clear retained observations and the widget", async () => {
	const pi = install({ enableWidget: true });
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const ctx = context({ statuses, widgets });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	assert.equal(statuses.length, 2);
	await pi.handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1)?.lines, undefined);
	const held: { overlay?: SubagentsOverlay } = {};
	const reopen = captureCtx(held);
	await pi.handlers.get("session_start")?.({}, reopen);
	await openWith(pi, reopen);
	assert.match(held.overlay?.render(120).join("\n") ?? "", new RegExp(EMPTY_OBSERVER_MESSAGE));
});

test("narrow terminals wrap folded-out routes and page with honest markers", () => {
	const overlay = new SubagentsOverlay(
		{ snapshot: snapshot({ tasks: [settledTask({ route: { provider: "fixture", model: "long-model-name-that-must-wrap", thinking: "max" } })] }), receivedAt: 0 },
		{ terminal: { rows: 30 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const folded = overlay.render(40);
	assert.equal(folded.join("\n").includes("long-model"), false, "folded group hides routes at narrow widths too");
	overlay.handleInput("enter");
	const wrapped = overlay.render(40).join("\n");
	assert.match(wrapped, /long-model-name-that-must-wrap/);
	assert.match(wrapped, /thinking:max/);
	const paged = overlay.render(40, 3);
	overlay.handleInput("\u001b[6~");
	const after = overlay.render(40, 3);
	assert.notDeepEqual(after, paged);
	assert.equal(after.some(line => line.trimStart().startsWith("↑ ") || line.trimStart().startsWith("↓ ")), true);
	overlay.handleInput("down");
	overlay.handleInput("up");
	overlay.handleInput("\u001b[5~");
	assert.ok(overlay.render(40, 3).length > 0);
});
