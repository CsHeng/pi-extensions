import assert from "node:assert/strict";
import test from "node:test";
import type { FailureResult, SuccessResult, WorkflowOperation, WorksetState } from "../extensions/workflow/contracts.ts";
import { applyOperation, buildView, computeDeficits, isTaskReady, markInputDelivered, validateState, type ReduceContext } from "../extensions/workflow/reducer.ts";

const CLOCK: ReduceContext = { now: "2026-09-17T00:00:00.000Z", cwd: "/repo", sessionId: "session-1" };

function openOp(overrides: Partial<Extract<WorkflowOperation, { operation: "open" }>> = {}): WorkflowOperation {
	return {
		operation: "open",
		expectedRevision: 0,
		goal: "Ship the workflow core",
		deliveryEndpoint: "reviewed source with passing deterministic tests",
		sourceReferences: ["docs/plans/changes/2026-09-17-task-workflow-plan.md"],
		authorityReferences: [{ description: "Implement WF-01..WF-08", source: "user approval 2026-09-17", limits: "local source, no publish" }],
		criteria: [
			{ key: "core", outcome: "Reducer enforces coverage and readiness", verification: "workflow-reducer tests" },
			{ key: "persistence", outcome: "Snapshots replay from the branch", verification: "workflow-persistence tests" },
		],
		tasks: [
			{ key: "reducer", outcome: "Implement the reducer", covers: ["core"] },
			{ key: "store", outcome: "Implement the store", covers: ["persistence"], dependsOn: ["reducer"] },
		],
		...overrides,
	};
}

function apply(state: WorksetState | undefined, operation: WorkflowOperation): SuccessResult {
	const result = applyOperation(state, operation, CLOCK);
	if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
	return result;
}

function rejects(state: WorksetState | undefined, operation: WorkflowOperation, code: FailureResult["code"]): FailureResult {
	const result = applyOperation(state, operation, CLOCK);
	assert.equal(result.ok, false, `expected ${code}`);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, code);
	return result;
}

function opened(): WorksetState {
	return apply(undefined, openOp()).state;
}

function recordEvidence(state: WorksetState, subject: { kind: "task" | "criterion" | "workset"; id: string }, fingerprint = `fp-${state.next.evidence}`): SuccessResult {
	return apply(state, {
		operation: "record",
		expectedRevision: state.revision,
		evidence: {
			provenance: "host_observed",
			subject,
			scope: ["extensions/workflow"],
			fingerprint,
			fingerprintState: "current",
			checkIdentity: "npm test -- workflow",
			result: "pass",
			exitCode: 0,
		},
	});
}

function acceptTask(state: WorksetState, taskId: string): SuccessResult {
	const withEvidence = recordEvidence(state, { kind: "task", id: taskId });
	const evidenceId = Object.keys(withEvidence.state.evidence).at(-1)!;
	return apply(withEvidence.state, { operation: "assess", expectedRevision: withEvidence.state.revision, subject: { kind: "task", id: taskId }, verdict: "accepted", evidenceIds: [evidenceId], rationale: "Outcome met with a current host-observed check." });
}

function acceptCriterion(state: WorksetState, criterionId: string): SuccessResult {
	const withEvidence = recordEvidence(state, { kind: "criterion", id: criterionId });
	const evidenceId = Object.keys(withEvidence.state.evidence).at(-1)!;
	return apply(withEvidence.state, { operation: "assess", expectedRevision: withEvidence.state.revision, subject: { kind: "criterion", id: criterionId }, verdict: "accepted", evidenceIds: [evidenceId], rationale: "Observable outcome verified." });
}

test("open allocates ids from temporary keys and computes readiness from accepted predecessors", () => {
	const state = opened();
	assert.equal(state.workset.id, "WS-1");
	assert.deepEqual(state.tasks.T1, undefined);
	assert.deepEqual(Object.keys(state.criteria).sort(), ["AC-1", "AC-2"]);
	assert.deepEqual(Object.keys(state.tasks).sort(), ["T-1", "T-2"]);
	assert.deepEqual(state.tasks["T-1"]!.covers, ["AC-1"]);
	assert.deepEqual(state.tasks["T-2"]!.dependsOn, ["T-1"]);
	assert.equal(state.tasks["T-1"]!.repositoryOwner, "/repo");
	assert.equal(isTaskReady(state, state.tasks["T-1"]!), true);
	assert.equal(isTaskReady(state, state.tasks["T-2"]!), false);
	assert.equal(state.workset.authorityReferences[0]!.id, "AUTH-1");
	assert.equal(validateState(state), undefined);

	const second = applyOperation(state, openOp(), CLOCK);
	assert.equal(second.ok, false);
	if (!second.ok) assert.equal(second.code, "workset_exists");
	assert.deepEqual((second as FailureResult).view?.tasks.map((task) => task.id), ["T-1", "T-2"]);
});

test("open rejects duplicate keys, unknown references, cycles and uncovered tasks", () => {
	rejects(undefined, openOp({ criteria: [{ key: "a", outcome: "A", verification: "v" }, { key: "a", outcome: "B", verification: "v" }] }), "duplicate_key");
	rejects(undefined, openOp({ tasks: [{ key: "a", outcome: "A", covers: ["AC-404"] }] }), "unknown_reference");
	rejects(undefined, openOp({ criteria: [{ key: "a", outcome: "A", verification: "v" }], tasks: [{ key: "a", outcome: "A", covers: ["a"], dependsOn: ["b"] }, { key: "b", outcome: "B", covers: ["a"], dependsOn: ["a"] }] }), "cycle");
	rejects(undefined, openOp({ tasks: [{ key: "a", outcome: "A" }] }), "invalid_payload");
	const state = opened();
	const coordination = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "add coordination",
		intentReference: "user message",
		changes: [{ kind: "add_task", key: "coord", outcome: "Coordinate", enablingPurpose: "Enable integration" }],
	});
	assert.equal(coordination.state.tasks["T-3"]!.enablingPurpose, "Enable integration");
});

test("start, record and assess follow task readiness and attempt state", () => {
	let state = opened();
	rejects(state, { operation: "start", expectedRevision: state.revision, taskId: "T-2" }, "not_ready");

	state = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }).state;
	assert.equal(state.tasks["T-1"]!.disposition, "running");
	rejects(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }, "attempt_open");

	state = apply(state, { operation: "record", expectedRevision: state.revision, attemptId: "AT-1", attempt: { state: "failed", outcome: "check failed" } }).state;
	assert.equal(state.tasks["T-1"]!.disposition, "pending");
	assert.equal(state.attempts["AT-1"]!.state, "failed");

	state = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }).state;
	assert.equal(state.attempts["AT-2"]!.state, "running");
	state = apply(state, { operation: "record", expectedRevision: state.revision, attemptId: "AT-2", attempt: { state: "reported", outcome: "implemented and checked" } }).state;
	assert.equal(state.tasks["T-1"]!.disposition, "awaiting_acceptance");

	rejects(state, { operation: "assess", expectedRevision: state.revision, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: [], rationale: "looks good" }, "evidence_required");
	state = recordEvidence(state, { kind: "task", id: "T-1" }).state;
	const evidenceId = Object.keys(state.evidence).at(-1)!;
	state = apply(state, { operation: "assess", expectedRevision: state.revision, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: [evidenceId], rationale: "Outcome met." }).state;
	assert.equal(state.tasks["T-1"]!.disposition, "accepted");
	assert.equal(state.decisions[state.tasks["T-1"]!.decisionId!]!.verdict, "accepted");
	assert.equal(isTaskReady(state, state.tasks["T-2"]!), true);
});

test("completion requires accepted criteria, accepted tasks, resolved attempts and delivery evidence", () => {
	let state = opened();
	const blocked = rejects(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "done" }, "completion_deficit");
	assert.ok(blocked.deficits?.some((deficit) => deficit.code === "unaccepted_criteria"));
	assert.ok(blocked.deficits?.some((deficit) => deficit.code === "missing_delivery_evidence"));

	state = acceptTask(state, "T-1").state;
	state = acceptCriterion(state, "AC-1").state;
	state = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-2" }).state;
	const unknownAttempt = state.tasks["T-2"]!.currentAttemptId!;
	state = apply(state, { operation: "record", expectedRevision: state.revision, attemptId: unknownAttempt, attempt: { state: "unknown", outcome: "no observation" } }).state;
	const unresolved = rejects(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "done" }, "completion_deficit");
	assert.ok(unresolved.deficits?.some((deficit) => deficit.code === "open_attempts" && deficit.ids.includes(unknownAttempt)));

	state = apply(state, { operation: "record", expectedRevision: state.revision, attemptId: unknownAttempt, attempt: { state: "interrupted", outcome: "reconciled from observed evidence: session ended" } }).state;
	state = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-2" }).state;
	const reportedAttempt = state.tasks["T-2"]!.currentAttemptId!;
	state = apply(state, { operation: "record", expectedRevision: state.revision, attemptId: reportedAttempt, attempt: { state: "reported", outcome: "stored" } }).state;
	state = acceptTask(state, "T-2").state;
	state = acceptCriterion(state, "AC-2").state;
	const delivery = recordEvidence(state, { kind: "workset", id: state.workset.id });
	const deliveryId = Object.keys(delivery.state.evidence).at(-1)!;
	state = delivery.state;
	rejects(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "done" }, "completion_deficit");
	state = apply(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "shipped", deliveryEvidenceIds: [deliveryId] }).state;
	assert.equal(state.workset.disposition, "closed");
	assert.equal(state.workset.closeOutcome, "completed");
	assert.deepEqual(computeDeficits(state), []);
});

test("expectedRevision guards every mutation and stale calls change nothing", () => {
	const state = opened();
	const before = structuredClone(state);
	const stale = rejects(state, { operation: "start", expectedRevision: state.revision + 5, taskId: "T-1" }, "stale_revision");
	assert.deepEqual(state, before);
	assert.equal(stale.view?.revision, state.revision);
	const inspect = applyOperation(state, { operation: "inspect", detail: { kind: "task", id: "T-2" } }, CLOCK);
	assert.equal(inspect.ok, true);
	if (inspect.ok) {
		assert.equal(inspect.state.revision, state.revision);
		assert.equal(inspect.view.records?.tasks?.[0]?.id, "T-2");
		assert.equal(inspect.view.records?.tasks?.[0]?.outcome, "Implement the store");
	}
});

test("delivered input requires alignment before obligation mutations", () => {
	let state = opened();
	state = markInputDelivered(state).state;
	assert.equal(state.workset.inputGeneration, 1);
	assert.equal(state.workset.alignment.state, "needs_alignment");
	assert.ok(computeDeficits(state).some((deficit) => deficit.code === "needs_alignment"));
	rejects(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }, "needs_alignment");
	rejects(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "done" }, "needs_alignment");

	const atomic = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1", alignInputGeneration: 1 });
	assert.equal(atomic.state.workset.alignment.state, "aligned");
	assert.equal(atomic.state.tasks["T-1"]!.disposition, "running");
	rejects(atomic.state, { operation: "align", expectedRevision: atomic.state.revision, inputGeneration: 0, action: "confirm" }, "invalid_payload");
	const aligned = apply(atomic.state, { operation: "align", expectedRevision: atomic.state.revision, inputGeneration: 1, action: "confirm" });
	assert.equal(aligned.state.workset.alignment.state, "aligned");
});

test("semantic task changes invalidate only that task, its evidence and its dependents", () => {
	let state = opened();
	const withUnrelated = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "add unrelated documentation work",
		intentReference: "user message",
		changes: [{ kind: "add_task", key: "docs", outcome: "Documentation", enablingPurpose: "Support the delivery without criterion coverage" }],
	});
	state = withUnrelated.state;
	state = recordEvidence(state, { kind: "task", id: "T-3" }, "fp-untouched").state;
	const untouchedEvidence = Object.keys(state.evidence).at(-1)!;
	state = acceptTask(state, "T-1").state;
	state = acceptCriterion(state, "AC-1").state;
	assert.equal(state.tasks["T-1"]!.disposition, "accepted");

	const cosmetic = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "clarify wording only",
		intentReference: "user message",
		changes: [{ kind: "update_task", id: "T-1", outcome: state.tasks["T-1"]!.outcome }],
	});
	assert.equal(cosmetic.state.tasks["T-1"]!.disposition, "accepted");
	assert.equal(cosmetic.state.tasks["T-1"]!.semanticRevision, 1);
	assert.equal(cosmetic.state.amendments["AM-1"]!.affected.evidence.length, 0);

	const changed = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "reducer contract changed",
		intentReference: "user message",
		changes: [{ kind: "update_task", id: "T-1", outcome: "Implement the reducer with the new contract" }],
	});
	assert.equal(changed.state.tasks["T-1"]!.semanticRevision, 2);
	assert.equal(changed.state.tasks["T-1"]!.disposition, "pending");
	assert.equal(changed.state.tasks["T-2"]!.disposition, "pending");
	assert.equal(changed.state.criteria["AC-1"]!.disposition, "accepted", "criterion acceptance rests on criterion-bound evidence, not task evidence");
	const taskEvidence = Object.values(changed.state.evidence).find((record) => record.subject.kind === "task" && record.subject.id === "T-1")!;
	assert.equal(taskEvidence.freshness, "stale");
	assert.equal(changed.state.evidence[untouchedEvidence]!.freshness, "current", "unrelated evidence stays current");
	assert.ok(changed.state.amendments["AM-2"]!.affected.tasks.includes("T-1"));
	assert.ok(changed.state.amendments["AM-2"]!.affected.tasks.includes("T-2"));
	assert.equal(changed.state.amendments["AM-2"]!.affected.evidence.includes(taskEvidence.id), true);
});

test("criterion semantics invalidate its evidence and covering tasks", () => {
	let state = opened();
	state = acceptTask(state, "T-1").state;
	state = acceptCriterion(state, "AC-1").state;
	const changed = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "acceptance moved to integration level",
		intentReference: "user message",
		changes: [{ kind: "update_criterion", id: "AC-1", verification: "integration suite" }],
	});
	assert.equal(changed.state.criteria["AC-1"]!.semanticRevision, 2);
	assert.equal(changed.state.criteria["AC-1"]!.disposition, "unverified");
	assert.equal(changed.state.tasks["T-1"]!.disposition, "pending");
	assert.equal(changed.state.evidence["EV-1"]!.freshness, "stale");
});

test("split, merge and replacement preserve lineage, coverage and dependent order", () => {
	let state = opened();
	const split = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "reducer slice splits",
		intentReference: "user message",
		changes: [{ kind: "split_task", id: "T-1", into: [{ key: "reducer-core", outcome: "Core transitions", covers: ["AC-1"] }, { key: "reducer-limits", outcome: "Limits", covers: ["AC-1"] }] }],
	});
	state = split.state;
	assert.equal(state.tasks["T-1"]!.disposition, "superseded");
	assert.deepEqual(state.tasks["T-3"]!.lineage, { relation: "split", sourceIds: ["T-1"] });
	assert.deepEqual(state.tasks["T-4"]!.lineage, { relation: "split", sourceIds: ["T-1"] });
	assert.deepEqual(state.tasks["T-2"]!.dependsOn.sort(), ["T-3", "T-4"]);
	assert.equal(state.tasks["T-2"]!.semanticRevision, 2);
	assert.equal(split.mapping?.["reducer-core"], "T-3");

	const merged = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "merge the split back",
		intentReference: "user message",
		changes: [{ kind: "merge_tasks", ids: ["T-3", "T-4"], key: "reducer", outcome: "Reducer again", covers: ["AC-1"] }],
	});
	assert.equal(merged.state.tasks["T-5"]!.lineage?.relation, "merge");
	assert.deepEqual(merged.state.tasks["T-5"]!.dependsOn, []);
	assert.deepEqual(merged.state.tasks["T-2"]!.dependsOn, ["T-5"]);
	assert.deepEqual(merged.state.tasks["T-5"]!.covers.sort(), ["AC-1"]);
});

test("amendments reject coverage loss and allow authorized criterion retirement", () => {
	const state = opened();
	const lost = rejects(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "drop the core slice",
		intentReference: "user message",
		changes: [{ kind: "cancel_task", id: "T-1", reason: "not needed" }],
	}, "coverage_loss");
	assert.ok(lost.message.includes("AC-1"));

	const retired = apply(state, {
		operation: "amend",
		expectedRevision: state.revision,
		reason: "the outcome no longer applies",
		intentReference: "user message",
		changes: [{ kind: "retire_criterion", id: "AC-1", reason: "superseded by the delivery endpoint" }, { kind: "cancel_task", id: "T-1", reason: "no longer required" }],
	});
	assert.equal(retired.state.criteria["AC-1"]!.disposition, "retired");
	assert.equal(retired.state.criteria["AC-1"]!.retired?.reason, "superseded by the delivery endpoint");
	assert.equal(retired.state.tasks["T-1"]!.disposition, "cancelled");

	const running = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" });
	rejects(running.state, {
		operation: "amend",
		expectedRevision: running.state.revision,
		reason: "change while running",
		intentReference: "user message",
		changes: [{ kind: "update_task", id: "T-1", outcome: "Different" }],
	}, "invalid_transition");
});

test("cancel closes unmet obligations without fabricating acceptance", () => {
	let state = opened();
	state = acceptTask(state, "T-1").state;
	state = acceptCriterion(state, "AC-1").state;
	state = apply(state, { operation: "close", expectedRevision: state.revision, outcome: "cancelled", reason: "user changed direction" }).state;
	assert.equal(state.workset.disposition, "closed");
	assert.equal(state.workset.closeOutcome, "cancelled");
	assert.equal(state.tasks["T-1"]!.disposition, "accepted");
	assert.equal(state.tasks["T-2"]!.disposition, "cancelled");
	assert.equal(state.criteria["AC-1"]!.disposition, "accepted");
	assert.equal(state.criteria["AC-2"]!.disposition, "unverified");

	const reopened = apply(state, openOp({ goal: "New goal", criteria: [{ key: "next", outcome: "Next", verification: "next check" }], tasks: [{ key: "next", outcome: "Next task", covers: ["next"] }] }));
	assert.equal(reopened.state.workset.id, "WS-2");
	assert.equal(reopened.state.pastWorksets["WS-1"]!.closeOutcome, "cancelled");
	assert.equal(reopened.state.tasks["T-1"]!.worksetId, "WS-1");
	assert.ok(reopened.state.tasks["T-3"]);
	assert.equal(validateState(reopened.state), undefined);
	assert.equal(applyOperation(state, { operation: "pause", expectedRevision: state.revision, reason: "late" }, CLOCK).ok, false);
});

test("pause and resume gate obligation mutations", () => {
	let state = opened();
	state = apply(state, { operation: "pause", expectedRevision: state.revision, reason: "waiting on user" }).state;
	assert.equal(state.workset.disposition, "paused");
	rejects(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }, "invalid_transition");
	const closed = rejects(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "done" }, "completion_deficit");
	assert.ok(closed.deficits?.some((deficit) => deficit.code === "workset_not_active"));
	state = apply(state, { operation: "resume", expectedRevision: state.revision }).state;
	assert.equal(state.workset.disposition, "active");
	state = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }).state;
	assert.equal(state.tasks["T-1"]!.disposition, "running");
});

test("reducer limits and validation reject over-limit snapshots without partial state", () => {
	const many = Array.from({ length: 65 }, (_, index) => ({ key: `t${index}`, outcome: "task", covers: ["core"] }));
	rejects(undefined, openOp({ tasks: many }), "limit_exceeded");
	const state = opened();
	rejects(state, { operation: "open", expectedRevision: 0, goal: "x", deliveryEndpoint: "y", criteria: [{ key: "a", outcome: "A", verification: "v" }], tasks: [{ key: "a", outcome: "A", covers: ["a"] }] }, "workset_exists");
	assert.equal(validateState({ ...state, revision: 0 }), "invalid revision");
	assert.equal(validateState({ ...state, tasks: { ...state.tasks, "T-2": { ...state.tasks["T-2"]!, dependsOn: ["T-404"] } } }), "task T-2 references unknown dependency T-404");
});

test("a changed basis invalidates the acceptance that rested on it and keeps completion blocked", () => {
	let state = opened();
	state = acceptTask(state, "T-1").state;
	state = acceptCriterion(state, "AC-1").state;
	const taskDecisionId = state.tasks["T-1"]!.decisionId!;
	const taskEvidence = state.decisions[taskDecisionId]!.evidenceIds[0]!;
	const refreshed = apply(state, { operation: "refresh", expectedRevision: state.revision, fingerprints: { [taskEvidence]: "fp-changed" } });
	state = refreshed.state;
	assert.equal(state.tasks["T-1"]!.disposition, "pending", "a task acceptance cannot outlive its binding");
	assert.equal(state.tasks["T-1"]!.decisionId, undefined);
	assert.equal(state.decisions[taskDecisionId]!.verdict, "unresolved_verification");
	assert.equal(state.criteria["AC-1"]!.disposition, "accepted", "an unaffected criterion keeps its acceptance");
	assert.equal(state.evidence[taskEvidence]!.freshness, "stale");

	const delivery = recordEvidence(state, { kind: "workset", id: state.workset.id });
	const closed = applyOperation(delivery.state, { operation: "close", expectedRevision: delivery.state.revision, outcome: "completed", reason: "done", deliveryEvidenceIds: [Object.keys(delivery.state.evidence).at(-1)!] }, CLOCK);
	assert.equal(closed.ok, false, "completion cannot pass while the reverted acceptance is unresolved");
	if (closed.ok) return;
	assert.equal(closed.code, "completion_deficit");
	assert.match(JSON.stringify(closed.deficits), /T-1/);
});

test("branch reset reconciles attempts that no live process owns and forces alignment on fork", () => {
	let state = opened();
	const started = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" });
	state = started.state;
	assert.equal(state.tasks["T-1"]!.disposition, "running");
	const reconciled = apply(state, { operation: "branch_reset", expectedRevision: state.revision, reason: "fork", align: true });
	state = reconciled.state;
	assert.equal(state.attempts["AT-1"]!.state, "interrupted", "a copied running attempt is not still running");
	assert.match(state.attempts["AT-1"]!.outcome ?? "", /reconciled on fork/);
	assert.equal(state.tasks["T-1"]!.disposition, "pending");
	assert.equal(state.workset.alignment.state, "needs_alignment");
	assert.equal(state.workset.inputGeneration, 1, "fork navigation opens a new alignment generation");
	assert.equal(state.workset.review.used, 0, "the copied allowance does not carry into the new execution");
	rejects(state, { operation: "start", expectedRevision: state.revision, taskId: "T-1" }, "needs_alignment");
});

test("state validation rejects missing collections instead of throwing", () => {
	const state = opened();
	assert.equal(validateState({ ...state, tasks: undefined as unknown as WorksetState["tasks"] }), "missing tasks");
	assert.equal(validateState({ ...state, evidence: null as unknown as WorksetState["evidence"] }), "missing evidence");
	assert.equal(validateState({ ...state, next: { ...state.next, task: -1 } }), "invalid task counter");
});

test("an unresolved judgment revokes a standing acceptance", () => {
	let state = opened();
	state = acceptTask(state, "T-1").state;
	state = acceptCriterion(state, "AC-1").state;
	const unresolvedTask = apply(state, { operation: "assess", expectedRevision: state.revision, subject: { kind: "task", id: "T-1" }, verdict: "unresolved_verification", evidenceIds: [], rationale: "cannot verify yet" });
	state = unresolvedTask.state;
	assert.equal(state.tasks["T-1"]!.disposition, "pending");
	assert.equal(state.tasks["T-1"]!.decisionId, undefined);
	const unresolvedCriterion = apply(state, { operation: "assess", expectedRevision: state.revision, subject: { kind: "criterion", id: "AC-1" }, verdict: "unresolved_verification", evidenceIds: [], rationale: "cannot verify yet" });
	state = unresolvedCriterion.state;
	assert.equal(state.criteria["AC-1"]!.disposition, "unverified");
	assert.equal(state.criteria["AC-1"]!.decisionId, undefined);
	const delivery = recordEvidence(state, { kind: "workset", id: state.workset.id });
	const closed = applyOperation(delivery.state, { operation: "close", expectedRevision: delivery.state.revision, outcome: "completed", reason: "done", deliveryEvidenceIds: [Object.keys(delivery.state.evidence).at(-1)!] }, CLOCK);
	assert.equal(closed.ok, false, "explicit unresolved judgments cannot close as completed");
});

test("a changed predecessor contract fences dependent attempts and acceptances", () => {
	let state = opened();
	const acceptedA = acceptTask(state, "T-1");
	state = acceptedA.state;
	const startedB = apply(state, { operation: "start", expectedRevision: state.revision, taskId: "T-2" });
	state = startedB.state;
	assert.equal(state.attempts["AT-1"]!.state, "running");
	const amended = apply(state, { operation: "amend", expectedRevision: state.revision, reason: "predecessor contract changed", intentReference: "test", changes: [{ kind: "update_task", id: "T-1", outcome: "Changed A" }] });
	state = amended.state;
	assert.equal(state.tasks["T-1"]!.disposition, "pending");
	assert.equal(state.attempts["AT-1"]!.state, "interrupted", "the dependent execution is fenced against the superseded predecessor");
	assert.equal(state.tasks["T-2"]!.disposition, "pending");
	const reported = applyOperation(state, { operation: "record", expectedRevision: state.revision, attemptId: "AT-1", attempt: { state: "reported", outcome: "old work" } }, CLOCK);
	assert.equal(reported.ok, false, "a fenced attempt cannot report an outcome");
	if (!reported.ok) assert.equal(reported.code, "invalid_transition");
	const rebound = applyOperation(state, {
		operation: "record",
		expectedRevision: state.revision,
		evidence: { provenance: "agent_declared", attemptId: "AT-1", subject: { kind: "task", id: "T-2" }, fingerprint: "fp", fingerprintState: "current", checkIdentity: "old check", result: "pass" },
	}, CLOCK);
	assert.equal(rebound.ok, false, "a fenced attempt cannot be cited as evidence either");
	if (!rebound.ok) assert.equal(rebound.code, "invalid_transition");
});

test("a retired criterion stops being a completion obligation while remaining history", () => {
	let state = opened();
	const amended = apply(state, { operation: "amend", expectedRevision: state.revision, reason: "user removed the goal", intentReference: "test", changes: [{ kind: "retire_criterion", id: "AC-1", reason: "no longer required" }, { kind: "cancel_task", id: "T-1", reason: "no longer required" }, { kind: "update_task", id: "T-2", dependsOn: [] }] });
	state = amended.state;
	assert.equal(state.criteria["AC-1"]!.disposition, "retired");
	const covered = acceptTask(state, "T-2");
	const secondCriterion = acceptCriterion(covered.state, "AC-2");
	state = secondCriterion.state;
	const delivery = recordEvidence(state, { kind: "workset", id: state.workset.id });
	const closed = apply(delivery.state, { operation: "close", expectedRevision: delivery.state.revision, outcome: "completed", reason: "only current obligations remain", deliveryEvidenceIds: [Object.keys(delivery.state.evidence).at(-1)!] });
	assert.equal(closed.state.workset.closeOutcome, "completed");
});

test("a goal amendment advances the revision and invalidates workset bindings", () => {
	let state = opened();
	const accepted = acceptCriterion(state, "AC-1");
	state = accepted.state;
	const delivery = recordEvidence(state, { kind: "workset", id: state.workset.id });
	state = delivery.state;
	const deliveryId = Object.keys(state.evidence).at(-1)!;
	const amended = apply(state, { operation: "amend", expectedRevision: state.revision, reason: "user changed the endpoint", intentReference: "test", changes: [{ kind: "update_goal", deliveryEndpoint: "a new reviewed endpoint" }] });
	state = amended.state;
	assert.equal(state.workset.goalRevision, 2, "the goal revision advances");
	assert.equal(state.evidence[deliveryId]!.freshness, "stale", "prior workset bindings cannot certify the new intent");
	assert.ok(computeDeficits(state).some((deficit) => deficit.code === "needs_alignment"), "the new goal revision needs explicit alignment");
	const aligned = apply(state, { operation: "align", expectedRevision: state.revision, action: "confirm", inputGeneration: state.workset.inputGeneration });
	state = aligned.state;
	assert.equal(isAlignedState(state), true);
	const closed = applyOperation(state, { operation: "close", expectedRevision: state.revision, outcome: "completed", reason: "stale delivery evidence", deliveryEvidenceIds: [deliveryId] }, CLOCK);
	assert.equal(closed.ok, false, "the endpoint must be verified again after the change");
});

function isAlignedState(state: WorksetState): boolean {
	return state.workset.alignment.state === "aligned" && state.workset.alignment.goalRevision === state.workset.goalRevision;
}

test("replay validation rejects counters that would reallocate a retained identity", () => {
	const state = opened();
	assert.equal(validateState({ ...state, next: { ...state.next, task: 1 } }), "invalid task counter below retained identity 2");
	const bad = structuredClone(state);
	bad.next.task = 1;
	assert.equal(validateState(bad), "invalid task counter below retained identity 2");
	bad.next.task = state.next.task;
	assert.equal(validateState(bad), undefined, "a consistent counter still validates");
});

test("task titles stay short, ride through amendments, and completion needs a live required criterion", () => {
	let state = apply(undefined, {
		operation: "open", expectedRevision: 0, goal: "Titles and guards", deliveryEndpoint: "Reviewed source",
		criteria: [{ key: "c", outcome: "Works", verification: "Tests" }],
		tasks: [
			{ key: "a", title: "Rewrite trigger copy", outcome: "Rewrite the registerTool copy in extensions/workflow/tool.ts", covers: ["c"] },
			{ key: "b", outcome: "Long outcome without a title", covers: ["c"] },
		],
	}).state;
	assert.equal(state.tasks["T-1"]!.title, "Rewrite trigger copy");
	assert.equal(state.tasks["T-2"]!.title, undefined);
	assert.equal(buildView(state).tasks.find((task) => task.id === "T-1")!.title, "Rewrite trigger copy");

	state = apply(state, { operation: "amend", expectedRevision: state.revision, reason: "more work", intentReference: "test", changes: [{ kind: "add_task", key: "c", title: "Guard close", outcome: "Block vacuous completion", covers: ["AC-1"] }] }).state;
	assert.equal(state.tasks["T-3"]!.title, "Guard close");
	state = apply(state, { operation: "amend", expectedRevision: state.revision, reason: "scope shift", intentReference: "test", changes: [{ kind: "replace_task", id: "T-2", key: "b2", title: "New task", outcome: "Replacement outcome", covers: ["AC-1"] }] }).state;
	assert.equal(state.tasks["T-4"]!.title, "New task");

	const retired = apply(state, { operation: "amend", expectedRevision: state.revision, reason: "dropped", intentReference: "test", changes: [
		{ kind: "retire_criterion", id: "AC-1", reason: "obsolete" },
		{ kind: "cancel_task", id: "T-1", reason: "obsolete" },
		{ kind: "cancel_task", id: "T-3", reason: "obsolete" },
		{ kind: "cancel_task", id: "T-4", reason: "obsolete" },
	] }).state;
	assert.ok(computeDeficits(retired).some((deficit) => deficit.code === "no_required_criteria"));
	const blocked = rejects(retired, { operation: "close", expectedRevision: retired.revision, outcome: "completed", reason: "done" }, "completion_deficit");
	assert.ok(blocked.deficits?.some((deficit) => deficit.code === "no_required_criteria"));
	const restored = apply(retired, { operation: "amend", expectedRevision: retired.revision, reason: "replacement contract", intentReference: "test", changes: [{ kind: "add_criterion", key: "c2", outcome: "Replacement met", verification: "Tests" }] }).state;
	assert.ok(!computeDeficits(restored).some((deficit) => deficit.code === "no_required_criteria"));
});
