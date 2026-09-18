import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { GoalState, GoalView } from "../extensions/workflow/goal-contracts.ts";
import { goalRows, type GoalUiTheme } from "../extensions/workflow/goal-ui-render.ts";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";

async function fixture(): Promise<GoalState> {
 const store = createGoalStore(() => {});
 const result = await store.mutate({ operation: "enroll", goal: "恢复任务列表", delivery: "source", authority: "fixture", requirements: [{ key: "r", outcome: "task view", verification: "tests" }], tasks: [
  { key: "read", title: "梳理展示样式", covers: ["r"] },
  { key: "ui", title: "实现任务列表", covers: ["r"] },
  { key: "test", title: "补充回归测试", covers: ["r"], dependsOn: ["ui"] },
 ] }, { cwd: process.cwd(), sessionId: "fixture", now: new Date().toISOString() }, "enroll");
 assert.equal(result.ok, true);
 return store.current()!;
}
function markDone(state: GoalState, key: string) {
 const basis = { scope: ["."], fingerprint: "fixture", state: "current" as const };
 const id = `A1:${key}`;
 state.facts.push({ id, key, kind: "agent", check: "fixture", result: "pass", attempt: "A1", basis, at: "fixture", generation: 0, usable: true });
 state.acceptance.push({ subject: `task:${key}`, revision: 1, facts: [id], accepted: true, rationale: "fixture" });
}
const view = (state: GoalState): GoalView => ({ state, deficits: [] });

test("todo heading and tree show progress, running work and dependencies, never tool receipts", async () => {
 const state = await fixture(); markDone(state, "read");
 state.attempts.push({ id: "A2", task: "ui", revision: 1, generation: 0, started: "fixture", status: "running", basis: { scope: ["."], fingerprint: "fixture", state: "current" }, writes: [] });
 const before = structuredClone(state);
 assert.deepEqual(goalRows(view(state), 120), [
  "● Tasks · 恢复任务列表 (1/3)",
  "├─ ✓ read 梳理展示样式",
  "├─ ◐ ui 实现任务列表",
  "└─ ○ test 补充回归测试 · waits for ui",
 ]);
 assert.doesNotMatch(goalRows(view(state), 120).join("\n"), /Contract|continuation|input aligned|fulfillment|requirement:/);
 assert.deepEqual(state, before);
});

test("done rows use success color and strikethrough; stale proof is not shown as done", async () => {
 const state = await fixture(); markDone(state, "read");
 const calls: string[] = [];
 const theme: GoalUiTheme = { fg(color, text) { calls.push(`${color}:${text}`); return text; }, strikethrough(text) { calls.push(`strike:${text}`); return text; } };
 goalRows(view(state), 120, 12, theme);
 assert.ok(calls.includes("accent:● Tasks · 恢复任务列表 (1/3)"));
 assert.ok(calls.includes("success:✓")); assert.ok(calls.includes("strike:梳理展示样式"));
 state.facts[0]!.usable = false;
 assert.match(goalRows(view(state), 120).join("\n"), /\(0\/3\)\n├─ ○ read/);
});

test("completed contract keeps a human-facing task summary instead of active continuation status", async () => {
 const state = await fixture(); for (const task of state.tasks) markDone(state, task.key);
 state.fulfillment = "complete";
 const rows = goalRows(view(state), 120);
 assert.equal(rows[0], "● Tasks · 恢复任务列表 (3/3) · completed");
 assert.equal(rows.filter(row => row.includes("✓")).length, 3);
 assert.doesNotMatch(rows.join("\n"), /Contract|continuation|input/);
});

test("overflow prioritizes blocked/running work and links to full list", async () => {
 const state = await fixture(); markDone(state, "read");
 state.tasks[2]!.blocker = { kind: "prerequisite", reason: "等待测试环境", unblock: "environment ready" };
 const rows = goalRows(view(state), 120, 3);
 assert.equal(rows.length, 3);
 assert.match(rows[1]!, /^├─ ! test 补充回归测试 · blocked: 等待测试环境$/);
 assert.equal(rows[2], "… 2 more · /workflow-ui list");
 assert.equal(goalRows(view(state), 120, 66).length, 4);
});

test("long blocker/dependency hints and keys preserve the task title on narrow terminals", async () => {
 const state = await fixture();
 state.tasks[1]!.blocker = { kind: "prerequisite", reason: "等待测试环境".repeat(12), unblock: "ready" };
 state.tasks[2]!.dependsOn = ["long-predecessor-key".repeat(3)];
 const rows = goalRows(view(state), 50).map(stripTerminalSequences);
 assert.match(rows[2]!, /实现任务列表.*blocked:/);
 assert.match(rows[3]!, /补充回归测试.*waits for/);
 state.tasks[1]!.key = "long-task-key".repeat(5);
 const narrow = goalRows(view(state), 40).map(stripTerminalSequences);
 assert.match(narrow[2]!, /实现任务列表/);
 assert.ok(narrow.every(row => visibleWidth(row) <= 40));
});

test("terminal data is sanitized before styling and narrow/zero dimensions remain bounded", async () => {
 const state = await fixture();
 state.goal = "\x1b[31m目标\x1b[0m\n\u202e 👩‍💻";
 state.tasks[0]!.title = "\x1b]0;injection\x07任务\n\t\u009b31m";
 state.tasks[0]!.key = "\x1b[2Jread";
 for (const width of [1, 3, 8, 20, 80, 120]) for (const maxRows of [1, 2, 3, 12]) {
  const rows = goalRows(view(state), width, maxRows);
  assert.ok(rows.length <= maxRows);
  assert.ok(rows.every(row => visibleWidth(row) <= width));
  // The host clipper may append a trusted reset; authored terminal escapes must not survive.
  const text = rows.join("");
  assert.equal(text.replace(/\x1b\[0m/g, ""), stripTerminalSequences(text));
  assert.doesNotMatch(stripTerminalSequences(text), /[\u0000-\u001f\u007f-\u009f\u202e]/);
 }
 assert.ok(goalRows(view(state), 120)[0]!.includes("👩‍💻"));
 assert.deepEqual(goalRows(view(state), 0), []); assert.deepEqual(goalRows(view(state), 80, 0), []);
});

test("empty and unavailable views do not fall back to protocol receipts", () => {
 assert.deepEqual(goalRows({ deficits: [] }, 80), []);
 assert.deepEqual(goalRows({ unavailable: "raw internal exception", deficits: [] }, 120), ["! Tasks · state unavailable · /workflow-ui list"]);
});
