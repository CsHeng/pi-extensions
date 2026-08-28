import assert from "node:assert/strict";
import test from "node:test";

import { acceptWorkerResult, completeVerifiedTask, recordVerification, startTaskAttempt } from "../extensions/workflow-harness/execution.ts";
import { newSessionState } from "../extensions/workflow-harness/session-state.ts";
import { pendingSettlementReasons, settle } from "../extensions/workflow-harness/settlement.ts";
import { admitTaskGraph, initialProgress } from "../extensions/workflow-harness/task-graph.ts";

function graph() {
	return admitTaskGraph({
		schemaVersion: 1, graphId: "graph-1", requestId: "request-1", approved: true, rootFormalRole: "none", terminalTaskIds: ["A"],
		tasks: [{ taskId: "A", description: "synthetic", dependsOn: [], readPaths: [], writePaths: ["src/slice"], resourceLocks: [], isolation: "controller-checkout", verification: ["verify-A"], doneWhen: ["done-A"], review: { required: false, reasons: [] }, attemptLimit: 1, recovery: "fix-forward" }],
	});
}

test("settlement waits for graph, review, child, repair, and verification convergence", () => {
	const admitted = graph();
	const initial = newSessionState("request-1", "/work");
	const progress = initialProgress(admitted);
	const ordinary = { formalRole: "none" as const, stageInstanceId: null, stageCompleted: true, stageTargetSha256: null };
	assert.deepEqual(pendingSettlementReasons({ graph: admitted, progress, execution: initial.execution, reviewReasons: [], pendingChild: null, ...ordinary }), ["graph-work"]);
	const started = startTaskAttempt(admitted, progress, initial.execution, "A");
	const reported = acceptWorkerResult(started.execution, { taskId: "A", attemptId: started.attempt.attemptId, outcome: "pass", evidence: ["done"], observedOperationIds: [] });
	const verified = recordVerification(admitted, reported, "A", "verify-A", true);
	const completed = completeVerifiedTask(admitted, started.progress, verified, "A");
	const reviewReasons = [{ reasonId: "r1", stageInstanceId: null, kind: "explicit-user" as const, targetSha256: "a".repeat(64), acceptanceKey: "a1", status: "pending" as const }];
	assert.deepEqual(pendingSettlementReasons({ graph: admitted, progress: completed.progress, execution: completed.execution, reviewReasons, pendingChild: null, ...ordinary }), ["pending-review"]);
	assert.deepEqual(settle({ graph: admitted, progress: completed.progress, execution: completed.execution, reviewReasons: [{ ...reviewReasons[0]!, status: "consumed" }], pendingChild: null, ...ordinary }), { outcome: "pass", settled: true });
});

test("formal state cannot settle before a matching frozen target review is consumed", () => {
	const initial = newSessionState("request-1", "/work");
	const formal = { formalRole: "planning" as const, stageInstanceId: "stage-1", stageCompleted: false, stageTargetSha256: null };
	assert.deepEqual(pendingSettlementReasons({ graph: null, progress: {}, execution: initial.execution, reviewReasons: [], pendingChild: null, ...formal }), ["formal-stage-completion"]);
	const target = "a".repeat(64);
	const completed = { ...formal, stageCompleted: true, stageTargetSha256: target };
	assert.deepEqual(pendingSettlementReasons({ graph: null, progress: {}, execution: initial.execution, reviewReasons: [], pendingChild: null, ...completed }), ["formal-stage-review"]);
	const reason = { reasonId: "formal:stage-1", stageInstanceId: "stage-1", kind: "formal-stage" as const, targetSha256: target, acceptanceKey: "acceptance", status: "consumed" as const };
	assert.deepEqual(settle({ graph: null, progress: {}, execution: initial.execution, reviewReasons: [reason], pendingChild: null, ...completed }), { outcome: "pass", settled: true });
});
