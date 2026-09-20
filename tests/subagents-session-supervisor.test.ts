import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { SessionExecutionSupervisor, type ExecutionEvent, type ExecutionOwner, type SupervisorHooks, type SupervisorLimits } from "../extensions/subagents/session-supervisor.ts";
const owner: ExecutionOwner = { repository: "/repo", sessionId: "session-1", branchAnchor: "anchor" };
const defaults: SupervisorLimits = { concurrency: 2, roles: { worker: 2, explorer: 1, reviewer: 1 } };
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const supervisor = (hooks: SupervisorHooks = {}, limits = defaults) => new SessionExecutionSupervisor(owner, limits, hooks);
const cancelled = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });

test("submission returns an accepted identity while its child remains unresolved", async () => {
	const s = supervisor(); const started = deferred(); const finish = deferred<number>();
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => ({ base: "fixed" }), execute: async (input, context) => context.runTask({ id: "a", role: "worker" }, async () => { assert.equal(input.base, "fixed"); started.resolve(); return finish.promise; }) });
	await started.promise; assert.equal(receipt.kind, "submission"); assert.equal(receipt.status, "accepted"); assert.equal(s.inspect(receipt.runId)[0]!.phase, "running");
	finish.resolve(42); assert.equal((await s.join(receipt.runId)).result, 42);
});
test("expensive execution preparation may continue after immutable input admission", async () => {
	const s = supervisor(); const input = deferred<string>(); const checkout = deferred();
	let accepted = false;
	const pending = s.submit({ requestId: "one", requestKey: "one", prepare: () => input.promise, execute: async (_input, ctx) => ctx.runTask({ id: "a", role: "worker" }, async () => { await checkout.promise; return "ready"; }) }).then(value => { accepted = true; return value; });
	await setImmediate(); assert.equal(accepted, false); input.resolve("immutable"); const receipt = await pending; assert.equal(accepted, true);
	assert.equal(s.hasActiveWork, true); checkout.resolve(); assert.equal((await s.join(receipt.runId)).phase, "completed");
});
test("original tool signal cannot cancel the child after submission is accepted", async () => {
	const s = supervisor(); const tool = new AbortController(); const finish = deferred(); let childSignal: AbortSignal | undefined;
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, context) => context.runTask({ id: "a", role: "worker" }, async signal => { childSignal = signal; await finish.promise; }) }, tool.signal);
	await setImmediate(); tool.abort(); assert.equal(childSignal?.aborted, false); finish.resolve(); assert.equal((await s.join(receipt.runId)).phase, "completed");
});
test("tool cancellation during preparation rejects admission and never starts execution", async () => {
	const s = supervisor(); const tool = new AbortController(); const finish = deferred(); let ran = false;
	const pending = s.submit({ requestId: "one", requestKey: "one", prepare: async () => { await finish.promise; }, execute: async () => { ran = true; } }, tool.signal);
	tool.abort(); finish.resolve(); await assert.rejects(pending); assert.equal(ran, false); assert.equal(s.inspect()[0]!.phase, "cancelled");
});
test("different submissions share one concurrency budget", async () => {
	const s = supervisor({}, { ...defaults, concurrency: 1 }); const firstStart = deferred(); const firstEnd = deferred(); const secondStart = deferred();
	const a = await s.submit({ requestId: "a", requestKey: "a", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker" }, async () => { firstStart.resolve(); await firstEnd.promise; }) });
	await firstStart.promise;
	const b = await s.submit({ requestId: "b", requestKey: "b", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "b", role: "worker" }, async () => { secondStart.resolve(); }) });
	await setImmediate(); assert.equal(s.inspect(b.runId)[0]!.tasks[0]!.phase, "queued"); firstEnd.resolve(); await secondStart.promise;
	await Promise.all([s.join(a.runId), s.join(b.runId)]);
});
test("role capacity is shared without blocking an independently eligible role", async () => {
	const s = supervisor({}, { concurrency: 3, roles: { worker: 1, reviewer: 1, explorer: 1 } }); const end = deferred(); const workerStarted = deferred(); const explorerStarted = deferred();
	const a = await s.submit({ requestId: "a", requestKey: "a", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker" }, async () => { workerStarted.resolve(); await end.promise; }) }); await workerStarted.promise;
	const b = await s.submit({ requestId: "b", requestKey: "b", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "b", role: "worker" }, async () => "b") });
	const c = await s.submit({ requestId: "c", requestKey: "c", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "c", role: "explorer" }, async () => { explorerStarted.resolve(); return "c"; }) });
	await explorerStarted.promise; assert.equal(s.inspect(b.runId)[0]!.tasks[0]!.phase, "queued"); end.resolve(); await Promise.all([s.join(a.runId), s.join(b.runId), s.join(c.runId)]);
});
test("explicit resource locks span submissions, not predicted filenames", async () => {
	const s = supervisor(); const end = deferred(); const start = deferred();
	const a = await s.submit({ requestId: "a", requestKey: "a", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker", resourceLocks: ["db"] }, async () => { start.resolve(); await end.promise; }) }); await start.promise;
	const b = await s.submit({ requestId: "b", requestKey: "b", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "b", role: "reviewer", resourceLocks: ["db"] }, async () => "b") });
	await setImmediate(); assert.equal(s.inspect(b.runId)[0]!.tasks[0]!.phase, "queued"); end.resolve(); await Promise.all([s.join(a.runId), s.join(b.runId)]);
});
test("a completed child is observable and wakes before its slow sibling finishes", async () => {
	const events: ExecutionEvent[] = []; const wake = deferred(); const slow = deferred(); const s = supervisor({ onEvent: e => { events.push(e); }, onWake: () => { wake.resolve(); } });
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, ctx) => Promise.all([
		ctx.runTask({ id: "fast", role: "worker" }, async () => "fast"), ctx.runTask({ id: "slow", role: "worker" }, async () => { await slow.promise; return "slow"; }),
	]) });
	await wake.promise; assert.ok(events.some(e => e.task?.taskId === "fast" && e.task.phase === "completed")); assert.equal(s.inspect(receipt.runId)[0]!.phase, "running");
	slow.resolve(); await s.join(receipt.runId);
});
test("identical concurrent submissions share preparation, execution, and run identity", async () => {
	const s = supervisor(); const gate = deferred(); let prepared = 0; let executed = 0;
	const input = { requestId: "one", requestKey: "key", prepare: async () => { prepared++; await gate.promise; }, execute: async () => { executed++; return 7; } };
	const a = s.submit(input); const b = s.submit(input); gate.resolve(); const receipts = await Promise.all([a, b]);
	assert.equal(receipts[0]!.runId, receipts[1]!.runId); assert.equal(receipts[1]!.replayed, true); await s.join(receipts[0]!.runId); assert.equal(prepared, 1); assert.equal(executed, 1);
});
test("a changed request cannot reuse the same id", async () => {
	const s = supervisor(); const a = await s.submit({ requestId: "one", requestKey: "a", prepare: async () => undefined, execute: async () => 1 });
	await assert.rejects(s.submit({ requestId: "one", requestKey: "b", prepare: async () => undefined, execute: async () => 2 }), { code: "request_id_conflict" }); await s.join(a.runId);
});
test("preparation failure stays inspectable and does not silently retry", async () => {
	const s = supervisor(); let attempts = 0; const input = { requestId: "one", requestKey: "key", prepare: async () => { attempts++; throw new Error("input unavailable"); }, execute: async () => "never" };
	await assert.rejects(s.submit(input), /input unavailable/); await assert.rejects(s.submit(input), /input unavailable/); assert.equal(attempts, 1); assert.equal(s.inspect()[0]!.phase, "failed");
});
test("cancelled queued work never launches and releases its queue entry", async () => {
	const s = supervisor({}, { ...defaults, concurrency: 1 }); const end = deferred(); const start = deferred(); let ran = false;
	const a = await s.submit({ requestId: "a", requestKey: "a", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker" }, async () => { start.resolve(); await end.promise; }) }); await start.promise;
	const b = await s.submit({ requestId: "b", requestKey: "b", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "b", role: "worker" }, async () => { ran = true; }) });
	s.cancel(b.runId); assert.equal((await s.join(b.runId)).phase, "cancelled"); end.resolve(); await s.join(a.runId); assert.equal(ran, false);
	const c = await s.submit({ requestId: "c", requestKey: "c", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "c", role: "worker" }, async () => "next") }); assert.equal((await s.join(c.runId)).phase, "completed");
});
test("running cancellation uses the runner signal, preserves state, and does not wake", async () => {
	let wakes = 0; const s = supervisor({ onWake: () => { wakes++; } }); const started = deferred();
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker" }, async signal => { started.resolve(); await cancelled(signal); }) });
	await started.promise; assert.equal(s.cancel(receipt.runId), true); assert.equal((await s.join(receipt.runId)).phase, "cancelled"); await setImmediate(); assert.equal(wakes, 0); assert.equal(s.cancel(receipt.runId), false);
});
test("normal run completion does not cancel another active child", async () => {
	const s = supervisor(); const end = deferred(); let signal: AbortSignal | undefined;
	const a = await s.submit({ requestId: "a", requestKey: "a", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker" }, async input => { signal = input; await end.promise; }) });
	const b = await s.submit({ requestId: "b", requestKey: "b", prepare: async () => undefined, execute: async () => "complete" }); await s.join(b.runId);
	assert.equal(signal?.aborted, false); assert.equal(s.hasActiveWork, true); end.resolve(); await s.join(a.runId);
});
test("an explicit wake suppression retains execution facts without reentering the parent", async () => {
	let wakes = 0; const s = supervisor({ onWake: () => { wakes++; } }); const end = deferred();
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async () => { await end.promise; return 1; } });
	s.suppressWake(); end.resolve(); assert.equal((await s.join(receipt.runId)).phase, "completed"); await setImmediate(); assert.equal(wakes, 0);
});
test("owner replacement fences delayed completion and permits the new owner", async () => {
	const events: ExecutionEvent[] = []; const s = supervisor({ onWake: values => { events.push(...values); } }); const start = deferred();
	await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, ctx) => { start.resolve(); await cancelled(ctx.signal); } }); await start.promise;
	const oldGeneration = s.currentGeneration; await s.replaceOwner({ ...owner, sessionId: "session-2" }); assert.notEqual(s.currentGeneration, oldGeneration);
	const next = await s.submit({ requestId: "one", requestKey: "new", prepare: async () => undefined, execute: async () => "next" }); await s.join(next.runId); await setImmediate();
	assert.ok(events.length); assert.ok(events.every(e => e.owner.sessionId === "session-2"));
});
test("persist/event processing finishes before the associated wake", async () => {
	const persist = deferred(); const entered = deferred(); let wakes = 0;
	const s = supervisor({ onEvent: async () => { entered.resolve(); await persist.promise; }, onWake: () => { wakes++; } });
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async () => "result" });
	await entered.promise; assert.equal(s.inspect(receipt.runId)[0]!.phase, "completed"); assert.equal(wakes, 0); persist.resolve(); await s.join(receipt.runId); await setImmediate(); assert.equal(wakes, 1);
});
test("owner replacement during asynchronous event processing cannot leak a stale wake", async () => {
	const entered = deferred(); const persist = deferred(); let wakes = 0;
	const s = supervisor({ onEvent: async () => { entered.resolve(); await persist.promise; }, onWake: () => { wakes++; } });
	await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async () => 1 }); await entered.promise;
	const replacing = s.replaceOwner({ ...owner, sessionId: "new" }); persist.resolve(); await replacing; await setImmediate(); assert.equal(wakes, 0);
});
test("event delivery errors do not erase execution results or generate a false wake", async () => {
	const errors: unknown[] = []; let wakes = 0;
	const s = supervisor({ onEvent: () => { throw new Error("storage failed"); }, onWake: () => { wakes++; }, onDeliveryError: error => { errors.push(error); } });
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async () => 23 });
	const result = await s.join(receipt.runId); assert.equal(result.result, 23); assert.equal(result.phase, "completed"); assert.equal(wakes, 0); assert.equal(errors.length, 1);
});
test("one child completion does not also wake again for its successful run summary", async () => {
	const wakes: ExecutionEvent[] = []; const s = supervisor({ onWake: events => { wakes.push(...events); } });
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "a", role: "worker" }, async () => 1) });
	await s.join(receipt.runId); await setImmediate(); assert.equal(wakes.length, 1); assert.equal(wakes[0]!.kind, "task-terminal");
});
test("run settlement waits for tasks even if its callback forgot to await them", async () => {
	const end = deferred(); const s = supervisor();
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, ctx) => { void ctx.runTask({ id: "a", role: "worker" }, async () => { await end.promise; }); return "parent returned"; } });
	await setImmediate(); assert.equal(s.inspect(receipt.runId)[0]!.phase, "running"); end.resolve(); assert.equal((await s.join(receipt.runId)).phase, "completed");
});
test("shutdown cancels current work, waits for cleanup, and closes admission", async () => {
	const started = deferred(); let cleaned = false; const s = supervisor();
	await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async (_, ctx) => { started.resolve(); try { await cancelled(ctx.signal); } finally { cleaned = true; } } });
	await started.promise; await s.shutdown(); assert.equal(cleaned, true); assert.equal(s.hasActiveWork, false);
	await assert.rejects(s.submit({ requestId: "two", requestKey: "two", prepare: async () => undefined, execute: async () => undefined }), { code: "supervisor_closed" });
});
test("inspect returns defensive copies and run retention has an explicit finite bound", async () => {
	const s = supervisor({}, { ...defaults, maxRuns: 1 }); const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: async () => undefined, execute: async () => ({ value: 1 }) }); await s.join(receipt.runId);
	const read = s.inspect(receipt.runId); read[0]!.phase = "failed"; assert.equal(s.inspect(receipt.runId)[0]!.phase, "completed");
	await assert.rejects(s.submit({ requestId: "two", requestKey: "two", prepare: async () => undefined, execute: async () => undefined }), { code: "session_run_limit" });
});
test("invalid capacity is rejected instead of queuing work that can never start", () => {
	assert.throws(() => supervisor({}, { ...defaults, concurrency: 0 }), { code: "invalid_capacity" });
	assert.throws(() => supervisor({}, { ...defaults, roles: { worker: 0, reviewer: 1, explorer: 1 } }), { code: "invalid_capacity" });
});