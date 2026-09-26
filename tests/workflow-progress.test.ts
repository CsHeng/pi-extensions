import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Exercise the actual SDK theme implementation, not a mock style function.
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { goalRows } from "../extensions/workflow/goal-ui-render.ts";
import { registerGoalUi } from "../extensions/workflow/goal-ui.ts";
import { taskFrontier } from "../extensions/workflow/goal-state.ts";
import { goalReceipt, registerGoalTool } from "../extensions/workflow/goal-tool.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalOperation } from "../extensions/workflow/goal-contracts.ts";

async function fixture(t: test.TestContext) {
 const cwd = await mkdtemp(join(tmpdir(), "workflow-progress-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 await writeFile(join(cwd, "a"), "one"); await writeFile(join(cwd, "b"), "two");
 const entries: any[] = []; const store = createGoalStore((customType, data) => entries.push({ type: "custom", customType, data }));
 const ctx = { cwd, sessionId: "fixture", now: new Date().toISOString() }; let serial = 0;
 const mutate = async (op: GoalOperation) => { const result = await store.mutate(op, ctx, `call-${serial++}`); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
 await mutate({ operation: "enroll", goal: "Incremental work", delivery: "source", authority: "fixture", requirements: [{ key: "r", outcome: "done", verification: "fixture" }], tasks: ["a", "b"].map(key => ({ key, title: `Task ${key}`, covers: ["r"] })) });
 return { store, entries, mutate, cwd, ctx };
}

test("model-visible frontier separates independent work, local blockers and dependency waits", async t => {
 const { store, mutate, ctx } = await fixture(t);
 await mutate({ operation: "amend", reason: "one actual join", authority: "fixture", tasks: [
  { key: "a", title: "Local source", covers: ["r"] },
  { key: "b", title: "External peer", covers: ["r"] },
  { key: "join", title: "Peer join", covers: ["r"], dependsOn: ["b"] },
 ] });
 await mutate({ operation: "start", task: "b", scope: ["b"] });
 assert.deepEqual(taskFrontier(store.current()!), { ready: ["a"], running: ["b"], blocked: [], waiting: [{ task: "join", dependencies: ["b"] }] });
 await mutate({ operation: "report", task: "b", summary: "peer unavailable", blocker: { kind: "capability", reason: "pinned peer unavailable", unblock: "provide peer" } });
 assert.deepEqual(taskFrontier(store.current()!), { ready: ["a"], running: [], blocked: [{ task: "b", kind: "capability", reason: "pinned peer unavailable" }], waiting: [{ task: "join", dependencies: ["b"] }] });
 assert.equal(store.current()!.continuation.state, "active");
 let tool: any;
 registerGoalTool({ registerTool(value: unknown) { tool = value; }, on() {} } as never, store, () => false);
 const result = await tool.execute("frontier-inspect", { operation: "inspect" }, undefined, undefined, { ...ctx, sessionManager: { getSessionId: () => ctx.sessionId } });
 const lines = (result.content[0].text as string).split("\n");
 assert.equal(lines.find(line => line.startsWith("Ready:")), "Ready: a");
 assert.ok(lines.find(line => line.startsWith("Blocked:"))?.includes("b [capability]"));
 assert.ok(lines.find(line => line.startsWith("Waiting on dependencies:"))?.includes("join <- b"));
 await mutate({ operation: "start", task: "a", scope: ["a"] });
 await mutate({ operation: "report", task: "a", summary: "local accepted", facts: [{ key: "f", kind: "agent", check: "fixture", result: "pass" }], judgments: [{ subject: "task:a", facts: ["f"], accepted: true, rationale: "fixture" }] });
 assert.deepEqual(taskFrontier(store.current()!).ready, []);
 assert.equal(store.current()!.continuation.state, "waiting");
});

test("frontier is a bounded read-only projection, not permission to resume or accept", async t => {
 const { store, mutate, entries } = await fixture(t);
 await mutate({ operation: "amend", reason: "independent outcomes", authority: "fixture", tasks: Array.from({ length: 64 }, (_, i) => ({ key: `t${i}`, title: `Outcome ${i}`, covers: ["r"] })) });
 await mutate({ operation: "suspend", reason: "user pause", condition: "explicit resume" });
 store.delivered(false);
 const state = store.current()!, count = entries.length;
 const receipt = goalReceipt(store.view());
 assert.equal(taskFrontier(state).ready.length, 64);
 assert.match(receipt, /Ready: t0, t1, t2, t3, t4, t5, … \(\+58;/);
 assert.ok(receipt.length < 2000);
 assert.equal(entries.length, count); assert.deepEqual(store.current(), state);
 assert.equal(state.continuation.state, "suspended"); assert.equal(state.input.aligned, false); assert.equal(state.fulfillment, "pending");
 const terminal = structuredClone(state); terminal.fulfillment = "cancelled";
 assert.doesNotMatch(goalReceipt({ state: terminal, deficits: [] }), /Ready:/);
});

test("real slices remain visible before acceptance, parallel attempts and recovery are honest", async t => {
 const { store, entries, mutate, cwd, ctx } = await fixture(t);
 const rows = () => goalRows(store.view(), 120).join("\n");
 assert.match(rows(), /0\/2 accepted/);
 await mutate({ operation: "start", task: "a", scope: ["a"], writes: ["a"] });
 await mutate({ operation: "start", task: "b", scope: ["b"], writes: ["b"] });
 const ambiguous = await store.mutate({ operation: "report", summary: "no task" }, ctx, "ambiguous");
 assert.equal(ambiguous.code, "unknown_attempt");
 await mutate({ operation: "report", task: "a", summary: "slice checked, awaits judgment", facts: [{ key: "f", kind: "agent", check: "fixture", result: "pass" }] });
 assert.match(rows(), /◇ a Task a.*reported/); assert.match(rows(), /◐ b Task b/); assert.match(rows(), /0\/2 accepted/);
 await mutate({ operation: "report", attempt: "A1", summary: "locally accepted", judgments: [{ subject: "task:a", facts: ["f"], accepted: true, rationale: "fixture judgment" }] });
 assert.match(rows(), /1\/2 accepted/); assert.match(rows(), /✓ a Task a/);
 await writeFile(join(cwd, "a"), "changed"); await store.revalidate(cwd);
 assert.match(rows(), /0\/2 accepted/); assert.match(rows(), /↻ a Task a.*recheck/);
 await mutate({ operation: "report", task: "b", summary: "blocked", blocker: { kind: "prerequisite", reason: "test environment", unblock: "restore" } });
 assert.match(rows(), /! b Task b.*blocked/);
 await mutate({ operation: "suspend", reason: "tracker capability unavailable", condition: "explicit resume" });
 assert.match(rows(), /^! suspended/); assert.match(rows(), /tracker capability unavailable/);
 assert.ok(goalRows(store.view(), 8, 1)[0]?.startsWith("!"), "warning survives the narrowest header budget");
 const replay = createGoalStore(() => {}); replay.replay(entries); await replay.revalidate(cwd);
 assert.match(goalRows(replay.view(), 120).join("\n"), /suspended/);
 assert.equal(replay.current()!.fulfillment, "pending");
 await mutate({ operation: "resume", reason: "capability restored", authority: "same fixture" });
 assert.doesNotMatch(rows(), /suspended/);
});

test("losing accepted predecessor evidence marks a reported dependent for recheck", async t => {
 const { store, mutate, cwd } = await fixture(t);
 await mutate({ operation: "amend", reason: "fixture dependencies", authority: "fixture", tasks: [{ key: "a", title: "Task a", covers: ["r"] }, { key: "b", title: "Task b", covers: ["r"], dependsOn: ["a"] }] });
 for (const task of ["a", "b"]) {
  await mutate({ operation: "start", task, scope: [task] });
  await mutate({ operation: "report", task, summary: "accepted", facts: [{ key: "f", kind: "agent", check: "fixture", result: "pass" }], judgments: [{ subject: `task:${task}`, facts: ["f"], accepted: true, rationale: "fixture" }] });
 }
 assert.match(goalRows(store.view(), 120).join("\n"), /2\/2 accepted/);
 await writeFile(join(cwd, "a"), "new predecessor"); await store.revalidate(cwd);
 assert.equal(store.current()!.attempts.at(-1)!.status, "interrupted");
 assert.equal(store.current()!.facts[0]!.usable, false, "changed predecessor source invalidates its own fact");
 assert.equal(store.current()!.facts.at(-1)!.usable, true, "unchanged dependent source remains evidence, not accepted support for the new predecessor");
 assert.match(goalRows(store.view(), 120).join("\n"), /↻ b Task b.*recheck/);
 await mutate({ operation: "start", task: "a", scope: ["a"] });
 await mutate({ operation: "report", task: "a", summary: "predecessor rechecked", facts: [{ key: "f", kind: "agent", check: "new predecessor", result: "pass" }], judgments: [{ subject: "task:a", facts: ["f"], accepted: true, rationale: "rechecked" }] });
 assert.match(goalRows(store.view(), 120).join("\n"), /1\/2 accepted/);
 assert.match(goalRows(store.view(), 120).join("\n"), /↻ b Task b.*recheck/, "reaccepting A cannot automatically restore B's judgment");
 await mutate({ operation: "start", task: "b", scope: ["b"] });
 await mutate({ operation: "report", task: "b", summary: "independent source check still supports the current dependent outcome", judgments: [{ subject: "task:b", facts: ["A2:f"], accepted: true, rationale: "explicitly reviewed against the accepted predecessor; no new execution claimed" }] });
 assert.match(goalRows(store.view(), 120).join("\n"), /2\/2 accepted/);
});

test("recovered narrow warning view reserves acceptance count and an identifiable task", async t => {
 const { store, mutate } = await fixture(t);
 await mutate({ operation: "suspend", reason: "long capability explanation ".repeat(5), condition: "resume" });
 store.delivered(false);
 const rows = goalRows(store.view(), 40, 3);
 assert.match(rows[0]!, /^!.*0\/2 accepted/);
 assert.ok(rows.some(row => row.includes("Task a")), "reason and overflow must not displace every task");
 assert.equal(rows.length, 3);
});

for (const name of ["dark", "light"]) test(`real ${name} theme preserves local strike independent of ambient Chalk, including list`, async t => {
 const { store, mutate } = await fixture(t); const theme = getThemeByName(name); assert.ok(theme);
 await mutate({ operation: "start", task: "a", scope: ["a"] });
 await mutate({ operation: "report", task: "a", summary: "accepted", facts: [{ key: "f", kind: "agent", check: "fixture", result: "pass" }], judgments: [{ subject: "task:a", facts: ["f"], accepted: true, rationale: "fixture" }] });
 for (const width of [32, 120]) {
  const rows = goalRows(store.view(), width, 12, theme);
  assert.ok(rows[1]?.includes("\x1b[9m")); assert.ok(rows[1]?.includes("\x1b[29m"));
  assert.ok(rows[1]?.includes(theme.getFgAnsi("dim")));
  assert.equal(rows[2]?.includes("\x1b[9m"), false, "style cannot leak into pending row");
 }
 assert.equal(goalRows(store.view(), 120).join("").includes("\x1b"), false, "plain projection remains unstyled");
 let command: any; let selection: string[] = [];
 const ui = registerGoalUi({ registerCommand(_n, definition) { command = definition; } } as ExtensionAPI, store);
 const ctx = { mode: "tui", hasUI: true, ui: { theme, setWidget() {}, async select(_title: string, rows: string[]) { selection = rows; } } } as unknown as ExtensionContext;
 ui.attach(ctx); await command.handler("list", ctx); ui.detach();
 assert.ok(selection[1]?.includes("\x1b[9m"), "list uses the same actual theme and strike adapter");
});
