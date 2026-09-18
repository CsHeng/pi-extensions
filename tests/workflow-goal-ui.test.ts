import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { registerGoalUi, goalRows } from "../extensions/workflow/goal-ui.ts";

test("optional v2 view is off by default and show/hide/list cannot mutate contract or dispatch", async () => {
 let command: any; let widget: any; let entries = 0; let selected = false;
 const store = createGoalStore(() => { entries++; });
 const pi = { registerCommand(_name: string, value: unknown) { command = value; }, sendUserMessage() { assert.fail("view must not dispatch"); } } as unknown as ExtensionAPI;
 const ctx = { mode: "tui", hasUI: true, ui: { setWidget(_key: string, value: unknown) { widget = value; }, async select() { selected = true; } } } as unknown as ExtensionContext;
 const ui = registerGoalUi(pi, store); ui.attach(ctx); assert.equal(widget, undefined);
 const result = await store.mutate({ operation: "enroll", goal: "fixture", delivery: "source", authority: "explicit fixture", requirements: [{ key: "r", outcome: "result", verification: "check" }] }, { cwd: process.cwd(), sessionId: "fixture", now: new Date().toISOString() }, "enroll");
 assert.equal(result.ok, true); assert.equal(widget, undefined);
 const before = store.current(); await command.handler("show", ctx); assert.equal(typeof widget, "function");
 const lines = (widget as unknown as () => { render(width: number): string[] })().render(8); assert.ok(lines.every(line => visibleWidth(line) <= 8));
 await command.handler("list", ctx); assert.equal(selected, true);
 await command.handler("hide", ctx); assert.equal(widget, undefined);
 ui.detach(); assert.deepEqual(store.current(), before); assert.equal(entries, 1);
});

for (const mode of ["rpc", "print", "json"]) test(`v2 ${mode} view mounts no widget`, () => {
 const ui = registerGoalUi({ registerCommand() {} } as unknown as ExtensionAPI, createGoalStore(() => {}));
 ui.attach({ mode, hasUI: true, ui: { setWidget() { assert.fail("headless view"); } } } as unknown as ExtensionContext); ui.detach();
});

test("v2 view failure does not fail a commit and rows remain bounded", async () => {
 const store = createGoalStore(() => {}); let writes = 0;
 const ui = registerGoalUi({ registerCommand() {} } as unknown as ExtensionAPI, store);
 ui.attach({ mode: "tui", hasUI: true, ui: { setWidget() { writes++; throw new Error("view unavailable"); } } } as unknown as ExtensionContext);
 const result = await store.mutate({ operation: "enroll", goal: "fixture", delivery: "source", authority: "fixture", requirements: [{ key: "r", outcome: "result", verification: "check" }], tasks: Array.from({ length: 64 }, (_, i) => ({ key: `t${i}`, title: `Task ${i}`, covers: ["r"] })) }, { cwd: process.cwd(), sessionId: "fixture", now: new Date().toISOString() }, "enroll");
 assert.equal(result.ok, true); assert.equal(writes, 2, "failed view stays disabled");
 assert.equal(goalRows(store.view(), 80).length, 12); assert.equal(goalRows(store.view(), 80, 66).length, 65);
 ui.detach();
});
