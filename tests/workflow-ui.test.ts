import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import workflowExtension from "./fixtures/workflow/legacy-extension.ts";
import { WORKFLOW_ENTRY_TYPE, type WorkflowOperation } from "../extensions/workflow/contracts.ts";
import { createWorkflowStore, type SessionEntryLike } from "../extensions/workflow/store.ts";
import { registerWorkflowUi, WORKFLOW_WIDGET_KEY } from "../extensions/workflow/ui.ts";

const clock = { now: "2026-09-17T00:00:00.000Z", cwd: "/fixture", sessionId: "fixture" };
const open: Extract<WorkflowOperation, { operation: "open" }> = {
	operation: "open", expectedRevision: 0, goal: "UI goal", deliveryEndpoint: "source",
	criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
	tasks: [{ key: "t", outcome: "Task outcome", covers: ["c"] }],
};
type Command = { handler(args: string, ctx: ExtensionContext): Promise<void> | void };

function fixture(mode = "tui") {
	const entries: SessionEntryLike[] = [];
	let appendFails = false;
	const store = createWorkflowStore({ append(customType, data) {
		if (appendFails) throw new Error("fixture disk failure");
		entries.push({ type: "custom", customType, data });
	} });
	let renders = 0;
	let mounts = 0;
	let removals = 0;
	let renderFails = false;
	let mountFails = false;
	let drawFails = false;
	let widget: Component | undefined;
	let list: Component | undefined;
	const notices: string[] = [];
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const theme = { fg: (_color: string, text: string) => { if (drawFails) throw new Error("theme failure"); return text; }, bg: (_color: string, text: string) => text, strikethrough: (text: string) => text } as Theme;
	const terminal = { rows: 40, columns: 100 };
	const tui = { terminal, requestRender() { if (renderFails) throw new Error("render failure"); renders += 1; } } as TUI;
	const ctx = {
		mode, hasUI: mode === "tui", cwd: clock.cwd,
		sessionManager: { getSessionId: () => clock.sessionId, getBranch: () => entries },
		ui: {
			theme,
			setWidget(key: string, factory: undefined | ((tui: TUI, theme: Theme) => Component), options: { placement: string }) {
				assert.equal(key, WORKFLOW_WIDGET_KEY);
				if (!factory) { removals += 1; widget = undefined; return; }
				if (mountFails) throw new Error("mount failure");
				assert.equal(options.placement, "aboveEditor");
				mounts += 1; widget = factory(tui, theme);
			},
			custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => Component) {
				return new Promise<void>((resolve) => {
					list = factory(tui, theme, {}, () => { list = undefined; resolve(); });
				});
			},
			notify(message: string) { notices.push(message); },
			setFooter() { assert.fail("workflow does not own the footer"); },
			setWorkingMessage() { assert.fail("workflow does not own the working row"); },
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerTool() {},
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendUserMessage() { assert.fail("view controls never send model input"); },
	} as unknown as ExtensionAPI;
	let call = 0;
	return {
		store, entries, pi, ctx, tui, terminal, notices,
		get widget() { return widget; }, get list() { return list; },
		get mounts() { return mounts; }, get renders() { return renders; }, get removals() { return removals; },
		failAppend(value: boolean) { appendFails = value; }, failRender() { renderFails = true; }, failMount() { mountFails = true; }, failDraw() { drawFails = true; },
		async emit(name: string, event = {}, context = ctx) { for (const handler of handlers.get(name) ?? []) await handler(event, context); },
		async command(args: string) { await commands.get("workflow-ui")!.handler(args, ctx); },
		apply(operation: WorkflowOperation) {
			const result = store.apply(operation, clock, `ui-${++call}`);
			assert.ok(result.ok, result.ok ? "" : result.message);
			return result;
		},
	};
}

test("store observers see only committed projections, plus valid/empty/failed replay", () => {
	const f = fixture();
	const seen: Array<{ revision: number | undefined; error: string | undefined }> = [];
	const unsubscribe = f.store.subscribe(() => {
		seen.push({ revision: f.store.current()?.revision, error: f.store.recovery() });
		if (f.store.current()) assert.equal((f.entries.at(-1)!.data as { revision: number }).revision, f.store.current()!.revision);
	}, () => assert.fail("observer should not fail"));
	f.apply(open);
	assert.equal(seen.length, 1);
	f.store.apply(open, clock, "ui-1"); // replayed tool call
	f.store.apply({ operation: "inspect" }, clock, "inspect");
	f.store.apply({ operation: "pause", expectedRevision: 0, reason: "stale" }, clock, "stale");
	f.failAppend(true);
	f.store.apply({ operation: "pause", expectedRevision: 1, reason: "failed append" }, clock, "failed");
	assert.equal(seen.length, 1);
	f.store.replay(f.entries);
	assert.equal(seen.length, 2);
	f.store.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: {} }]);
	assert.equal(seen.at(-1)?.revision, undefined);
	assert.match(seen.at(-1)?.error ?? "", /schema/);
	f.store.replay([]);
	assert.deepEqual(seen.at(-1), { revision: undefined, error: undefined });
	unsubscribe(); f.store.replay([]);
	assert.equal(seen.length, 4);
});

test("observer failure and failure to report it cannot turn committed work into a failure", () => {
	const f = fixture(); let errors = 0; let healthy = 0;
	f.store.subscribe(() => { throw new Error("observer failure"); }, () => { errors += 1; throw new Error("notification unavailable"); });
	f.store.subscribe(() => { healthy += 1; }, () => assert.fail());
	f.apply(open);
	f.apply({ operation: "pause", expectedRevision: 1, reason: "done" });
	assert.equal(errors, 1); assert.equal(healthy, 2);
	assert.equal(f.store.current()?.revision, 2); assert.equal(f.entries.length, 2);
});

test("one mounted widget updates across tool, input, review, evidence and branch mutations", () => {
	const f = fixture(); const ui = registerWorkflowUi(f.pi, f.store); ui.attach(f.ctx);
	assert.equal(f.mounts, 0);
	f.apply(open);
	const widget = f.widget!;
	const mutate = (operation: WorkflowOperation) => {
		const before = f.renders; f.apply(operation);
		assert.equal(f.renders, before + 1); assert.equal(f.widget, widget);
	};
	mutate({ operation: "start", expectedRevision: 1, taskId: "T-1", basis: { fingerprint: "fp", fingerprintState: "current" } });
	assert.match(widget.render(100).join("\n"), /◐.*Task outcome/);
	mutate({ operation: "record", expectedRevision: 2, attemptId: f.store.current()!.tasks["T-1"]!.currentAttemptId!, attempt: { state: "reported", outcome: "checked" }, evidence: {
		provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, fingerprint: "fp", fingerprintState: "current", checkIdentity: "check", result: "pass",
	} });
	assert.match(widget.render(100).join("\n"), /awaiting acceptance/);
	mutate({ operation: "assess", expectedRevision: 3, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "checked" });
	assert.match(widget.render(100).join("\n"), /1\/1 accepted/);
	mutate({ operation: "refresh", expectedRevision: 4, fingerprints: { "EV-1": "changed" } });
	assert.match(widget.render(100).join("\n"), /0\/1 accepted/);
	mutate({ operation: "delivered", expectedRevision: 5 });
	assert.match(widget.render(100).join("\n"), /alignment/);
	mutate({ operation: "align", expectedRevision: 6, inputGeneration: 1, action: "confirm" });
	mutate({ operation: "review", expectedRevision: 7, action: "blocked", fingerprint: "fp", reason: "fixture" });
	mutate({ operation: "branch_reset", expectedRevision: 8, reason: "fixture branch", align: true });
	assert.equal(f.mounts, 1); assert.equal(f.notices.length, 0);
});

test("view commands, resize and scrolling do not mutate the ledger or input credit", async () => {
	const f = fixture(); const ui = registerWorkflowUi(f.pi, f.store); ui.attach(f.ctx);
	f.apply({ ...open, tasks: Array.from({ length: 30 }, (_, i) => ({ key: `t${i}`, outcome: `TASK_${i}`, covers: ["c"] })) });
	const before = structuredClone(f.store.current()); const writes = f.entries.length;
	await f.command("");
	assert.ok(f.widget!.render(100).length <= 3);
	await f.command("");
	assert.ok(f.widget!.render(100).length > 3);
	await f.command("hide"); assert.equal(f.widget, undefined);
	await f.command("show"); assert.ok(f.widget);
	const opened = f.command("list");
	const first = f.list!.render(100).join("\n");
	f.list!.handleInput!("\u001b[6~");
	assert.notEqual(f.list!.render(100).join("\n"), first);
	f.terminal.rows = 10;
	assert.ok(f.list!.render(25).length <= 8);
	f.list!.handleInput!("\u001b"); await opened;
	assert.equal(f.list, undefined);
	await f.command("nonsense");
	assert.deepEqual(f.store.current(), before); assert.equal(f.entries.length, writes);
});

for (const mode of ["rpc", "json", "print"]) test(`${mode} never mounts a widget or custom UI`, async () => {
	const f = fixture(mode); const ui = registerWorkflowUi(f.pi, f.store); ui.attach(f.ctx);
	f.apply(open);
	await f.command("show"); await f.command("list");
	assert.equal(f.mounts, 0); assert.equal(f.renders, 0); assert.equal(f.list, undefined);
	ui.detach(); assert.equal(f.removals, 0);
});

for (const failure of ["mount", "refresh", "draw"] as const) test(`UI ${failure} failure leaves the committed operation successful and disables the view`, () => {
	const f = fixture(); const ui = registerWorkflowUi(f.pi, f.store); ui.attach(f.ctx);
	if (failure === "mount") f.failMount();
	f.apply(open);
	if (failure === "refresh") { f.failRender(); f.apply({ operation: "pause", expectedRevision: 1, reason: "fixture" }); }
	if (failure === "draw") { f.failDraw(); assert.deepEqual(f.widget!.render(100), []); }
	assert.equal(f.notices.length, 1); assert.match(f.notices[0]!, /view disabled/);
	assert.equal(f.widget, undefined);
	assert.equal(f.entries.length, failure === "refresh" ? 2 : 1);
	assert.equal(f.store.current()?.revision, f.entries.length);
	f.store.replay(f.entries); assert.equal(f.notices.length, 1);
});

test("detach clears old components and subscriptions before replay; corrupt recovery cannot show old tasks", async () => {
	const f = fixture(); const ui = registerWorkflowUi(f.pi, f.store); ui.attach(f.ctx); f.apply(open);
	const oldWidget = f.widget!; const opened = f.command("list"); const oldList = f.list!;
	ui.detach(); await opened;
	assert.equal(f.widget, undefined); assert.equal(f.list, undefined);
	assert.deepEqual(oldWidget.render(100), []); assert.deepEqual(oldList.render(100), []);
	const paints = f.renders;
	f.store.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: {} }]);
	assert.equal(f.renders, paints);
	ui.attach(f.ctx);
	const recovery = f.widget!.render(100).join("\n");
	assert.match(recovery, /unavailable/); assert.doesNotMatch(recovery, /Task outcome/);
	ui.detach(); f.store.replay([]); ui.attach(f.ctx);
	assert.equal(f.widget, undefined);
	await f.emit("session_shutdown");
	f.store.replay(f.entries); assert.equal(f.widget, undefined);
});

test("extension session/tree hooks attach only the reconciled owner and discard abandoned rows", async () => {
	const f = fixture(); f.apply(open); f.apply({ operation: "start", expectedRevision: 1, taskId: "T-1" });
	workflowExtension(f.pi);
	await f.emit("session_start", { reason: "resume" });
	assert.ok(f.widget); assert.doesNotMatch(f.widget.render(100).join("\n"), /◐/);
	const priorWidget = f.widget;
	f.entries.splice(0);
	await f.emit("session_tree");
	assert.equal(f.widget, undefined); assert.deepEqual(priorWidget.render(100), []);
	assert.equal(f.entries.length, 0, "empty branch produces no extra workflow or UI snapshot");
});
