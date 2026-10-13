import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { goalRows } from "../extensions/workflow/goal-ui-render.ts";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
test("task projection displays current explicit statuses, completed strike and cancelled count", () => {
 const store = createGoalStore(() => {});
 store.mutate({ operation: "set", goal: "Visible progress", tasks: [
  { id: "a", title: "Completed task", status: "done" }, { id: "b", title: "Working", status: "doing" },
  { id: "c", title: "Waiting", status: "blocked", note: "Needs input" }, { id: "d", title: "Removed method", status: "cancelled" },
 ] });
 const rows = goalRows(store.view(), 120, 12, { fg: (_color, text) => text, strikethrough: text => text });
 assert.match(rows.join("\n"), /1\/4 done · 1 cancelled/);
 assert.ok(rows.some(row => row.includes("\x1b[9mCompleted task\x1b[29m")));
 assert.match(stripTerminalSequences(rows.join("\n")), /◐ b Working/); assert.match(rows.join("\n"), /! c Waiting.*Needs input/);
 assert.doesNotMatch(rows.join("\n"), /accepted|judgment|attempt/);
});
test("widget prioritizes active and blocked tasks, clips safely and preserves task titles", () => {
 const store = createGoalStore(() => {});
 store.mutate({ operation: "set", goal: "A".repeat(200), tasks: Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: i === 19 ? "Important\x1b[31m task" : "Older done", status: i === 19 ? "doing" : "done" })) });
 for (const width of [1, 8, 40, 120]) {
  const rows = goalRows(store.view(), width, 4);
  assert.ok(rows.length <= 4); assert.ok(rows.every(row => visibleWidth(row) <= width)); assert.ok(rows.every(row => !row.includes("\x1b[31m")));
 }
 assert.match(goalRows(store.view(), 80, 4).join("\n"), /Important task/);
 assert.match(goalRows(store.view(), 80, 4).at(-1)!, /more/);
});
test("unsupported history is visible and empty branches render no widget content", () => {
 assert.deepEqual(goalRows({}, 120), []);
 assert.match(goalRows({ unavailable: "ignored old snapshot" }, 120)[0]!, /state unavailable/);
});
