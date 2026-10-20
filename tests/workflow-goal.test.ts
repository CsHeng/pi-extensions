import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { tasklistParameters, tasklistStateSchema, type TasklistState } from "../extensions/tasklist/goal-contracts.ts";
import { TASKLIST_STORAGE_TYPE, createTasklistStore, normalizeTasklistSnapshot } from "../extensions/tasklist/goal-store.ts";
import { taskSummary } from "../extensions/tasklist/goal-state.ts";
import { tasklistReceipt } from "../extensions/tasklist/goal-tool.ts";

interface Entry { type: string; customType: string; data: unknown }

/** A snapshot written by the previous tracking schema, including its removed list-level control state. */
const legacySnapshot = (overrides: Record<string, unknown> = {}): Entry => ({
	type: "custom", customType: TASKLIST_STORAGE_TYPE,
	data: { schemaVersion: 5, state: {
		version: 5, revision: 4, goal: "Legacy list", paused: true, cancelled: false,
		reason: "Recovered task list; reconcile the current work and use resume when continuing.",
		tasks: [{ id: "a", title: "Old done", status: "done" }, { id: "b", title: "Old open", status: "doing", note: "keep this note" }],
		...overrides,
	} },
});

function fixture() {
	const entries: Entry[] = [];
	const store = createTasklistStore((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) as unknown }));
	const set = () => store.mutate({ operation: "set", title: "Deliver useful work", tasks: [{ id: "a", title: "Change config" }, { id: "b", title: "Integrate" }] });
	return { store, entries, set };
}

test("a task completes directly from main-agent judgment without execution or evidence gates", () => {
	const f = fixture(); assert.equal(f.set().ok, true);
	assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done", note: "inspected" }, { id: "b", status: "done" }] }).ok, true);
	assert.equal(taskSummary(f.store.current()!), "2 done");
	assert.deepEqual(Object.keys(f.store.current()!).sort(), ["revision", "tasks", "title", "version"]);
});

test("set revises decomposition and removes inferred work; update changes existing items atomically", () => {
	const f = fixture(); f.set();
	const before = f.store.current();
	assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }, { id: "missing", status: "done" }] }).ok, false);
	assert.deepEqual(f.store.current(), before);
	assert.equal(f.store.mutate({ operation: "set", title: "Deliver useful work", tasks: [{ id: "a", title: "Change config", status: "done" }] }).ok, true);
	assert.equal(taskSummary(f.store.current()!), "1 done");
	assert.equal(f.store.mutate({ operation: "update", title: "Renamed list" }).ok, true);
	assert.equal(f.store.current()!.title, "Renamed list");
});

test("blocked work needs a real explanation; notes stay ordinary editable data", () => {
	const f = fixture(); f.set();
	assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "blocked" }] }).ok, false);
	f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "blocked", note: "Waiting for supplied input" }] });
	assert.equal(taskSummary(f.store.current()!), "1 blocked · 1 todo");
	f.store.mutate({ operation: "update", tasks: [{ id: "b", status: "done" }] });
	assert.equal(f.store.current()!.tasks[1]!.note, undefined);
	f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing", note: null }] });
	assert.equal(f.store.current()!.tasks[0]!.note, undefined);
});

test("cancel edits item data only, keeps completed work and stays distinct from done", () => {
	const f = fixture(); f.set(); f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] });
	assert.equal(f.store.mutate({ operation: "cancel" }).ok, true);
	assert.deepEqual(f.store.current()!.tasks.map(task => task.status), ["done", "cancelled"]);
	assert.equal(taskSummary(f.store.current()!), "1 done · 1 cancelled");
	// Nothing is runtime-controlled: cancelled items remain ordinary editable data.
	assert.equal(f.store.mutate({ operation: "update", tasks: [{ id: "b", status: "todo" }] }).ok, true);
	assert.equal(f.store.current()!.tasks[1]!.status, "todo");
	const quiet = f.store.current()!.revision;
	assert.equal(f.store.mutate({ operation: "cancel" }).ok, true);
	assert.equal(f.store.current()!.revision, quiet + 1);
	assert.equal(f.store.mutate({ operation: "cancel" }).ok, true);
	assert.equal(f.store.current()!.revision, quiet + 1, "a cancel with no unfinished item is not a new revision");
});

test("the list has no pause, resume or runtime-control bookkeeping left", () => {
	const f = fixture(); f.set();
	for (const operation of ["pause", "resume"] as const) {
		assert.equal(Check(tasklistParameters, { operation }), false);
		assert.equal(f.store.mutate({ operation } as never).ok, false);
	}
	assert.deepEqual(Object.keys(f.store).sort(), ["current", "mutate", "replay", "subscribe", "view"]);
	assert.deepEqual(Object.keys(f.store.view()).sort(), ["state"]);
	assert.doesNotMatch(tasklistReceipt(f.store.view()), /paused|resumed|Last observed tool/);
});

test("inspection and no-op edits do not persist artificial progress", () => {
	const f = fixture(); f.set(); const revision = f.store.current()!.revision, entries = f.entries.length;
	f.set(); f.store.mutate({ operation: "inspect" });
	f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "todo" }] });
	assert.equal(f.store.current()!.revision, revision); assert.equal(f.entries.length, entries);
	f.store.mutate({ operation: "update", tasks: [{ id: "a", status: "doing" }] });
	assert.equal(f.store.current()!.revision, revision + 1);
	assert.equal(f.store.current()!.tasks[0]!.status, "doing");
});

test("every explicit edit writes the current representation", () => {
	const f = fixture(); f.set();
	const written = f.entries.at(-1)!.data as { schemaVersion: number; state: TasklistState };
	assert.equal(written.schemaVersion, 6);
	assert.equal(Check(tasklistStateSchema, written.state), true);
	assert.equal(written.state.title, "Deliver useful work");
});

test("a paused legacy snapshot restores as ordinary data without a resume call and is not rewritten", () => {
	const legacy = legacySnapshot();
	const entries: Entry[] = [legacy];
	const store = createTasklistStore((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) as unknown }));
	store.replay(entries);
	assert.deepEqual(store.current(), {
		version: 6, revision: 4, title: "Legacy list",
		tasks: [{ id: "a", title: "Old done", status: "done" }, { id: "b", title: "Old open", status: "doing", note: "keep this note" }],
	});
	assert.equal(store.view().unavailable, undefined);
	assert.equal(store.mutate({ operation: "inspect" }).ok, true, "inspection needs no resume");
	assert.equal(entries.length, 1, "restoration writes nothing");
	// The next explicit model edit is the only write, and it leaves the historical entry intact.
	assert.equal(store.mutate({ operation: "update", tasks: [{ id: "b", status: "done" }] }).ok, true);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], legacy);
	const written = entries[1]!.data as { schemaVersion: number; state: TasklistState };
	assert.equal(written.schemaVersion, 6);
	assert.equal(written.state.title, "Legacy list");
	assert.deepEqual(written.state.tasks.map(task => task.status), ["done", "done"]);
	assert.equal(written.state.revision, 5);
	assert.equal(store.current()!.revision, 5);
});

test("legacy list-level cancel state normalizes to its written item statuses only", () => {
	assert.deepEqual(normalizeTasklistSnapshot({ schemaVersion: 5, state: {
		version: 5, revision: 2, goal: "Old", paused: false, cancelled: true, reason: "User cancelled",
		tasks: [{ id: "a", title: "Done", status: "done" }, { id: "b", title: "Dropped", status: "cancelled" }],
	} }), { version: 6, revision: 2, title: "Old", tasks: [{ id: "a", title: "Done", status: "done" }, { id: "b", title: "Dropped", status: "cancelled" }] });
});

test("unsupported versions report an error instead of an empty list and are never rewritten", () => {
	const entries: Entry[] = [{ type: "custom", customType: TASKLIST_STORAGE_TYPE, data: { schemaVersion: 2, state: { goal: "old tracking" } } }];
	const store = createTasklistStore((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) as unknown }));
	store.replay(entries);
	assert.equal(store.current(), undefined);
	const inspected = store.mutate({ operation: "inspect" });
	assert.equal(inspected.ok, false);
	assert.match(tasklistReceipt(store.view()), /unsupported/i);
	assert.match(tasklistReceipt(store.view()), /schema version 2/);
	assert.match(tasklistReceipt(store.view()), /no items were migrated/);
	assert.equal(store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] }).ok, false);
	assert.equal(entries.length, 1, "unsupported state is left as written");
	assert.equal(store.mutate({ operation: "set", title: "Current intent", tasks: [] }).ok, true);
	assert.equal(store.view().unavailable, undefined);
	assert.equal((entries.at(-1)!.data as { schemaVersion: number }).schemaVersion, 6);
});

test("a malformed current snapshot is reported rather than silently empty", () => {
	const store = createTasklistStore(() => {});
	store.replay([{ type: "custom", customType: TASKLIST_STORAGE_TYPE, data: { schemaVersion: 6, state: { version: 6, revision: 1 } } }]);
	assert.equal(store.current(), undefined);
	assert.equal(store.mutate({ operation: "inspect" }).ok, false);
	assert.match(tasklistReceipt(store.view()), /invalid/);
});

test("append failure and host cancellation preserve previous records", () => {
	let fail = false; const store = createTasklistStore(() => { if (fail) throw new Error("storage unavailable"); });
	store.mutate({ operation: "set", title: "Fixture", tasks: [{ id: "a", title: "A" }] }); const before = store.current();
	fail = true; assert.equal(store.mutate({ operation: "update", tasks: [{ id: "a", status: "done" }] }).ok, false); assert.deepEqual(store.current(), before);
	const signal = AbortSignal.abort(); assert.equal(store.mutate({ operation: "cancel" }, { signal }).ok, false); assert.deepEqual(store.current(), before);
});

test("cancelled invocations reject writes with a distinct reason without poisoning later calls", () => {
	const f = fixture(); f.set();
	const before = f.store.current(), entries = f.entries.length;
	const signal = AbortSignal.abort();
	for (const operation of [
		{ operation: "update", tasks: [{ id: "a", status: "done" }] },
		{ operation: "cancel" },
	] as const) {
		const result = f.store.mutate(structuredClone(operation) as Parameters<typeof f.store.mutate>[0], { signal });
		assert.equal(result.ok, false);
		assert.deepEqual("error" in result ? result.error : undefined, { code: "call_cancelled" });
		assert.deepEqual(f.store.current(), before); assert.equal(f.entries.length, entries);
	}
	assert.equal(f.store.mutate({ operation: "inspect" }, { signal }).ok, true);
	const active = new AbortController().signal;
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
	assert.equal(f.store.mutate({ operation: "report", facts: [] } as never).ok, false);
	assert.equal(f.store.mutate({ operation: "set", title: "Only a title" } as never).ok, false);
	assert.deepEqual(f.store.current(), before);
});
