import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { registerGoalUi, goalRows } from "../extensions/workflow/goal-ui.ts";

test("v2 view appears on enrollment by default and show/hide/list cannot mutate contract or dispatch", async () => {
 let command: any; let widget: any; let entries = 0; let selected = false;
 const store = createGoalStore(() => { entries++; });
 const pi = { registerCommand(_name: string, value: unknown) { command = value; }, sendUserMessage() { assert.fail("view must not dispatch"); } } as unknown as ExtensionAPI;
 const colors: string[] = [];
 const ctx = { mode: "tui", hasUI: true, ui: {
  theme: { fg(color: string, text: string) { colors.push(color); return text; }, strikethrough(text: string) { return text; } },
  setWidget(_key: string, value: unknown, options?: { placement: string }) { widget = value; if (value) assert.equal(options?.placement, "aboveEditor"); },
  async select(title: string, rows: string[]) { selected = true; assert.equal(title, "Tasks · workflow"); assert.match(rows.join("\n"), /● Tasks.*\(0\/1\)/); assert.doesNotMatch(rows.join("\n"), /Contract|continuation|input aligned/); },
 } } as unknown as ExtensionContext;
 const ui = registerGoalUi(pi, store); ui.attach(ctx); assert.equal(widget, undefined);
 const result = await store.mutate({ operation: "enroll", goal: "fixture", delivery: "source", authority: "explicit fixture", requirements: [{ key: "r", outcome: "result", verification: "check" }] }, { cwd: process.cwd(), sessionId: "fixture", now: new Date().toISOString() }, "enroll");
 assert.equal(result.ok, true); assert.equal(typeof widget, "function");
 const rendered = (widget as unknown as () => { render(width: number): string[] })().render(120);
 assert.deepEqual(rendered, ["● Tasks · fixture (0/1)", "└─ ○ r result", ""]);
 assert.ok(colors.includes("accent"));
 const before = store.current(); await command.handler("show", ctx); assert.equal(typeof widget, "function");
 const lines = (widget as unknown as () => { render(width: number): string[] })().render(8); assert.ok(lines.every(line => visibleWidth(line) <= 8));
 await command.handler("list", ctx); assert.equal(selected, true);
 await command.handler("hide", ctx); assert.equal(widget, undefined);
 await command.handler("", ctx); assert.equal(typeof widget, "function");
 await command.handler("", ctx); assert.equal(widget, undefined);
 ui.detach(); assert.deepEqual(store.current(), before); assert.equal(entries, 1);
});

test("manual hide survives updates; a fresh UI displays replayed contracts and clears an empty branch", async () => {
 let command: any; let widget: any; const entries: any[] = [];
 const store = createGoalStore((customType, data) => { entries.push({ type: "custom", customType, data }); });
 const pi = { registerCommand(_name: string, value: unknown) { command = value; } } as unknown as ExtensionAPI;
 const ctx = { mode: "tui", hasUI: true, ui: { setWidget(_key: string, value: unknown) { widget = value; } } } as unknown as ExtensionContext;
 const mutationCtx = { cwd: process.cwd(), sessionId: "fixture", now: new Date().toISOString() };
 const ui = registerGoalUi(pi, store); ui.attach(ctx);
 const enrolled = await store.mutate({ operation: "enroll", goal: "fixture", delivery: "source", authority: "fixture", requirements: [{ key: "r", outcome: "result", verification: "check" }] }, mutationCtx, "enroll");
 assert.equal(enrolled.ok, true); assert.equal(typeof widget, "function");
 await command.handler("hide", ctx);
 const suspended = await store.mutate({ operation: "suspend", reason: "fixture pause", condition: "explicit resume" }, mutationCtx, "suspend");
 assert.equal(suspended.ok, true); assert.equal(widget, undefined);
 await command.handler("show", ctx); assert.equal(typeof widget, "function");
 ui.detach(); assert.equal(widget, undefined);
 const replayed = createGoalStore(() => { assert.fail("read-only replay must not persist"); });
 replayed.replay(entries); assert.deepEqual(replayed.current(), store.current());
 const freshUi = registerGoalUi(pi, replayed); freshUi.attach(ctx);
 assert.equal(typeof widget, "function");
 assert.ok((widget as unknown as () => { render(width: number): string[] })().render(120).some(line => line.includes("result")));
 replayed.replay([]); assert.equal(widget, undefined);
 freshUi.detach();
});

test("the mounted todo widget follows terminal height and caps wide rows", async () => {
 let widget: any;
 const store = createGoalStore(() => {});
 const ui = registerGoalUi({ registerCommand() {} } as unknown as ExtensionAPI, store);
 ui.attach({ mode: "tui", hasUI: true, ui: { setWidget(_key: string, value: unknown) { widget = value; } } } as unknown as ExtensionContext);
 const result = await store.mutate({ operation: "enroll", goal: "long goal ".repeat(30), delivery: "source", authority: "fixture", requirements: [{ key: "r", outcome: "result", verification: "check" }], tasks: Array.from({ length: 16 }, (_, i) => ({ key: `t${i}`, title: `Task ${i}`, covers: ["r"] })) }, { cwd: process.cwd(), sessionId: "fixture", now: new Date().toISOString() }, "enroll");
 assert.equal(result.ok, true);
 const terminal = { rows: 9 };
 const component = widget({ terminal });
 assert.equal(component.render(200).length, 4, "three content rows plus editor spacing");
 terminal.rows = 60;
 const expanded: string[] = component.render(200);
 assert.equal(expanded.length, 13); assert.ok(expanded.every(row => visibleWidth(row) <= 120));
 assert.ok(component.render(16).every((row: string) => visibleWidth(row) <= 16));
 ui.detach();
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
