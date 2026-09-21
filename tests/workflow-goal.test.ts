import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalStore, canonicalScope, type GoalContext } from "../extensions/workflow/goal-store.ts";
import { accepted, progressKey } from "../extensions/workflow/goal-state.ts";
import type { GoalOperation } from "../extensions/workflow/goal-contracts.ts";
import { goalReceipt } from "../extensions/workflow/goal-tool.ts";
import { goalRows } from "../extensions/workflow/goal-ui.ts";

const enroll: GoalOperation = { operation: "enroll", goal: "Implement goal", delivery: "source only", authority: "explicit user request", requirements: [{ key: "one", outcome: "first", verification: "check" }, { key: "two", outcome: "second", verification: "check" }], tasks: [{ key: "one", title: "First", covers: ["one"] }, { key: "two", title: "Second", covers: ["two"] }] };
async function fixture(t: test.TestContext) {
 const cwd = await mkdtemp(join(tmpdir(), "goal-test-")); t.after(() => rm(cwd, { recursive: true, force: true }));
 await writeFile(join(cwd, "one"), "one"); await writeFile(join(cwd, "two"), "two");
 const snapshots: { type: string; customType: string; data: unknown }[] = [];
 const store = createGoalStore((customType, data) => snapshots.push({ type: "custom", customType, data: structuredClone(data) }));
 let serial = 0;
 const ctx: GoalContext = { cwd, now: "2026-09-18T00:00:00.000Z", sessionId: "fixture" };
 const run = async (op: GoalOperation) => { const result = await store.mutate(op, ctx, `call-${++serial}`); assert.equal(result.ok, true, result.message); return result; };
 const observe = async (id: string, error = false) => {
  const capture = await store.capture(cwd);
  store.observe({ ...capture, host: { toolCallId: id, toolName: "bash", sessionId: "fixture", at: ctx.now, isError: error, exitCode: error ? 1 : 0 } });
 };
 const report = (task: string, observationId?: string, complete = false): GoalOperation => ({ operation: "report", summary: "Executed check and evaluated result", facts: [{ key: "check", kind: observationId ? "host" : "agent", check: "unit test", result: "pass", ...(observationId ? { observationId } : {}) }], judgments: [`task:${task}`, `requirement:${task}`, ...(complete ? ["delivery"] : [])].map(subject => ({ subject, accepted: true, facts: ["check"], rationale: "Covers this subject" })), complete });
 return { store, ctx, run, observe, report, snapshots, cwd };
}

test("strict enrollment is explicit; normal slice is start + compound report; all obligations gate close", async t => {
 const f = await fixture(t);
 assert.equal(f.store.current(), undefined);
 await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 const partial = await f.run(f.report("one", undefined, true));
 assert.equal(partial.view.state?.fulfillment, "pending"); assert.ok(partial.diagnostics.includes("requirement:two"));
 await f.run({ operation: "start", task: "two", scope: ["two"] });
 const final = await f.run(f.report("two", undefined, true));
 assert.equal(final.view.state?.fulfillment, "complete");
 assert.equal(f.snapshots.length, 5);
});

test("honest check-time basis supports edits then verification; fake success/failure reports retain diagnostics", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"], writes: ["one"] });
 await writeFile(join(f.cwd, "one"), "edited");
 await f.observe("check-fail", true);
 const failed = await f.run(f.report("one", "check-fail"));
 assert.equal(accepted(failed.view.state!, "task:one"), false); assert.ok(failed.diagnostics.length);
 const bad = await f.store.mutate({ ...f.report("one", "fabricated"), attempt: "A1" }, f.ctx, "bad");
 assert.equal(bad.code, "observation_required");
 // Correct a stable fact after a new real check; reported attempts need a new execution boundary.
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.observe("check-pass");
 const success = await f.run(f.report("one", "check-pass"));
 assert.equal(accepted(success.view.state!, "task:one"), true);
 assert.equal(success.view.state!.facts.at(-1)!.kind, "host");
});

test("duplicate reports/corrections are bounded and do not create fake progress", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run(f.report("one")); const progress = progressKey(f.store.current()!);
 const op = { ...f.report("one"), attempt: "A1" };
 await f.run(op); assert.equal(f.store.current()!.facts.length, 1); assert.equal(progressKey(f.store.current()!), progress);
 await f.run({ ...op, facts: [{ key: "check", kind: "agent", check: "corrected failure", result: "fail" }], judgments: [] });
 assert.equal(f.store.current()!.facts.length, 1); assert.equal(accepted(f.store.current()!, "task:one"), false);
});

test("same-file drift invalidates affected acceptance, preserves unrelated task, needs verification not authority", async t => {
 const f = await fixture(t); await f.run(enroll);
 for (const task of ["one", "two"]) { await f.run({ operation: "start", task, scope: [task] }); await f.run(f.report(task)); }
 await writeFile(join(f.cwd, "one"), "compatible concurrent update");
 const result = await f.run({ operation: "close", outcome: "completed", reason: "evaluate current proof" });
 assert.equal(accepted(result.view.state!, "task:one"), false); assert.equal(accepted(result.view.state!, "task:two"), true);
 assert.equal(result.view.state!.goalRevision, 1);
 await f.run({ operation: "start", task: "one", scope: ["./one"] }); await f.run(f.report("one", undefined, true));
 assert.equal(f.store.current()!.fulfillment, "complete");
});

test("contained symlink retarget invalidates proof even if the old target stays unchanged", async t => {
 const f = await fixture(t); await symlink("one", join(f.cwd, "alias")); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["alias"] }); await f.run(f.report("one"));
 assert.deepEqual(f.store.current()!.facts[0]!.basis.scope, ["alias"]);
 await unlink(join(f.cwd, "alias")); await symlink("two", join(f.cwd, "alias"));
 await f.run({ operation: "close", outcome: "completed", reason: "evaluate proof" });
 assert.equal(accepted(f.store.current()!, "task:one"), false); assert.equal(f.store.current()!.facts[0]!.usable, false);
});

test("reported attempts and old checks cannot certify amended verification", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 await f.run({ operation: "amend", reason: "verification changed", authority: "user clarification", requirements: [{ ...enroll.requirements![0]!, verification: "different check" }, enroll.requirements![1]!] });
 assert.equal(f.store.current()!.attempts[0]!.status, "interrupted"); assert.equal(f.store.current()!.facts[0]!.usable, false);
 assert.equal((await f.store.mutate({ ...f.report("one"), attempt: "A1" }, f.ctx, "stale-correction")).code, "unknown_attempt");
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 const result = await f.run({ operation: "report", summary: "cannot reuse obsolete check", judgments: [{ subject: "requirement:one", facts: ["A1:check"], accepted: true, rationale: "old evidence" }] });
 assert.equal(accepted(result.view.state!, "requirement:one"), false);
});

test("active resume cannot renew anti-spin allowance but can unblock an independent task", async t => {
 const f = await fixture(t); await f.run(enroll); let dispatched = 0;
 await f.store.settle(f.ctx, () => dispatched++);
 for (let i = 0; i < 2; i++) {
  const result = await f.store.mutate({ operation: "resume", reason: "same wording", authority: "existing" }, f.ctx, `resume-${i}`);
  assert.equal(result.code, "already_active"); await f.store.settle(f.ctx, () => dispatched++);
 }
 assert.equal(dispatched, 2); assert.equal(f.store.current()!.continuation.state, "suspended");
 await f.run({ operation: "resume", reason: "diagnosed stagnation", authority: "existing" });
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run({ operation: "report", summary: "blocked task", blocker: { kind: "prerequisite", reason: "missing", unblock: "restored" } });
 const history = structuredClone(f.store.current()!.continuation);
 await f.run({ operation: "resume", task: "one", reason: "restored", authority: "existing" });
 assert.deepEqual(f.store.current()!.continuation, history); assert.equal(f.store.current()!.tasks[0]!.blocker, undefined);
});

test("overlapping writer including canonical aliases prevents acceptance", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["./one"] });
 await f.run({ operation: "start", task: "two", scope: ["two"], writes: [join(f.cwd, "one")] });
 const result = await f.run({ ...f.report("one"), attempt: "A1" });
 assert.ok(result.diagnostics.some(d => d.includes("overlapping writer"))); assert.equal(accepted(f.store.current()!, "task:one"), false);
 assert.deepEqual(await canonicalScope(["./one", join(f.cwd, "one")], f.cwd), [join(f.cwd, "one")]);
 await symlink(tmpdir(), join(f.cwd, "escape"));
 assert.deepEqual(await canonicalScope(["escape/outside"], f.cwd), [join(tmpdir(), "outside")]);
});

test("amended meaning invalidates dependent attempts, not independent work", async t => {
 const f = await fixture(t); await f.run(enroll);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run({ operation: "start", task: "two", scope: ["two"] });
 await f.run({ operation: "amend", authority: "same user clarifies", reason: "changed first requirement", requirements: [{ key: "one", outcome: "changed", verification: "new check" }, enroll.requirements![1]!] });
 assert.equal(f.store.current()!.attempts[0]!.status, "interrupted"); assert.equal(f.store.current()!.attempts[1]!.status, "running");
 assert.equal((await f.store.mutate({ ...f.report("one"), attempt: "A1" }, f.ctx, "stale")).code, "unknown_attempt");
});

test("waiting, input reconciliation, suspension and cancellation are not fulfillment", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 await f.run({ operation: "report", summary: "prerequisite absent", blocker: { kind: "prerequisite", reason: "missing fixture", unblock: "fixture restored" } });
 assert.equal(f.store.current()!.fulfillment, "pending"); assert.equal(f.store.current()!.continuation.state, "active", "independent ready work remains actionable");
 await f.run({ operation: "start", task: "two", scope: ["two"] }); await f.run(f.report("two"));
 assert.equal(f.store.current()!.continuation.state, "waiting");
 f.store.delivered(true);
 assert.equal((await f.store.mutate({ operation: "resume", reason: "fixture exists", authority: "original request" }, f.ctx, "bad-resume")).code, "alignment_required");
 await f.run({ operation: "resume", reason: "fixture exists", authority: "original request", alignment: "same authorized goal" });
 assert.equal(f.store.current()!.continuation.state, "active");
 await f.run({ operation: "close", outcome: "cancelled", reason: "user cancelled" }); assert.equal(f.store.current()!.fulfillment, "cancelled");
});

test("productive continuation repeats; churn and changed wording cannot renew no-progress budget", async t => {
 const f = await fixture(t); await f.run(enroll); let count = 0;
 await f.store.settle(f.ctx, () => count++);
 await f.run({ operation: "start", task: "one", scope: ["one"] }); await f.run(f.report("one"));
 await f.store.settle(f.ctx, () => count++);
 await f.run({ operation: "start", task: "two", scope: ["two"] }); await f.run(f.report("two"));
 await f.store.settle(f.ctx, () => count++); assert.equal(count, 3);
 await f.run({ operation: "report", attempt: "A2", summary: "new prose without work" });
 await f.store.settle(f.ctx, () => count++); await f.store.settle(f.ctx, () => count++);
 assert.equal(count, 4); assert.equal(f.store.current()!.continuation.state, "suspended"); assert.equal(f.store.current()!.fulfillment, "pending");
});

test("persistence is append-before-install, newest corruption fails closed, recovery is not autoresume", async t => {
 const f = await fixture(t); await f.run(enroll); await f.run({ operation: "start", task: "one", scope: ["one"] });
 const replay = createGoalStore(() => {}); replay.replay(f.snapshots); replay.recover("restart");
 assert.equal(replay.current()!.attempts[0]!.status, "interrupted"); assert.equal(replay.current()!.continuation.state, "suspended");
 const corrupt = structuredClone(f.snapshots.at(-1)!); (corrupt.data as any).state.serial = 0;
 replay.replay([...f.snapshots, corrupt]); assert.ok(replay.view().unavailable); assert.equal(replay.current(), undefined);
 const broken = createGoalStore(() => { throw new Error("disk failed"); });
 assert.equal((await broken.mutate(enroll, f.ctx, "enroll")).ok, false); assert.equal(broken.current(), undefined);
});

test("unsupported v1 snapshots fail closed without migration, fallback or history writes", async t => {
 const f = await fixture(t); await f.run(enroll);
 const before = structuredClone(f.snapshots);
 // Version rejection precedes payload parsing; neither readable nor corrupt v1 history is upgraded.
 for (const data of [{ schemaVersion: 1, state: { revision: 1, workset: { goal: "Old goal" } } }, { schemaVersion: 1 }]) {
  const old = { type: "custom", customType: "csheng-workflow-state", data };
  const history = [...before, old]; const unchanged = structuredClone(history);
  f.store.replay(history); f.store.recover("restart");
  assert.equal(f.store.current(), undefined);
  assert.match(f.store.view().unavailable!, /only v2 is supported/);
  assert.match(goalReceipt(f.store.view()), /unavailable/);
  assert.doesNotMatch(goalReceipt(f.store.view()), /migrateLegacy/);
  assert.match(goalRows(f.store.view(), 120).join("\n"), /state unavailable/);
  assert.equal((await f.store.mutate({ operation: "inspect" }, f.ctx, "inspect")).ok, true);
  assert.equal((await f.store.mutate(enroll, f.ctx, "enroll")).code, "state_unavailable");
  assert.equal((await f.store.mutate({ operation: "resume", reason: "continue", authority: "existing" }, f.ctx, "resume")).code, "state_unavailable");
  assert.deepEqual(history, unchanged); assert.deepEqual(f.snapshots, before);
 }
 // Navigating to a v2 or empty branch is not an automatic history repair.
 f.store.replay(before); assert.equal(f.store.current()?.version, 2);
 f.store.replay([]); await f.run(enroll); assert.equal(f.store.current()?.version, 2);
});

test("v2 snapshots keep inert historical migration provenance without loading a v1 reader", async t => {
 const f = await fixture(t); await f.run(enroll);
 const state = f.store.current()!;
 state.legacy = { revision: 4, id: "old-workset", goal: "Previous goal" };
 f.store.replay([{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 2, state } }]);
 assert.equal(f.store.view().unavailable, undefined); assert.deepEqual(f.store.current()!.legacy, state.legacy);
 await f.run({ operation: "start", task: "one", scope: ["one"] });
 assert.deepEqual(f.store.current()!.legacy, state.legacy);
});

test("async cancellation/input fences and read-only optional UI preserve committed state", async t => {
 const f = await fixture(t); await f.run(enroll); const before = f.store.current();
 const controller = new AbortController(); controller.abort();
 assert.equal((await f.store.mutate({ operation: "start", task: "one" }, { ...f.ctx, signal: controller.signal }, "cancelled")).code, "preparation_changed");
 assert.deepEqual(f.store.current(), before);
 const pending = f.store.mutate({ operation: "start", task: "one" }, f.ctx, "overlap"); f.store.delivered(false);
 assert.equal((await pending).code, "preparation_changed");
 const stable = f.store.current(); goalRows(f.store.view(), 3); goalRows(f.store.view(), 120); assert.deepEqual(f.store.current(), stable);
 f.store.subscribe(() => { throw new Error("UI failed"); });
 await f.run({ operation: "amend", authority: "existing", reason: "retain", alignment: "same goal" }); assert.equal(f.store.current()!.input.aligned, true);
});
