import assert from "node:assert/strict";
import test from "node:test";

import { acceptWorkerResult, completeVerifiedTask, recordObservedOperation, recordVerification, startTaskAttempt } from "../extensions/workflow-harness/execution.ts";
import { newSessionState } from "../extensions/workflow-harness/session-state.ts";
import { admitTaskGraph, initialProgress } from "../extensions/workflow-harness/task-graph.ts";

function graph(verification = ["verify-A"], attemptLimit = 1) {
	return admitTaskGraph({
		schemaVersion: 1,
		graphId: "graph-1",
		requestId: "request-1",
		approved: true,
		rootFormalRole: "implementation",
		terminalTaskIds: ["A"],
		tasks: [{
			taskId: "A", description: "synthetic task", dependsOn: [], readPaths: [], writePaths: ["src/slice"], resourceLocks: [],
			isolation: "controller-checkout", verification, doneWhen: ["done-A"], review: { required: false, reasons: [] },
			attemptLimit, recovery: "fix-forward",
		}],
	});
}

test("only the harness admits a ready attempt and reconciles typed worker evidence", () => {
	const admitted = graph();
	const initial = newSessionState("request-1", "/work").execution;
	const started = startTaskAttempt(admitted, initialProgress(admitted), initial, "A");
	const operation = { operationId: `${started.attempt.attemptId}:write:src/slice/file.ts`, attemptId: started.attempt.attemptId, toolName: "write", paths: ["src/slice/file.ts"], suspendedContainment: false };
	const observed = recordObservedOperation(started.execution, operation);
	assert.throws(() => acceptWorkerResult(observed, {
		taskId: "A", attemptId: started.attempt.attemptId, outcome: "pass", evidence: ["changed"], observedOperationIds: [],
	}), /reconcile/);
	const reported = acceptWorkerResult(observed, {
		taskId: "A", attemptId: started.attempt.attemptId, outcome: "pass", evidence: ["changed"], observedOperationIds: [operation.operationId],
	});
	assert.throws(() => completeVerifiedTask(admitted, started.progress, reported, "A"), /verification is incomplete/);
	const verified = recordVerification(admitted, reported, "A", "verify-A", true);
	const complete = completeVerifiedTask(admitted, started.progress, verified, "A");
	assert.equal(complete.progress.A?.status, "complete");
	assert.equal(complete.execution.activeAttemptId, null);
});

test("rejects non-ready tasks and exhausted attempt budgets", () => {
	const admitted = graph();
	const execution = newSessionState("request-1", "/work").execution;
	const progress = initialProgress(admitted);
	assert.throws(() => startTaskAttempt(admitted, { ...progress, A: { status: "blocked", attempts: 1 } }, execution, "A"), /not ready/);
});

test("records every oracle before completion and admits one bounded retry", async () => {
	const { retryTask } = await import("../extensions/workflow-harness/execution.ts");
	const admitted = graph(["verify-A-1", "verify-A-2"], 2);
	const initial = newSessionState("request-1", "/work").execution;
	const progress = initialProgress(admitted);
	const first = startTaskAttempt(admitted, progress, initial, "A");
	const failedWorker = acceptWorkerResult(first.execution, { taskId: "A", attemptId: first.attempt.attemptId, outcome: "blocked", evidence: ["bounded failure"], observedOperationIds: [] });
	const retry = retryTask(admitted, first.progress, failedWorker, "A");
	assert.equal(retry.exhausted, false);
	const second = startTaskAttempt(admitted, retry.progress, retry.execution, "A");
	const reported = acceptWorkerResult(second.execution, { taskId: "A", attemptId: second.attempt.attemptId, outcome: "pass", evidence: ["done"], observedOperationIds: [] });
	const firstOracle = recordVerification(admitted, reported, "A", "verify-A-1", true);
	assert.equal(firstOracle.attempts.find((item) => item.attemptId === second.attempt.attemptId)?.status, "worker-reported");
	assert.throws(() => completeVerifiedTask(admitted, second.progress, firstOracle, "A"), /verification is incomplete/);
	const secondOracle = recordVerification(admitted, firstOracle, "A", "verify-A-2", true);
	assert.equal(completeVerifiedTask(admitted, second.progress, secondOracle, "A").progress.A?.status, "complete");
});
