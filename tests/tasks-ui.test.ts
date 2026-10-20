import assert from "node:assert/strict";
import { captureListOverlay } from "./helpers/list-overlay.ts";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ABOVE_EDITOR_WIDGET_KEY, createAboveEditor, sharedAboveEditor } from "../extensions/shared/above-editor.ts";
import { createTasksUi } from "../extensions/tasks-ui/index.ts";
import { taskRows } from "../extensions/tasks-ui/render.ts";
import workflow from "../extensions/tasklist/index.ts";
import { createTasklistStore } from "../extensions/tasklist/goal-store.ts";
import { registerTasksView, TASKS_VIEW_EVENT, TASKS_VIEW_REQUEST_EVENT, TASKS_VIEW_RESET_EVENT, TASKS_VIEW_VERSION } from "../extensions/tasklist/tasks-view.ts";

function harness(mode = "tui") {
 const listeners = new Map<string, Array<(data: unknown) => void>>();
 const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
 const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
 const tools: string[] = [];
 let widget: unknown;
 let key = "";
 let selects = 0;
 let selected: string[] = [];
 const events = { on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
  emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); } };
 const pi = { registerCommand(name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, value.handler); }, registerTool(tool: { name: string }) { tools.push(tool.name); }, getActiveTools: () => tools, appendEntry() {}, sendUserMessage() { throw new Error("wake"); },
  on(name: string, fn: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, events } as unknown as ExtensionAPI;
 const ctx = { mode, hasUI: true, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "session-a", getLeafId: () => "leaf-a", getBranch: () => [{ id: "leaf-a" }] },
  ui: { setWidget(next: string, value: unknown) { key = next; widget = value; }, notify() {}, custom: captureListOverlay(rows => { selects += 1; selected = rows; }) } } as unknown as ExtensionContext;
 return { pi, ctx, commands, tools, events, get widget() { return widget; }, get key() { return key; }, get selects() { return selects; }, get selected() { return selected; }, fire(name: string, next = ctx) { for (const fn of handlers.get(name) ?? []) fn({}, next); } };
}
function lines(widget: unknown, rows = 24, width = 80): string[] {
 return (widget as (tui: unknown) => { render(width: number): string[] })({ terminal: { rows } }).render(width);
}

test("fold summary distinguishes done from cancelled and reports blocked items without runtime-control state", async () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 const composer = createAboveEditor();
 createTasksUi({ composer })(h.pi);
 view.bind(h.ctx); h.fire("session_start");
 store.mutate({ operation: "set", title: "Visible progress", tasks: [{ id: "a", title: "Completed task", status: "done" }, { id: "b", title: "Removed method", status: "cancelled" }] });
 await h.commands.get("tasks-ui")!("collapse", h.ctx);
 const folded = lines(h.widget);
 assert.equal(folded.length, 2);
 assert.match(folded[0]!, /1\/2 done · 1 cancelled/);
 assert.doesNotMatch(folded.join("\n"), /Completed task|Removed method|Visible progress/);
 await h.commands.get("tasks-ui")!("hide", h.ctx);
 store.mutate({ operation: "update", tasks: [{ id: "a", note: "still hidden" }] });
 assert.equal(h.widget, undefined);
 assert.equal(h.selects, 0);
 await h.commands.get("tasks-ui")!("show", h.ctx);
 assert.equal(lines(h.widget).filter(Boolean).length, 1);
 const beforeExpand = h.selects;
 await h.commands.get("tasks-ui")!("expand", h.ctx);
 assert.equal(h.selects, beforeExpand);
 assert.match(lines(h.widget).join("\n"), /▾/);
 assert.match(lines(h.widget).join("\n"), /Completed task/);
 store.mutate({ operation: "update", tasks: [{ id: "a", title: "Updated task" }] });
 assert.equal(h.selects, beforeExpand);
 assert.match(lines(h.widget).join("\n"), /Updated task/);
 assert.match(lines(h.widget).join("\n"), /▾/);
 await h.commands.get("tasks-ui")!("list", h.ctx);
 assert.match(h.selected.join("\n"), /Updated task/);
 assert.match(lines(h.widget).join("\n"), /Updated task/);
 // A blocked item is item data: it is reported, and no list-level pause/resume row can appear.
 store.mutate({ operation: "update", tasks: [{ id: "b", status: "blocked", note: "Need a decision" }] });
 await h.commands.get("tasks-ui")!("collapse", h.ctx);
 assert.match(lines(h.widget)[0]!, /! blocked/);
 assert.doesNotMatch(lines(h.widget)[0]!, / · done/);
 assert.doesNotMatch(lines(h.widget).join("\n"), /paused|resumed/);
 assert.doesNotMatch(lines(h.widget).join("\n"), /Updated task/);
 view.unbind();
});
test("unavailable, foreign, and stale replies are not a successful empty list", async () => {
 const h = harness();
 const composer = createAboveEditor();
 let requestId = "";
 h.events.on(TASKS_VIEW_REQUEST_EVENT, data => { requestId = (data as { requestId: string }).requestId; });
 createTasksUi({ composer, setTimer: () => 0, clearTimer() {} })(h.pi);
 h.fire("session_start");
 assert.equal(h.widget, undefined);
 const first = requestId;
 h.events.emit(TASKS_VIEW_EVENT, { version: TASKS_VIEW_VERSION, requestId: first, ownerSessionId: "session-a", anchor: "other-leaf", generation: "1", availability: "ready", state: { revision: 1, title: "Other", tasks: [{ id: "y", title: "Other branch", status: "todo" }] } });
 assert.equal(h.widget, undefined);
 h.events.emit(TASKS_VIEW_RESET_EVENT, { version: TASKS_VIEW_VERSION, generation: "2", ownerSessionId: "session-a", anchor: "leaf-a" });
 const second = requestId;
 h.events.emit(TASKS_VIEW_EVENT, { version: TASKS_VIEW_VERSION, requestId: second, ownerSessionId: "other-session", anchor: "leaf-a", generation: "2", availability: "ready", state: { revision: 1, title: "Foreign", tasks: [{ id: "x", title: "Foreign title", status: "done" }] } });
 assert.equal(h.widget, undefined);
 h.events.emit(TASKS_VIEW_RESET_EVENT, { version: TASKS_VIEW_VERSION, generation: "3", ownerSessionId: "session-a", anchor: "leaf-a" });
 h.events.emit(TASKS_VIEW_EVENT, { version: TASKS_VIEW_VERSION, requestId, ownerSessionId: "session-a", anchor: "leaf-a", generation: "3", availability: "ready", state: { revision: 3, title: "Fixture", tasks: [{ id: "a", title: "Owned task", status: "todo" }] } });
 assert.match(lines(h.widget).join("\n"), /▸ Tasks/);
 assert.doesNotMatch(lines(h.widget).join("\n"), /Owned task|Foreign title|Other branch/);
 h.events.emit(TASKS_VIEW_EVENT, { version: TASKS_VIEW_VERSION, requestId: first, ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", state: { revision: 1, title: "Old", tasks: [{ id: "z", title: "Stale title", status: "done" }] } });
 assert.doesNotMatch(lines(h.widget).join("\n"), /Stale title|Owned task/);
 assert.match(lines(h.widget).join("\n"), /▸ Tasks/);
});
test("tasklist-ui remains a show/hide/list alias and does not keep a second renderer", async () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 createTasksUi({ composer: createAboveEditor() })(h.pi);
 view.bind(h.ctx); h.fire("session_start");
 store.mutate({ operation: "set", title: "Fixture", tasks: [{ id: "a", title: "Task" }] });
 await h.commands.get("tasklist-ui")!("expand", h.ctx);
 assert.equal(h.widget, undefined);
 await h.commands.get("tasklist-ui")!("show", h.ctx);
 assert.match(lines(h.widget).join("\n"), /Task/);
 let title = "";
 h.ctx.ui.custom = captureListOverlay(rows => { title = rows.join("\n"); assert.match(title, /Task/); });
 await h.commands.get("tasklist-ui")!("list", h.ctx);
 assert.match(title, /Tasklist/);
 assert.equal(h.key, ABOVE_EDITOR_WIDGET_KEY);
 view.unbind();
});
test("session shutdown releases the tasks slot and its listeners", () => {
 const h = harness();
 let cleared = 0;
 createTasksUi({ composer: createAboveEditor(), setTimer: () => 1, clearTimer() { cleared += 1; } })(h.pi);
 let requestId = "";
 h.events.on(TASKS_VIEW_REQUEST_EVENT, data => { requestId = (data as { requestId: string }).requestId; });
 h.fire("session_start");
 h.events.emit(TASKS_VIEW_EVENT, { version: TASKS_VIEW_VERSION, requestId, ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", state: { revision: 1, title: "Live", tasks: [{ id: "a", title: "Live task", status: "todo" }] } });
 assert.equal(typeof h.widget, "function");
 h.fire("session_shutdown");
 assert.equal(h.widget, undefined);
 assert.equal(cleared > 0, true);
 const before = h.key;
 h.events.emit(TASKS_VIEW_EVENT, { version: TASKS_VIEW_VERSION, requestId: "late", ownerSessionId: "session-a", anchor: "leaf-a", generation: "1", availability: "ready", state: { revision: 1, title: "After", tasks: [{ id: "a", title: "After shutdown", status: "todo" }] } });
 assert.equal(h.widget, undefined);
 assert.equal(h.key, before);
 assert.doesNotMatch(String(h.widget), /After shutdown/);
});
test("headless tasks-ui mounts nothing and does not disable workflow", () => {
 const h = harness("print");
 workflow(h.pi);
 createTasksUi({ composer: createAboveEditor() })(h.pi);
 h.fire("session_start");
 assert.equal(h.tools.includes("tasklist"), true);
 assert.equal(h.tools.includes("csheng_workflow"), false, "no legacy duplicate tool remains");
 assert.equal(h.widget, undefined);
 assert.equal(h.key, "");
});
test("above-editor helper keeps Tasks, Jobs, Subagents order and isolates removal", () => {
 const composer = createAboveEditor();
 let widget: unknown;
 let key = "";
 const ctx = { mode: "tui", hasUI: true, ui: { setWidget(next: string, value: unknown) { key = next; widget = value; } } };
 composer.attach(ctx);
 composer.set("subagents", { render: () => ["Subagents"] });
 composer.set("tasks", { render: () => ["Tasks"] });
 composer.set("jobs", { render: () => ["Jobs"] });
 assert.equal(key, ABOVE_EDITOR_WIDGET_KEY);
 assert.deepEqual(lines(widget), ["Tasks", "", "Jobs", "", "Subagents", ""]);
 composer.set("jobs", undefined);
 assert.deepEqual(lines(widget), ["Tasks", "", "Subagents", ""]);
 composer.set("tasks", { render() { throw new Error("tasks failed"); } });
 assert.deepEqual(lines(widget), ["Subagents", ""]);
 assert.deepEqual(composer.slots(), ["tasks", "subagents"]);
 composer.set("tasks", undefined);
 assert.deepEqual(lines(widget), ["Subagents", ""]);
 composer.set("subagents", undefined);
 assert.equal(widget, undefined);
 assert.deepEqual(composer.slots(), []);
});
test("collapsed blocked state stays a warning and the expanded oracle still has its fields", () => {
 const blocked = taskRows({ state: { version: 6, revision: 1, title: "Hold", tasks: [{ id: "c", title: "Waiting", status: "blocked", note: "Needs input" }] } }, 80, 4, undefined, { folded: true });
 assert.equal(blocked.length, 1);
 assert.match(blocked[0]!, /! blocked · Tasks/);
 assert.doesNotMatch(blocked[0]!, /Waiting/);
 const expanded = taskRows({ state: { version: 6, revision: 1, title: "Hold", tasks: [{ id: "c", title: "Waiting", status: "blocked", note: "Needs input" }] } }, 80, 4);
 assert.match(expanded.join("\n"), /Waiting/);
 assert.match(expanded.join("\n"), /Needs input/);
});

function clickHeader(widget: unknown, y = 0, mode: "fullscreen" | "regular" = "fullscreen") {
 const view = (widget as (tui: unknown) => { render(width: number): string[]; handleMouse?(event: unknown): { focus?: boolean } | undefined })({ mode, terminal: { rows: 24 } });
 view.render(80);
 view.handleMouse?.({ type: "press", button: "left", x: 1, y, width: 80, height: 8 });
 return view.handleMouse?.({ type: "click", button: "left", x: 1, y, width: 80, height: 8 });
}

test("co-loaded extensions share one above-editor widget", () => {
 const listeners = new Map<string, Array<(data: unknown) => void>>();
 const facade = () => ({
  on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; },
  emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
 });
 const first = sharedAboveEditor({ events: facade() } as unknown as ExtensionAPI);
 const second = sharedAboveEditor({ events: facade() } as unknown as ExtensionAPI);
 assert.equal(first, second);
 let widget: unknown;
 first.attach({ mode: "tui", hasUI: true, ui: { setWidget(_key: string, value: unknown) { widget = value; } } });
 first.set("tasks", { render: () => ["▸ Tasks (1/1 done)"] });
 second.set("subagents", { render: () => ["▸ Subagents (1 running / 2 agents)"] });
 const rendered = (widget as (tui: unknown) => { render(width: number): string[] })({ mode: "fullscreen", terminal: { rows: 24 } }).render(80);
 assert.match(rendered.join("\n"), /Tasks/);
 assert.match(rendered.join("\n"), /Subagents/);
});
test("fullscreen header click toggles Tasks inline and does not open a dialog", async () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 createTasksUi({ composer: createAboveEditor() })(h.pi);
 view.bind(h.ctx); h.fire("session_start");
 store.mutate({ operation: "set", title: "Visible progress", tasks: [{ id: "a", title: "Completed task", status: "done" }] });
 assert.match(lines(h.widget).join("\n"), /▸ Tasks/);
 assert.doesNotMatch(lines(h.widget).join("\n"), /Completed task/);
 const before = h.selects;
 const pressed = clickHeader(h.widget);
 assert.equal(pressed?.focus, undefined);
 assert.equal(h.selects, before);
 assert.match(lines(h.widget).join("\n"), /▾/);
 assert.match(lines(h.widget).join("\n"), /Completed task/);
 clickHeader(h.widget, 1);
 assert.equal(h.selects, before);
 assert.match(lines(h.widget).join("\n"), /Completed task/);
 clickHeader(h.widget);
 assert.equal(h.selects, before);
 assert.match(lines(h.widget).join("\n"), /▸ Tasks/);
 assert.doesNotMatch(lines(h.widget).join("\n"), /Completed task/);
 clickHeader(h.widget, 0, "regular");
 assert.equal(h.selects, before);
 assert.doesNotMatch(lines(h.widget).join("\n"), /Completed task/);
 view.unbind();
});
