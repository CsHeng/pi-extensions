import assert from "node:assert/strict";
import test from "node:test";

import { admitFocusedRepair, adjudicateReview, completeFocusedRepair, type TypedReviewResult } from "../extensions/workflow-harness/review-result.ts";
import { acceptWorkerResult, recordVerification } from "../extensions/workflow-harness/execution.ts";
import { newSessionState } from "../extensions/workflow-harness/session-state.ts";
import { admitTaskGraph, type TaskNodeV1 } from "../extensions/workflow-harness/task-graph.ts";

const task: TaskNodeV1 = {
	taskId: "A", description: "synthetic task", dependsOn: [], readPaths: [], writePaths: ["src/slice"], resourceLocks: [],
	isolation: "controller-checkout", verification: ["verify-A"], doneWhen: ["done-A"], review: { required: true, reasons: ["formal"] },
	attemptLimit: 2, recovery: "fix-forward",
};

const result: TypedReviewResult = {
	dispatchId: "review-1",
	targetSha256: "a".repeat(64),
	acceptanceKey: "acceptance-1",
	outcome: "findings",
	findings: [{ findingId: "F1", severity: "major", evidence: "bounded evidence", withinSlice: true, proposedRepairPaths: ["src/slice/file.ts"] }],
};

test("the controller adjudicates findings and owns one focused same-slice repair", () => {
	const execution = newSessionState("request-1", "/work").execution;
	const judged = adjudicateReview(execution, result, ["F1"]);
	const admitted = admitFocusedRepair(judged.execution, result, judged.adjudication, task);
	assert.equal(admitted.repairConsumed, true);
	assert.deepEqual(admitted.pendingRepairFindingIds, ["F1"]);
	const reported = acceptWorkerResult(admitted, { taskId: "A", attemptId: admitted.repairContext!.attemptId, outcome: "pass", evidence: ["repair complete"], observedOperationIds: [] });
	const graph = admitTaskGraph({ schemaVersion: 1, graphId: "graph-1", requestId: "request-1", approved: true, rootFormalRole: "implementation", terminalTaskIds: ["A"], tasks: [task] });
	const verified = recordVerification(graph, reported, "A", "verify-A", true);
	const complete = completeFocusedRepair(verified, ["F1"]);
	assert.deepEqual(complete.pendingRepairFindingIds, []);
	assert.throws(() => admitFocusedRepair(complete, result, judged.adjudication, task), /non-convergent/);
});

test("rejects out-of-slice findings and repair expansion", () => {
	const execution = newSessionState("request-1", "/work").execution;
	const outside = { ...result, findings: [{ ...result.findings[0]!, withinSlice: false }] };
	assert.throws(() => adjudicateReview(execution, outside, ["F1"]), /out-of-slice/);
	const expanded = { ...result, findings: [{ ...result.findings[0]!, proposedRepairPaths: ["src/other.ts"] }] };
	const judged = adjudicateReview(execution, expanded, ["F1"]);
	assert.throws(() => admitFocusedRepair(judged.execution, expanded, judged.adjudication, task), /inside/);
});
