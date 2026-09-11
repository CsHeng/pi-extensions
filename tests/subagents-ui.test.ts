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
import { EMPTY_OBSERVER_MESSAGE, OBSERVER_STALE_MS, closeMarkerColumns } from "../extensions/subagents-ui/render.ts";

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
		...overrides,
	};
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

test("successive real publishers use generation-wide revisions and keep the shorter second run visible", async () => {
	const pi = install();
	let rendered = "";
	const ctx = context({ custom: async factory => {
		const overlay = factory({ requestRender() {} } as TUI, undefined, undefined, () => {}) as SubagentsOverlay;
		rendered = overlay.render(160).join("\n"); return null;
	} });
	await pi.handlers.get("session_start")?.({}, ctx);
	let revision = 0;
	for (const [run, beats] of [["first", 20], ["second", 0]] as const) {
		const observer = new ManagedObserver(run, { repo: "/fixture", parentSessionId: "parent_session-1", anchor: "leaf_entry-1", branch: ["leaf_entry-1"] }, "generation",
			[{ id: "task", role: "reviewer", episode: 1, replayed: false, route: { provider: "fixture", model: run, thinking: "off" } as never }], () => 0,
			value => pi.events.emit(OBSERVER_EVENT, value), () => ++revision);
		observer.begin(); observer.childStarted("task");
		for (let index = 0; index < beats; index++) observer.update([]);
		observer.childStopped("task"); observer.finish(false, false);
		await openWith(pi, ctx);
		assert.match(rendered, new RegExp(`fixture ${run} thinking:off`));
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

test("actual render(width) respects terminal cell width and derives a scrollable viewport", () => {
	const overlay = new SubagentsOverlay({ snapshot: snapshot({ tasks: [task({ route: { provider: "fixture", model: "宽模型".repeat(35), thinking: "high" } })] }), receivedAt: 0 },
		{ terminal: { rows: 10 }, requestRender() {} } as TUI, () => {}, { now: () => 0 });
	const first = overlay.render(16);
	assert.ok(first.length <= 8);
	assert.ok(first.every(line => visibleWidth(line) <= 16));
	overlay.handleInput("\u001b[6~");
	const second = overlay.render(16);
	assert.notDeepEqual(second, first);
	assert.ok(second.length <= 8);
	assert.ok(second.every(line => visibleWidth(line) <= 16));
});

test("default TUI snapshots never write widgets, status, footer, working, or entries", async () => {
	const pi = install();
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const working: Array<string | undefined> = [];
	const footers: unknown[] = [];
	const ctx = context({ statuses, widgets, working, footers });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	pi.events.emit(OBSERVER_EVENT, snapshot({ phase: "settled", activeChildren: 0, settledTasks: 1, revision: 1 }));
	assert.deepEqual(statuses, []);
	assert.deepEqual(widgets, []);
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
	assert.deepEqual(pi.entries, []);
	assert.ok(pi.shortcuts.has("ctrl+alt+f"));
	assert.ok(pi.commands.has(SUBAGENTS_UI_COMMAND));
});

test("registered command and shortcut open the overlay with route, counts, and no execution controls", async () => {
	const pi = install();
	let overlay: SubagentsOverlay | undefined;
	let customOptions: { overlay?: boolean } | undefined;
	let doneCount = 0;
	const tui = { requestRender() {} } as TUI;
	const ctx = context({
		custom: async (factory, options) => {
			customOptions = options as { overlay?: boolean };
			overlay = factory(tui, undefined, undefined, () => { doneCount += 1; }) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	await openWith(pi, ctx, "shortcut");
	assert.equal(customOptions?.overlay, true);
	assert.ok(overlay);
	const text = overlay.render(80).join("\n");
	assert.match(text, /running/);
	assert.match(text, /launched 1 running 1 finished 0/);
	assert.match(text, /openai/);
	assert.match(text, /gpt-4\.1/);
	assert.match(text, /thinking:off/);
	assert.match(text, /t2/);
	assert.match(text, /child-execution/);
	assert.match(text, /ctrl\+alt\+f close/);
	assert.match(text, /Subagents · running/);
	assert.match(text, /\[ ✕ \]/);
	assert.doesNotMatch(text, /cancel/i);
	const before = pi.events.emitted.length;
	overlay.handleInput("x");
	overlay.handleInput("R");
	overlay.handleInput("shift+r");
	assert.equal(pi.events.emitted.length, before);
	assert.equal(doneCount, 0);
	overlay.handleInput("escape");
	assert.equal(doneCount, 0);
	overlay.handleInput("ctrl+alt+f");
	assert.equal(doneCount, 1);
	await openWith(pi, ctx, "command");
	assert.ok(overlay);
});

test("content-fitted overlay options keep rows complete and expose one clickable close marker", async () => {
	const pi = install();
	let customOptions: { overlay?: boolean; overlayOptions?: { width?: unknown } } | undefined;
	let overlay: SubagentsOverlay | undefined;
	let doneCount = 0;
	const tui = { requestRender() {}, terminal: { columns: 200, rows: 40 } } as unknown as TUI;
	const ctx = context({
		custom: async (factory, options) => {
			customOptions = options as { overlay?: boolean; overlayOptions?: { width?: unknown } };
			overlay = factory(tui, undefined, undefined, () => { doneCount += 1; }) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({
		tasks: [task({ route: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" } })],
	}));
	await openWith(pi, ctx);
	assert.equal(customOptions?.overlay, true);
	const width = Number(customOptions?.overlayOptions?.width);
	assert.ok(width >= 80, "panel keeps its previous default width as a floor");
	assert.ok(width < 200, "panel must fit its content instead of filling the terminal");
	assert.ok(overlay);
	const lines = overlay.render(width);
	const first = lines[0] ?? "";
	assert.equal(visibleWidth(first), width);
	const chip = closeMarkerColumns(width);
	assert.ok(first.includes("[ ✕ ]"));
	assert.equal(visibleWidth(first.slice(0, first.indexOf("✕"))), chip.start + 2, "drawn marker sits inside the declared hit range");
	assert.ok(chip.end - chip.start >= 5, "close hit range is wider than the marker glyph");
	assert.ok(chip.end < width, "close hit range stays off the panel edge");
	assert.equal(lines.filter(line => line.includes("✕")).length, 1);
	assert.ok(lines.every(line => visibleWidth(line) === width), "every panel row fills the width");
	const taskRow = lines.find(line => line.includes("gpt-5.6-luna")) ?? "";
	assert.ok(taskRow.includes("ep0"), "a task row stays on one panel row");
	overlay.handleMouse({ type: "click", button: "left", x: chip.start - 1, y: 0 });
	overlay.handleMouse({ type: "click", button: "left", x: chip.start, y: 1 });
	overlay.handleMouse({ type: "wheel", button: "none", x: chip.start, y: 0 });
	overlay.handleMouse({ type: "click", button: "right", x: chip.start, y: 0 });
	assert.equal(doneCount, 0);
	assert.deepEqual(overlay.handleMouse({ type: "press", button: "left", x: chip.start, y: 0 }), { handled: true });
	assert.equal(doneCount, 0);
	overlay.handleMouse({ type: "click", button: "left", x: chip.end - 1, y: 0 });
	assert.equal(doneCount, 1);
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
		tasks: [task({ route: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" } })],
	}));
	const widened = Number(layout?.width);
	assert.ok(widened > 80 && widened < 200, `panel width ${widened} must grow with content without filling the terminal`);
	release?.();
	await opening;
});

test("panel width grows with observed content and themed rows stay edge to edge", () => {
	const tui = { requestRender() {} } as TUI;
	const overlay = new SubagentsOverlay({ snapshot: undefined, receivedAt: 0 }, tui, () => {}, { now: () => 0 });
	assert.equal(overlay.desiredWidth(200), 80);
	overlay.update({ snapshot: snapshot({ tasks: [task({ route: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" } })] }), receivedAt: 0 });
	const width = overlay.desiredWidth(200);
	assert.ok(width > 80 && width < 200, `busy panel width ${width} must fit content without filling the terminal`);
	const codes: Record<string, string> = { accent: "35", borderMuted: "34", dim: "90", text: "37" };
	const theme = {
		fg: (color: string, text: string) => `\u001b[${codes[color] ?? "37"}m${text}\u001b[39m`,
		bg: (color: string, text: string) => `\u001b[48;5;17m${text}\u001b[49m`,
	};
	const themed = new SubagentsOverlay({ snapshot: snapshot(), receivedAt: 0 }, tui, () => {}, { now: () => 0, theme });
	const lines = themed.render(width);
	assert.ok(lines.every(line => line.startsWith("\u001b[48;5;17m") && line.endsWith("\u001b[49m")));
	assert.ok(lines.every(line => visibleWidth(line) === width), "themed rows cover the whole panel");
	assert.equal(lines.filter(line => line.includes("✕")).length, 1);
	assert.ok((lines[0] ?? "").includes("\u001b[35m"), "title uses the accent color");
	assert.ok((lines[1] ?? "").includes("\u001b[34m"), "rule uses the border color");
	assert.ok(lines.some(line => line.includes("\u001b[90m")), "help uses the dim color");
});

test("optional widget opt-in still renders the retained panel without completion entries", async () => {
	const pi = install({ enableWidget: true });
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const working: Array<string | undefined> = [];
	const footers: unknown[] = [];
	const ctx = context({ statuses, widgets, working, footers });
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	assert.equal(statuses.at(-1)?.includes("launched 1 running 1 finished 0"), true);
	assert.equal(widgets.at(-1)?.key, SUBAGENTS_UI_PANEL_KEY);
	assert.equal(widgets.at(-1)?.lines?.some((line) => line.includes("gpt-4.1")), true);
	pi.events.emit(OBSERVER_EVENT, snapshot({ phase: "settled", activeChildren: 0, settledTasks: 1, revision: 1 }));
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1)?.lines, undefined);
	assert.deepEqual(working, []);
	assert.deepEqual(footers, []);
	assert.deepEqual(pi.entries, []);
});

test("headless modes ignore snapshots, overlays, and repaint intervals", async () => {
	const scheduler = new FakeScheduler();
	let now = 0;
	const pi = install({
		now: () => now,
		setInterval: (callback) => scheduler.setInterval(callback),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	});
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	let customCalls = 0;
	const ctx = context({
		mode: "rpc",
		statuses,
		widgets,
		custom: async () => {
			customCalls += 1;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	pi.events.emit(OBSERVER_EVENT, { version: 1, prompt: "SECRET" });
	await openWith(pi, ctx, "command");
	assert.equal(customCalls, 0);
	assert.deepEqual(statuses, []);
	assert.deepEqual(widgets, []);
	assert.equal(scheduler.setCount, 0);
});

test("late open shows current work; completed work stays viewable with frozen elapsed", async () => {
	let now = 1_000;
	const pi = install({ now: () => now });
	let overlay: SubagentsOverlay | undefined;
	const tui = { requestRender() {} } as TUI;
	const ctx = context({
		custom: async (factory) => {
			overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ elapsedMs: 4_000, tasks: [task({ elapsedMs: 4_000 })] }));
	now = 3_000;
	await openWith(pi, ctx);
	assert.match(overlay?.render(80).join("\n") ?? "", /6\.0s/);
	pi.events.emit(OBSERVER_EVENT, snapshot({
		revision: 1,
		phase: "settled",
		activeChildren: 0,
		settledTasks: 1,
		elapsedMs: 5_000,
		tasks: [task({ status: "succeeded", executionPhase: "settled", elapsedMs: 5_000 })],
	}));
	now = 20_000;
	await openWith(pi, ctx);
	const completed = overlay?.render(80).join("\n") ?? "";
	assert.match(completed, /settled/);
	assert.match(completed, /5\.0s/);
	assert.doesNotMatch(completed, /stale\/unknown/);
});

test("stale silence freezes elapsed as unknown instead of fake running, and does not block a fresh generation", async () => {
	let now = 0;
	const pi = install({ now: () => now });
	let overlay: SubagentsOverlay | undefined;
	const tui = { requestRender() {} } as TUI;
	const ctx = context({
		custom: async (factory) => {
			overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({ elapsedMs: 1_000, tasks: [task({ elapsedMs: 1_000 })] }));
	now = OBSERVER_STALE_MS + 1;
	await openWith(pi, ctx);
	const stale = overlay?.render(80).join("\n") ?? "";
	assert.match(stale, /stale\/unknown/);
	assert.match(stale, /running unknown/);
	assert.match(stale, /1\.0s/);
	assert.doesNotMatch(stale, /running child-execution/);
	pi.events.emit(OBSERVER_EVENT, snapshot({
		generation: "gen-2",
		runId: "run-2",
		revision: 0,
		elapsedMs: 200,
		aggregateAssistantTurns: 1,
		tasks: [task({
			id: "write",
			role: "worker",
			route: { provider: "openai", model: "gpt-4.1-mini", thinking: "low" },
			assistantTurns: 1,
			elapsedMs: 200,
		})],
	}));
	await openWith(pi, ctx);
	const fresh = overlay?.render(80).join("\n") ?? "";
	assert.match(fresh, /gpt-4\.1-mini/);
	assert.match(fresh, /thinking:low/);
	assert.match(fresh, /worker/);
	assert.doesNotMatch(fresh, /stale\/unknown/);
});

test("owner, branch, generation, and revision checks ignore foreign, reordered, and resurrected snapshots", async () => {
	let now = 0;
	const pi = install({ now: () => now });
	let overlay: SubagentsOverlay | undefined;
	const tui = { requestRender() {} } as TUI;
	const ctx = context({
		custom: async (factory) => {
			overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot({
		revision: 1,
		tasks: [task({ route: { provider: "openai", model: "kept-model", thinking: "high" } })],
	}));
	pi.events.emit(OBSERVER_EVENT, snapshot({
		revision: 0,
		tasks: [task({ route: { provider: "openai", model: "old-model", thinking: "off" } })],
	}));
	pi.events.emit(OBSERVER_EVENT, snapshot({
		generation: "gen-other",
		runId: "run-other",
		tasks: [task({ route: { provider: "openai", model: "busy-block", thinking: "off" } })],
	}));
	pi.events.emit(OBSERVER_EVENT, snapshot({
		parentSessionId: "other_session",
		tasks: [task({ route: { provider: "openai", model: "foreign-model", thinking: "off" } })],
	}));
	await openWith(pi, ctx);
	assert.match(overlay?.render(80).join("\n") ?? "", /kept-model/);
	pi.events.emit(OBSERVER_EVENT, snapshot({
		revision: 2,
		phase: "settled",
		activeChildren: 0,
		settledTasks: 1,
		tasks: [task({
			status: "succeeded",
			executionPhase: "settled",
			route: { provider: "openai", model: "kept-model", thinking: "high" },
		})],
	}));
	pi.events.emit(OBSERVER_EVENT, snapshot({
		revision: 1,
		phase: "running",
		tasks: [task({ route: { provider: "openai", model: "resurrected", thinking: "off" } })],
	}));
	await openWith(pi, ctx);
	const settled = overlay?.render(80).join("\n") ?? "";
	assert.match(settled, /kept-model/);
	assert.doesNotMatch(settled, /resurrected/);
	const branched = context({
		session: owner({ branch: ["other-leaf"], leafId: "other-leaf" }),
		custom: async (factory) => {
			overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_tree")?.({}, branched);
	await openWith(pi, branched);
	assert.match(overlay?.render(80).join("\n") ?? "", new RegExp(EMPTY_OBSERVER_MESSAGE));
});

test("session start and shutdown drop cached work and clean intervals", async () => {
	const scheduler = new FakeScheduler();
	let now = 0;
	const pi = install({
		now: () => now,
		setInterval: (callback) => scheduler.setInterval(callback),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	});
	let overlay: SubagentsOverlay | undefined;
	const tui = { requestRender() {} } as TUI;
	let release: (() => void) | undefined;
	const ctx = context({
		custom: (factory) => new Promise((resolve) => {
			release = () => resolve(null);
			overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
		}),
	});
	await pi.handlers.get("session_start")?.({}, ctx);
	pi.events.emit(OBSERVER_EVENT, snapshot());
	assert.equal(scheduler.setCount, 0);
	const opening = openWith(pi, ctx);
	assert.equal(scheduler.setCount, 1);
	pi.handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(scheduler.clearCount, 1);
	release?.();
	await opening;
	const emptyCtx = context({
		custom: async (factory) => {
			overlay = factory(tui, undefined, undefined, () => {}) as SubagentsOverlay;
			return null;
		},
	});
	await pi.handlers.get("session_start")?.({}, emptyCtx);
	await openWith(pi, emptyCtx);
	assert.match(overlay?.render(80).join("\n") ?? "", new RegExp(EMPTY_OBSERVER_MESSAGE));
});

test("narrow terminals wrap long model names and page keys scroll with overflow markers", async () => {
	const longModel = "very-long-model-name-that-must-remain-inspectable";
	const overlay = new SubagentsOverlay(
		{
			snapshot: snapshot({
				requestedTasks: 3,
				admittedTasks: 3,
				launchedChildren: 3,
				activeChildren: 3,
				aggregateAssistantTurns: 3,
				tasks: [
					task({ id: "a", ordinal: 1, route: { provider: "openai", model: longModel, thinking: "max" } }),
					task({ id: "b", ordinal: 2, role: "reviewer", route: { provider: "openai", model: longModel, thinking: "high" } }),
					task({ id: "c", ordinal: 3, role: "worker", route: { provider: "openai", model: longModel, thinking: "low" } }),
				],
			}),
			receivedAt: 0,
		},
		{ requestRender() {} } as TUI,
		() => {},
	);
	const wrapped = overlay.render(16).map(line => line.trim()).join("");
	assert.match(wrapped, new RegExp(longModel));
	assert.match(wrapped, /thinking:max/);
	const paged = overlay.render(40, 3);
	overlay.handleInput("\u001b[6~");
	const after = overlay.render(40, 3);
	assert.notDeepEqual(after, paged);
	assert.equal(after.some((line) => line.trimStart().startsWith("↑ ") || line.trimStart().startsWith("↓ ")), true);
	overlay.handleInput("down");
	overlay.handleInput("up");
	overlay.handleInput("\u001b[5~");
	assert.ok(overlay.render(40, 3).length > 0);
});
