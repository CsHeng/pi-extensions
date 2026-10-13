import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { registerGoalUi } from "../extensions/workflow/goal-ui.ts";
test("default task visibility, show/hide/list and rendering never change task records", async () => {
 let command: any, widget: any; let listed = false;
 const store = createGoalStore(() => {});
 const pi = { registerCommand(_name: string, value: unknown) { command = value; } } as unknown as ExtensionAPI;
 const ctx = { mode: "tui", hasUI: true, ui: { setWidget(_key: string, value: unknown) { widget = value; }, async select(_title: string, rows: string[]) { listed = true; assert.match(rows.join("\n"), /Task/); } } } as unknown as ExtensionContext;
 const ui = registerGoalUi(pi, store); ui.attach(ctx); assert.equal(widget, undefined);
 store.mutate({ operation: "set", goal: "Fixture", tasks: [{ id: "a", title: "Task" }] }); assert.equal(typeof widget, "function");
 const before = store.current(); await command.handler("hide", ctx); assert.equal(widget, undefined);
 store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing" }] }); assert.equal(widget, undefined);
 await command.handler("show", ctx); assert.equal(typeof widget, "function"); await command.handler("list", ctx); assert.equal(listed, true);
 assert.equal(store.current()!.revision, before!.revision + 1);
 assert.equal((widget as unknown as (tui: unknown) => { render(width: number): string[] })({ terminal: { rows: 6 } }).render(80).length, 3);
 store.replay([]); assert.equal(widget, undefined); ui.detach();
});
for (const mode of ["rpc", "print", "json"]) test(mode + " mounts no task UI", () => {
 const ui = registerGoalUi({ registerCommand() {} } as unknown as ExtensionAPI, createGoalStore(() => {}));
 ui.attach({ mode, hasUI: true, ui: { setWidget() { assert.fail("headless view"); } } } as unknown as ExtensionContext); ui.detach();
});
test("view failure cannot roll back recorded tasks", () => {
 const store = createGoalStore(() => {});
 const ui = registerGoalUi({ registerCommand() {} } as unknown as ExtensionAPI, store);
 ui.attach({ mode: "tui", hasUI: true, ui: { setWidget() { throw new Error("UI failed"); } } } as unknown as ExtensionContext);
 assert.equal(store.mutate({ operation: "set", goal: "Fixture", tasks: [{ id: "a", title: "Task" }] }).ok, true);
 assert.equal(store.current()!.tasks.length, 1); ui.detach();
});
