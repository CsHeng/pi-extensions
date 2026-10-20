import assert from "node:assert/strict";
import { captureListOverlay } from "./helpers/list-overlay.ts";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAboveEditor } from "../extensions/shared/above-editor.ts";
import { createTasksUi } from "../extensions/tasks-ui/index.ts";
import { createTasklistStore } from "../extensions/tasklist/goal-store.ts";
import { registerTasksView } from "../extensions/tasklist/tasks-view.ts";

function harness(mode = "tui") {
 const listeners = new Map<string, Array<(data: unknown) => void>>();
 const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
 const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
 let widget: unknown;
 let listed: string[] = [];
 let widgets = 0;
 const events = { on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
  emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); } };
 const pi = { registerCommand(name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, value.handler); }, on(name: string, fn: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, events } as unknown as ExtensionAPI;
 const ctx = { mode, hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session-a", getLeafId: () => "leaf-a", getBranch: () => [{ id: "leaf-a" }] },
  ui: { setWidget(_key: string, value: unknown) { widgets += 1; widget = value; }, notify() {}, custom: captureListOverlay(rows => { listed = rows; }) } } as unknown as ExtensionContext;
 return { pi, ctx, commands, get widget() { return widget; }, get listed() { return listed; }, get widgets() { return widgets; }, fire(name: string, next = ctx) { for (const fn of handlers.get(name) ?? []) fn({}, next); } };
}
function render(widget: unknown, rows: number, width = 80): string[] {
 return (widget as (tui: unknown) => { render(width: number): string[] })({ terminal: { rows } }).render(width);
}

test("default task visibility, show/hide/list and rendering never change task records", async () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 const composer = createAboveEditor();
 createTasksUi({ composer })(h.pi);
 view.bind(h.ctx); h.fire("session_start");
 assert.equal(h.widget, undefined);
 store.mutate({ operation: "set", title: "Fixture", tasks: [{ id: "a", title: "Task" }] });
 assert.equal(typeof h.widget, "function");
 const before = store.current();
 await h.commands.get("tasks-ui")!("hide", h.ctx); assert.equal(h.widget, undefined);
 store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing" }] }); assert.equal(h.widget, undefined);
 await h.commands.get("tasks-ui")!("show", h.ctx); assert.equal(typeof h.widget, "function");
 await h.commands.get("tasks-ui")!("list", h.ctx);
 assert.match(h.listed.join("\n"), /Task/);
 assert.equal(render(h.widget, 6).filter(Boolean).length, 1);
 let selects = 0;
 h.ctx.ui.custom = captureListOverlay(() => { selects += 1; });
 await h.commands.get("tasks-ui")!("expand", h.ctx);
 assert.equal(selects, 0);
 assert.equal(render(h.widget, 6).length, 3);
 assert.equal(store.current()!.revision, before!.revision + 1);
 store.replay([]); assert.equal(h.widget, undefined);
 view.unbind();
});
for (const mode of ["rpc", "print", "json"]) test(mode + " mounts no task UI", () => {
 const h = harness(mode);
 createTasksUi({ composer: createAboveEditor() })(h.pi);
 h.fire("session_start");
 assert.equal(h.widgets, 0);
});
test("view failure cannot roll back recorded tasks", () => {
 const h = harness();
 h.ctx.ui.setWidget = () => { throw new Error("UI failed"); };
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 createTasksUi({ composer: createAboveEditor() })(h.pi);
 view.bind(h.ctx); h.fire("session_start");
 assert.equal(store.mutate({ operation: "set", title: "Fixture", tasks: [{ id: "a", title: "Task" }] }).ok, true);
 assert.equal(store.current()!.tasks.length, 1);
 view.unbind();
});
test("widget caps expanded rows at 120 columns and the terminal row allowance", async () => {
 const h = harness();
 const store = createTasklistStore(() => {});
 const view = registerTasksView(h.pi, store);
 createTasksUi({ composer: createAboveEditor() })(h.pi);
 view.bind(h.ctx); h.fire("session_start");
 store.mutate({ operation: "set", title: "G".repeat(200), tasks: Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: i === 9 ? "Important task" : "Older done", status: i === 9 ? "doing" as const : "done" as const })) });
 await h.commands.get("tasks-ui")!("expand", h.ctx);
 assert.deepEqual(h.listed, []);
 const wide = render(h.widget, 36, 200);
 assert.ok(wide.every(line => visibleWidth(line) <= 120));
 assert.match(wide.join("\n"), /Important task/);
 const tight = render(h.widget, 3, 80);
 assert.equal(tight.length, 2);
 assert.doesNotMatch(tight.join("\n"), /Important task/);
 view.unbind();
});
