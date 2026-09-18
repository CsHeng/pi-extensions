import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalStore, canonicalScope, type GoalContext } from "../extensions/workflow/goal-store.ts";
import { accepted, progressKey } from "../extensions/workflow/goal-state.ts";
import type { GoalOperation } from "../extensions/workflow/goal-contracts.ts";
import { createWorkflowStore } from "../extensions/workflow/store.ts";
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
 assert.deepEqual(await canonicalScope(["./one", join(f.cwd, "one")], f.cwd), ["one"]);
 await symlink(tmpdir(), join(f.cwd, "escape"));
 await assert.rejects(canonicalScope(["escape/outside"], f.cwd), /outside/);
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
 const oldReader = createWorkflowStore({ append() {} }); oldReader.replay(f.snapshots); assert.match(oldReader.recovery()!, /unsupported workflow schema/);
});

test("legacy fixtures are readable only and migrate preserving requirements without fresh permission", async t => {
 const f = await fixture(t); const snapshots: any[] = [];
 const old = createWorkflowStore({ append(customType, data) { snapshots.push({ type: "custom", customType, data }); } });
 const result = old.apply({ operation: "open", expectedRevision: 0, goal: "Implement goal", deliveryEndpoint: "source only", criteria: [{ key: "a", outcome: "first", verification: "check" }], tasks: [{ key: "t", outcome: "first", covers: ["a"] }] }, f.ctx, "old");
 assert.equal(result.ok, true);
 const verifyLegacy = () => {
  const reader = createGoalStore(() => {}); reader.replay(snapshots);
  assert.equal(reader.view().unavailable, undefined); assert.equal(reader.current(), undefined); assert.ok(reader.view().legacy);
 };
 verifyLegacy();
 assert.equal(old.apply({ operation: "start", expectedRevision: old.current()!.revision, taskId: "T-1", basis: { scope: ["one"], fingerprint: "basis", fingerprintState: "current" } }, f.ctx, "old-start").ok, true);
 assert.equal(old.apply({ operation: "record", expectedRevision: old.current()!.revision, attemptId: "AT-1", attempt: { state: "failed", outcome: "missing prerequisite" }, taskDisposition: { disposition: "blocked", reason: "missing", blockClass: "missing_capability", nextUnblockCondition: "restore" } }, f.ctx, "old-blocked").ok, true);
 verifyLegacy(); assert.equal(old.current()!.tasks["T-1"]!.disposition, "blocked");
 assert.equal(old.apply({ operation: "record", expectedRevision: old.current()!.revision, evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "declared legacy check", fingerprint: "basis", fingerprintState: "current", result: "pass" } }, f.ctx, "old-proof").ok, true);
 assert.equal(old.apply({ operation: "assess", expectedRevision: old.current()!.revision, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "legacy judgment" }, f.ctx, "old-accepted").ok, true);
 verifyLegacy(); assert.equal(old.current()!.tasks["T-1"]!.disposition, "accepted");
 assert.equal(old.apply({ operation: "close", expectedRevision: old.current()!.revision, outcome: "cancelled", reason: "legacy cancelled" }, f.ctx, "old-close").ok, true);
 verifyLegacy();
 f.store.replay(snapshots); assert.ok(f.store.view().legacy);
 assert.equal((await f.store.mutate(enroll, f.ctx, "implicit")).code, "migration_required");
 assert.equal((await f.store.mutate({ ...enroll, requirements: [enroll.requirements![1]!], migrateLegacy: true }, f.ctx, "dropped")).code, "migration_required");
 await f.run({ ...enroll, migrateLegacy: true }); assert.equal(f.store.current()!.acceptance.length, 0); assert.ok(f.store.current()!.legacy);
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
