import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { taskRows } from "../extensions/tasks-ui/render.ts";
import { createTasklistStore } from "../extensions/tasklist/goal-store.ts";
test("task projection displays current explicit statuses, completed strike and cancelled count", () => {
 const store = createTasklistStore(() => {});
 store.mutate({ operation: "set", title: "Visible progress", tasks: [
  { id: "a", title: "Completed task", status: "done" }, { id: "b", title: "Working", status: "doing" },
  { id: "c", title: "Waiting", status: "blocked", note: "Needs input" }, { id: "d", title: "Removed method", status: "cancelled" },
 ] });
 const rows = taskRows(store.view(), 120, 12, { fg: (_color, text) => text, strikethrough: text => text });
 assert.match(rows.join("\n"), /Tasks · Visible progress \(1\/4 done · 1 cancelled\)/);
 assert.match(rows.join("\n"), /1 doing/);
 assert.ok(rows.some(row => row.includes("\x1b[9mCompleted task\x1b[29m")));
 assert.match(stripTerminalSequences(rows.join("\n")), /◐ b Working/); assert.match(rows.join("\n"), /! c Waiting.*Needs input/);
 assert.doesNotMatch(rows.join("\n"), /accepted|judgment|attempt|queue|resume|paused/);
});
test("widget prioritizes unfinished tasks, clips safely and preserves task titles", () => {
 const store = createTasklistStore(() => {});
 store.mutate({ operation: "set", title: "A".repeat(200), tasks: Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: i === 19 ? "Important\x1b[31m task" : "Older done", status: i === 19 ? "doing" : "done" })) });
 for (const width of [1, 8, 40, 120]) {
  const rows = taskRows(store.view(), width, 4);
  assert.ok(rows.length <= 4); assert.ok(rows.every(row => visibleWidth(row) <= width)); assert.ok(rows.every(row => !row.includes("\x1b[31m")));
 }
 assert.match(taskRows(store.view(), 80, 4).join("\n"), /Important task/);
 assert.match(taskRows(store.view(), 80, 4).at(-1)!, /more/);
});
test("unsupported history is visible and empty branches render no widget content", () => {
 assert.deepEqual(taskRows({}, 120), []);
 assert.match(taskRows({ unavailable: "Previous task list state is unsupported" }, 120)[0]!, /state unavailable/);
 assert.match(taskRows({ unavailable: "Previous task list state is unsupported" }, 120)[0]!, /\/tasks-ui list/);
});
test("expanded rows keep title, counts, glyphs, ids, notes and priority without runtime-control state", () => {
 const store = createTasklistStore(() => {});
 store.mutate({ operation: "set", title: "Visible progress", tasks: [
  { id: "a", title: "Completed task", status: "done" }, { id: "b", title: "Working", status: "doing" },
  { id: "c", title: "Waiting", status: "blocked", note: "Needs input" }, { id: "d", title: "Removed method", status: "cancelled" },
  { id: "e", title: "KeepTitle", status: "todo", note: "N".repeat(180) },
 ] });
 const rows = taskRows(store.view(), 120, 12);
 const text = stripTerminalSequences(rows.join("\n"));
 assert.match(text, /Tasks · Visible progress \(1\/5 done · 1 cancelled\)/);
 assert.match(text, /1 doing/);
 assert.match(text, /├─ ✓ a /); assert.match(text, /├─ ◐ b Working/); assert.match(text, /├─ ! c Waiting/); assert.match(text, /├─ – d Removed method/);
 assert.match(text, /└─ ○ e KeepTitle/);
 const tagged = { fg: (color: string, text: string) => `{${color}}${text}{/}`, strikethrough: (text: string) => text };
 const colored = taskRows(store.view(), 120, 12, tagged).join("\n");
 assert.match(colored, /\{success\}✓/); assert.match(colored, /\{accent\}Working/); assert.match(colored, /\{warning\}◐/);
 assert.ok(colored.includes("\x1b[9mCompleted task\x1b[29m"));
 // The list keeps no pause/resume control state: the same data renders one header and its items.
 assert.deepEqual(Object.keys(store.current()!).sort(), ["revision", "tasks", "title", "version"]);
 assert.deepEqual(taskRows(store.view(), 120, 12), taskRows(store.view(), 120, 12));
 assert.doesNotMatch(text, /paused|resumed|reason/);
 const titled = createTasklistStore(() => {});
 titled.mutate({ operation: "set", title: "Clip", tasks: [{ id: "e", title: "KeepTitle", status: "todo", note: "N".repeat(180) }] });
 const narrow = taskRows(titled.view(), 40, 4);
 assert.ok(narrow.every(row => visibleWidth(row) <= 40));
 assert.match(narrow.join("\n"), /KeepTitle/);
 const blocked = createTasklistStore(() => {});
 blocked.mutate({ operation: "set", title: "Hold", tasks: [{ id: "c", title: "Waiting", status: "blocked", note: "Needs input" }] });
 assert.match(taskRows(blocked.view(), 80, 4)[0]!, /! blocked · Tasks/);
 const finished = createTasklistStore(() => {});
 finished.mutate({ operation: "set", title: "Ship", tasks: [{ id: "a", title: "Completed task", status: "done" }] });
 assert.match(taskRows(finished.view(), 80, 4)[0]!, /1\/1 done\)/);
 assert.doesNotMatch(taskRows(finished.view(), 80, 4)[0]!, /paused|resumed/);
 // Cancelling remaining work stays visible item data, not a list-level engine outcome.
 finished.mutate({ operation: "set", title: "Ship", tasks: [{ id: "a", title: "Completed task", status: "done" }, { id: "b", title: "Dropped method", status: "todo" }] });
 finished.mutate({ operation: "cancel" });
 const cancelled = taskRows(finished.view(), 80, 6);
 assert.match(cancelled[0]!, /1\/2 done · 1 cancelled/);
 assert.doesNotMatch(cancelled[0]!, /done\) · /);
 assert.match(stripTerminalSequences(cancelled.join("\n")), /– b Dropped method/);
});
