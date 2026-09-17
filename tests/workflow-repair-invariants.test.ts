import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createWorkflowStore } from "../extensions/workflow/store.ts";
import { prepareOperation } from "../extensions/workflow/tool.ts";
import { createObservationIndex } from "../extensions/workflow/observation.ts";
import { fingerprintScope } from "../extensions/workflow/fingerprints.ts";
import { computeDeficits, validateState } from "../extensions/workflow/reducer.ts";
import { hasActionableDeficit, progressFingerprint } from "../extensions/workflow/review.ts";
import type { WorkflowOperation, OpenTaskInput, OpenCriterionInput } from "../extensions/workflow/contracts.ts";

async function fixture(t: test.TestContext, tasks: OpenTaskInput[] = [{ key: "t", outcome: "Task", covers: ["c"] }], criteria: OpenCriterionInput[] = [{ key: "c", outcome: "Criterion", verification: "check" }]) {
	const root = await mkdtemp(join(tmpdir(), "workflow-repair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "basis"), "stable");
	const context = { now: new Date().toISOString(), cwd: root, sessionId: "fixture" };
	const store = createWorkflowStore({ append() {} });
	const observations = createObservationIndex();
	let serial = 0;
	assert.equal(store.apply({ operation: "open", expectedRevision: 0, goal: "Fixture", deliveryEndpoint: "source", tasks, criteria }, context, "open").ok, true);
	async function tryApply(operation: Record<string, unknown>) {
		const input = { expectedRevision: store.current()!.revision, ...operation } as WorkflowOperation;
		const prepared = await prepareOperation(input, { store, observations, ...context });
		return prepared.ok ? store.apply(prepared.operation, context, `call-${++serial}`) : prepared;
	}
	async function apply(operation: Record<string, unknown>) {
		const result = await tryApply(operation);
		if (!result.ok) throw new Error(`${operation.operation}: ${result.code}: ${result.message}`);
		return result;
	}
	async function evidence(kind: "task" | "criterion" | "workset", id: string, attemptId?: string) {
		await apply({ operation: "record", evidence: { provenance: "agent_declared", subject: { kind, id }, checkIdentity: "check", result: "pass", scope: ["basis"], ...(attemptId ? { attemptId } : {}) } });
		return `EV-${store.current()!.next.evidence - 1}`;
	}
	async function assess(kind: "task" | "criterion", id: string, evidenceIds: string[], verdict = "accepted") {
		await apply({ operation: "assess", subject: { kind, id }, verdict, evidenceIds, rationale: "Fixture judgment" });
	}
	async function start(taskId: string) {
		await apply({ operation: "start", taskId, basis: { scope: ["basis"] } });
		return `AT-${store.current()!.next.attempt - 1}`;
	}
	async function report(attemptId: string, state = "reported", outcome = "same result") {
		await apply({ operation: "record", attemptId, attempt: { state, outcome } });
	}
	return { root, store, context, apply, tryApply, evidence, assess, start, report };
}

test("fencing criterion evidence revokes acceptance and blocks completed closure", async (t) => {
	const f = await fixture(t);
	const oldAttempt = await f.start("T-1"); await f.report(oldAttempt);
	const oldEvidence = await f.evidence("criterion", "AC-1", oldAttempt);
	await f.assess("criterion", "AC-1", [oldEvidence]);
	await f.apply({ operation: "amend", reason: "changed contract", intentReference: "user", changes: [{ kind: "update_task", id: "T-1", outcome: "new contract" }] });
	const attempt = await f.start("T-1"); await f.report(attempt);
	await f.assess("task", "T-1", [await f.evidence("task", "T-1", attempt)]);
	const delivery = await f.evidence("workset", "WS-1");
	assert.equal(f.store.current()!.evidence[oldEvidence]!.freshness, "stale");
	assert.equal(f.store.current()!.criteria["AC-1"]!.disposition, "unverified");
	const result = await f.tryApply({ operation: "close", outcome: "completed", reason: "done", deliveryEvidenceIds: [delivery] });
	assert.equal(result.ok, false);
});

test("all retained dependent executions are fenced by a predecessor amendment", async (t) => {
	const f = await fixture(t, [{ key: "a", outcome: "A", covers: ["c"] }, { key: "b", outcome: "B", covers: ["c"], dependsOn: ["a"] }]);
	await f.assess("task", "T-1", [await f.evidence("task", "T-1")]);
	const historical = await f.start("T-2"); await f.report(historical);
	await f.assess("task", "T-2", [], "rejected");
	await f.report(await f.start("T-2"), "failed");
	await f.apply({ operation: "amend", reason: "predecessor changed", intentReference: "user", changes: [{ kind: "update_task", id: "T-1", outcome: "new A" }] });
	await f.assess("task", "T-1", [await f.evidence("task", "T-1")]);
	assert.equal(f.store.current()!.attempts[historical]!.state, "interrupted");
	const result = await f.tryApply({ operation: "record", evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-2" }, checkIdentity: "check", result: "pass", scope: ["basis"], attemptId: historical } });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "invalid_transition");
});

test("missing allocation counters fail replay and mutation rather than allocating invalid ids", async (t) => {
	const f = await fixture(t);
	const bad = structuredClone(f.store.current()!);
	Reflect.deleteProperty(bad.next, "task");
	assert.match(validateState(bad) ?? "", /counter/);
	f.store.replay([{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 1, revision: bad.revision, state: bad } }]);
	assert.match(f.store.recovery() ?? "", /counter/);
	const result = f.store.apply({ operation: "amend", expectedRevision: bad.revision, reason: "add", intentReference: "user", changes: [{ kind: "add_task", key: "new", outcome: "new", covers: ["AC-1"] }] }, f.context, "add");
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "state_unavailable");
});

for (const change of ["rejected", "unresolved_verification", "refresh"] as const) {
	test(`${change} of accepted predecessor evidence fences dependent judgments and attempts`, async (t) => {
		const f = await fixture(t, [{ key: "a", outcome: "A", covers: ["c"] }, { key: "b", outcome: "B", covers: ["c"], dependsOn: ["a"] }]);
		const predecessorEvidence = await f.evidence("task", "T-1");
		await f.assess("task", "T-1", [predecessorEvidence]);
		const attempt = await f.start("T-2"); await f.report(attempt);
		await f.assess("task", "T-2", [await f.evidence("task", "T-2", attempt)]);
		await f.assess("criterion", "AC-1", [await f.evidence("criterion", "AC-1", attempt)]);
		if (change === "refresh") await f.apply({ operation: "refresh", fingerprints: { [predecessorEvidence]: "changed" } });
		else await f.assess("task", "T-1", [], change);
		assert.equal(f.store.current()!.tasks["T-2"]!.disposition, "pending");
		assert.equal(f.store.current()!.attempts[attempt]!.state, "interrupted");
		assert.equal(f.store.current()!.criteria["AC-1"]!.disposition, "unverified");
		const rebound = f.store.apply({ operation: "record", expectedRevision: f.store.current()!.revision,
			evidence: { provenance: "agent_declared", subject: { kind: "criterion", id: "AC-1" }, attemptId: attempt, checkIdentity: "old", result: "pass", fingerprint: "old", fingerprintState: "current" },
		}, f.context, "raw-rebind");
		assert.equal(rebound.ok, false, "the reducer itself fences rebinding regardless of rationale prose");
	});
}

test("already-interrupted attempts lose prior criterion bindings on semantic amendment", async (t) => {
	const f = await fixture(t);
	const attempt = await f.start("T-1");
	const evidence = await f.evidence("criterion", "AC-1", attempt);
	await f.report(attempt, "interrupted", "cancelled after the check");
	await f.assess("criterion", "AC-1", [evidence]);
	await f.apply({ operation: "amend", reason: "changed", intentReference: "user", changes: [{ kind: "update_task", id: "T-1", outcome: "new contract" }] });
	assert.equal(f.store.current()!.evidence[evidence]!.freshness, "stale");
	assert.equal(f.store.current()!.criteria["AC-1"]!.disposition, "unverified");
});

test("compound record cannot interrupt an attempt then bind current evidence in the same mutation", async (t) => {
	const f = await fixture(t);
	const attempt = await f.start("T-1");
	const result = await f.tryApply({ operation: "record", attemptId: attempt, attempt: { state: "interrupted", outcome: "cancelled" },
		evidence: { provenance: "agent_declared", subject: { kind: "criterion", id: "AC-1" }, attemptId: attempt, checkIdentity: "check", result: "pass", scope: ["basis"] },
	});
	assert.equal(result.ok, false);
	assert.equal(f.store.current()!.attempts[attempt]!.state, "running", "a rejected compound operation makes no partial commit");
});

test("closure independently refuses a legacy acceptance supported by stale evidence", async (t) => {
	const f = await fixture(t);
	const id = await f.evidence("criterion", "AC-1");
	await f.assess("criterion", "AC-1", [id]);
	const state = structuredClone(f.store.current()!);
	state.evidence[id]!.freshness = "stale";
	assert.ok(computeDeficits(state).some((deficit) => deficit.code === "unaccepted_criteria" && deficit.ids.includes("AC-1")));
});

test("a chained symlink cannot certify an unobserved effective input", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, "target"), "A");
	await symlink("target", join(f.root, "intermediate"));
	await symlink("intermediate", join(f.root, "link"));
	const before = await fingerprintScope(["link"], f.root);
	await writeFile(join(f.root, "target"), "B");
	const after = await fingerprintScope(["link"], f.root);
	assert.ok(before.state === "unavailable" || after.state === "unavailable" || before.fingerprint !== after.fingerprint);
});

test("rewording an unchanged failed outcome is not progress", async (t) => {
	const f = await fixture(t);
	await f.report(await f.start("T-1"), "failed", "check failed");
	const before = progressFingerprint(f.store.current()!);
	await f.report(await f.start("T-1"), "failed", "same check failed again");
	assert.equal(progressFingerprint(f.store.current()!), before);
});

test("accepted task checkboxes do not hide outstanding criterion acceptance from reconciliation", async (t) => {
	const f = await fixture(t);
	await f.assess("task", "T-1", [await f.evidence("task", "T-1")]);
	await f.evidence("workset", "WS-1");
	assert.deepEqual(computeDeficits(f.store.current()!).map((deficit) => deficit.code), ["unaccepted_criteria"]);
	assert.equal(hasActionableDeficit(f.store.current()!, computeDeficits(f.store.current()!)), true);
});

test("retired obligations do not make explicitly waiting current work actionable", async (t) => {
	const f = await fixture(t, [{ key: "a", outcome: "A", covers: ["a"] }, { key: "b", outcome: "B", covers: ["b"] }], [{ key: "a", outcome: "A", verification: "check" }, { key: "b", outcome: "B", verification: "check" }]);
	await f.apply({ operation: "amend", reason: "A retired", intentReference: "user", changes: [{ kind: "retire_criterion", id: "AC-1", reason: "retired" }, { kind: "cancel_task", id: "T-1", reason: "retired" }] });
	await f.apply({ operation: "record", attemptId: await f.start("T-2"), attempt: { state: "failed", outcome: "waiting" }, taskDisposition: { disposition: "blocked", blockClass: "needs_authority", nextUnblockCondition: "user grants authority" } });
	assert.equal(hasActionableDeficit(f.store.current()!, computeDeficits(f.store.current()!)), false);
});
