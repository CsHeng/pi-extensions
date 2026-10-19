import assert from "node:assert/strict";
import test from "node:test";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { taskOutcome } from "../extensions/workflow/goal-state.ts";
import { goalReceipt } from "../extensions/workflow/goal-tool.ts";
function fixture() {
 const entries: unknown[] = [];
 const store = createGoalStore((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }));
 const set = () => store.mutate({ operation: "set", goal: "Deliver useful work", tasks: [{ id: "a", title: "Change config" }, { id: "b", title: "Integrate" }] });
 return { store, entries, set };
}
test("a task completes directly from main-agent judgment without execution or evidence gates", () => {
 const f = fixture(); assert.equal(f.set().ok, true);
 assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done", note: "inspected" }, { id: "b", status: "done" }] }).ok, true);
 assert.equal(taskOutcome(f.store.current()!), "done");
 assert.deepEqual(Object.keys(f.store.current()!).sort(), ["cancelled", "goal", "paused", "revision", "tasks", "version"]);
});
test("set revises decomposition and removes inferred work; update changes existing items atomically", () => {
 const f = fixture(); f.set();
 const before = f.store.current();
 assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }, { id: "missing", status: "done" }] }).ok, false);
 assert.deepEqual(f.store.current(), before);
 assert.equal(f.store.mutate({ operation: "set", goal: "Deliver useful work", tasks: [{ id: "a", title: "Change config", status: "done" }] }).ok, true);
 assert.equal(taskOutcome(f.store.current()!), "done");
});
test("blocked work needs a real explanation; independent tasks remain actionable", () => {
 const f = fixture(); f.set();
 assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "blocked" }] }).ok, false);
 f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "blocked", note: "Waiting for supplied input" }] });
 assert.equal(taskOutcome(f.store.current()!), "active");
 f.store.mutate({ operation: "update", tasks: [{ id: "b", status: "done" }] });
 assert.equal(taskOutcome(f.store.current()!), "blocked");
 f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing", note: null }] });
 assert.equal(f.store.current()!.tasks[0]!.note, undefined);
});
test("cancel preserves completed items and cannot masquerade as completion or resume", () => {
 const f = fixture(); f.set(); f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] });
 f.store.mutate({ operation: "cancel", reason: "User cancelled" });
 assert.equal(taskOutcome(f.store.current()!), "cancelled");
 assert.deepEqual(f.store.current()!.tasks.map(t => t.status), ["done", "cancelled"]);
 assert.equal(f.store.mutate({ operation: "resume" }).ok, false);
 f.store.mutate({ operation: "set", goal: "Revised task", tasks: [{ id: "c", title: "Continue explicitly" }] });
 assert.equal(f.store.current()!.cancelled, false);
});
test("all cancelled or mixed terminal items are not reported as all done", () => {
 const f = fixture(); f.set();
 f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }, { id: "b", status: "cancelled" }] });
 assert.equal(taskOutcome(f.store.current()!), "closed with cancelled work");
});
test("inspection, observation and no-op updates do not persist artificial progress", () => {
 const f = fixture(); f.set(); const revision = f.store.current()!.revision, entries = f.entries.length;
 f.set(); f.store.observe("bash", false); f.store.mutate({ operation: "inspect" });
 f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "todo" }] });
 assert.equal(f.store.current()!.revision, revision); assert.equal(f.entries.length, entries);
 f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing" }] });
 assert.equal(f.store.current()!.revision, revision + 1);
 assert.equal(f.store.current()!.tasks[0]!.status, "doing", "tool observation cannot complete work");
});
test("pause preserves ordinary updates; replay is visible but requires resume", () => {
 const f = fixture(); f.set(); f.store.mutate({ operation: "pause", reason: "User pause" });
 assert.equal(f.store.current()!.paused, true);
 f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] }); assert.equal(f.store.current()!.paused, true);
 const restored = createGoalStore(() => {}); restored.replay(f.entries); restored.recover("Recovered");
 assert.equal(restored.current()!.tasks[0]!.status, "done"); assert.equal(restored.current()!.paused, true);
 restored.mutate({ operation: "resume" }); assert.equal(restored.current()!.paused, false);
});
test("latest old or malformed snapshots are ignored with a diagnostic, without migration or older fallback", () => {
 const f = fixture(); f.set();
 for (const data of [{ schemaVersion: 4, state: { fulfillment: "complete" } }, { schemaVersion: 5, state: { version: 5 } }]) {
  const store = createGoalStore(() => {}); store.replay([...f.entries, { type: "custom", customType: "csheng-workflow-state", data }]);
  assert.equal(store.current(), undefined); assert.match(goalReceipt(store.view()), /ignored.*no tasks or completion were migrated/);
  assert.equal(store.mutate({ operation: "inspect" }).ok, true);
  assert.equal(store.mutate({ operation: "set", goal: "Current intent", tasks: [] }).ok, true); assert.equal(store.view().unavailable, undefined);
 }
});
test("append failure and host cancellation preserve previous records", () => {
 let fail = false; const store = createGoalStore(() => { if (fail) throw new Error("storage unavailable"); });
 store.mutate({ operation: "set", goal: "Fixture", tasks: [{ id: "a", title: "A" }] }); const before = store.current();
 fail = true; assert.equal(store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] }).ok, false); assert.deepEqual(store.current(), before);
 const signal = AbortSignal.abort(); assert.equal(store.mutate({ operation: "cancel" }, { signal }).ok, false); assert.deepEqual(store.current(), before);
});
test("cancelled invocations reject writes with a distinct reason without poisoning later calls", () => {
 const f = fixture(); f.set();
 f.store.mutate({ operation: "pause", reason: "Explicit pause" });
 const before = f.store.current(), entries = f.entries.length;
 const signal = AbortSignal.abort();
 for (const operation of [
  { operation: "update", tasks: [{ id: "a", status: "done" }] },
  { operation: "resume" },
  { operation: "cancel" },
 ] as const) {
  const result = f.store.mutate(structuredClone(operation) as Parameters<typeof f.store.mutate>[0], { signal });
  assert.equal(result.ok, false);
  assert.deepEqual("error" in result ? result.error : undefined, { code: "call_cancelled" });
  assert.deepEqual(f.store.current(), before); assert.equal(f.entries.length, entries);
 }
 assert.equal(f.store.mutate({ operation: "inspect" }, { signal }).ok, true);
 const active = new AbortController().signal;
 assert.equal(f.store.mutate({ operation: "resume" }, { signal: active }).ok, true);
 assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] }, { signal: active }).ok, true);
 assert.equal(f.store.mutate({ operation: "cancel" }, { signal: active }).ok, true);
 assert.deepEqual(f.store.current()!.tasks.map(task => task.status), ["done", "cancelled"]);
});
test("validation failures are not classified as cancelled calls", () => {
 const f = fixture(); f.set(); const before = f.store.current();
 const result = f.store.mutate({ operation: "update", tasks: [{ id: "missing", status: "done" }] }, { signal: new AbortController().signal });
 assert.equal(result.ok, false); assert.equal("error" in result ? result.error : undefined, undefined);
 assert.deepEqual(f.store.current(), before);
});
test("duplicate ids and unknown protocol fields reject atomically", () => {
 const f = fixture(); f.set(); const before = f.store.current();
 assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }, { id: "a", status: "todo" }] }).ok, false);
 assert.equal(f.store.mutate({ operation: "report", facts: [] } as never).ok, false); assert.deepEqual(f.store.current(), before);
});
