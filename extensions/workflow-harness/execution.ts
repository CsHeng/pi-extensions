import {
	type AttemptRecord,
	type ExecutionState,
	type ObservedOperation,
	type VerificationRecord,
	type WorkerResultRecord,
} from "./session-state.ts";
import { readyTasks, type TaskGraphV1, type TaskProgressMap } from "./task-graph.ts";

export interface WorkerResultInput {
	taskId: string;
	attemptId: string;
	outcome: "pass" | "blocked" | "needs-input";
	evidence: string[];
	observedOperationIds: string[];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return [...left].sort().join("\0") === [...right].sort().join("\0");
}

export function startTaskAttempt(
	graph: TaskGraphV1,
	progress: TaskProgressMap,
	execution: ExecutionState,
	taskId: string,
): { progress: TaskProgressMap; execution: ExecutionState; attempt: AttemptRecord } {
	if (execution.activeAttemptId) throw new Error("another task attempt is active");
	if (!readyTasks(graph, progress).some((task) => task.taskId === taskId)) throw new Error("task is not ready");
	const task = graph.tasks.find((item) => item.taskId === taskId);
	if (!task) throw new Error("unknown task");
	const ordinal = (progress[taskId]?.attempts ?? 0) + 1;
	if (ordinal > task.attemptLimit) throw new Error("task attempt budget is exhausted");
	const attempt: AttemptRecord = { attemptId: `${graph.graphId}:${taskId}:${ordinal}`, taskId, ordinal, status: "active" };
	return {
		progress: { ...structuredClone(progress), [taskId]: { status: "active", attempts: ordinal } },
		execution: { ...structuredClone(execution), activeAttemptId: attempt.attemptId, attempts: [...execution.attempts, attempt] },
		attempt,
	};
}

export function recordObservedOperation(execution: ExecutionState, operation: ObservedOperation): ExecutionState {
	if (execution.activeAttemptId !== operation.attemptId) throw new Error("operation is not bound to the active attempt");
	if (execution.operations.some((item) => item.operationId === operation.operationId)) return structuredClone(execution);
	return { ...structuredClone(execution), operations: [...execution.operations, structuredClone(operation)] };
}

export function acceptWorkerResult(execution: ExecutionState, input: WorkerResultInput): ExecutionState {
	if (execution.activeAttemptId !== input.attemptId) throw new Error("worker result is stale or not active");
	const attempt = execution.attempts.find((item) => item.attemptId === input.attemptId);
	if (!attempt || attempt.taskId !== input.taskId || attempt.status !== "active") throw new Error("worker result does not match the admitted attempt");
	if (input.evidence.length === 0 || input.evidence.some((item) => !item.trim())) throw new Error("worker result requires typed evidence");
	const observed = execution.operations.filter((item) => item.attemptId === input.attemptId).map((item) => item.operationId);
	if (!sameStrings(observed, input.observedOperationIds)) throw new Error("worker result does not reconcile observed operations");
	const result: WorkerResultRecord = structuredClone(input);
	const attempts = execution.attempts.map((item) =>
		item.attemptId === input.attemptId ? { ...item, status: input.outcome === "pass" ? "worker-reported" as const : "blocked" as const } : item,
	);
	return { ...structuredClone(execution), attempts, workerResults: [...execution.workerResults, result] };
}

export function recordVerification(
	graph: TaskGraphV1,
	execution: ExecutionState,
	taskId: string,
	oracle: string,
	passed: boolean,
): ExecutionState {
	const attemptId = execution.activeAttemptId;
	const task = graph.tasks.find((item) => item.taskId === taskId);
	const attempt = execution.attempts.find((item) => item.attemptId === attemptId);
	if (!task || !attemptId || attempt?.taskId !== taskId || !["worker-reported", "verified"].includes(attempt.status)) {
		throw new Error("verification requires a passing active worker result");
	}
	if (!task.verification.includes(oracle)) throw new Error("verification oracle is not admitted by the task");
	const record: VerificationRecord = { attemptId, taskId, oracle, passed };
	const prior = execution.verifications.filter((item) => !(item.attemptId === attemptId && item.oracle === oracle));
	const nextRecords = [...prior, record];
	const records = new Map(nextRecords.filter((item) => item.attemptId === attemptId).map((item) => [item.oracle, item.passed]));
	const allPassed = task.verification.every((item) => records.get(item) === true);
	const failed = [...records.values()].some((value) => value === false);
	const attempts = execution.attempts.map((item) => item.attemptId === attemptId ? { ...item, status: failed ? "blocked" as const : allPassed ? "verified" as const : "worker-reported" as const } : item);
	return { ...structuredClone(execution), attempts, verifications: nextRecords };
}

export function retryTask(
	graph: TaskGraphV1,
	progress: TaskProgressMap,
	execution: ExecutionState,
	taskId: string,
): { progress: TaskProgressMap; execution: ExecutionState; exhausted: boolean } {
	const task = graph.tasks.find((item) => item.taskId === taskId);
	const attemptId = execution.activeAttemptId;
	const attempt = execution.attempts.find((item) => item.attemptId === attemptId);
	if (!task || !attemptId || attempt?.taskId !== taskId || attempt.status !== "blocked") throw new Error("retry requires one blocked active attempt");
	const exhausted = attempt.ordinal >= task.attemptLimit;
	return {
		progress: { ...structuredClone(progress), [taskId]: { status: exhausted ? "blocked" : "pending", attempts: attempt.ordinal } },
		execution: { ...structuredClone(execution), activeAttemptId: null },
		exhausted,
	};
}

export function completeVerifiedTask(
	graph: TaskGraphV1,
	progress: TaskProgressMap,
	execution: ExecutionState,
	taskId: string,
): { progress: TaskProgressMap; execution: ExecutionState } {
	const task = graph.tasks.find((item) => item.taskId === taskId);
	const attemptId = execution.activeAttemptId;
	const attempt = execution.attempts.find((item) => item.attemptId === attemptId);
	if (!task || !attemptId || attempt?.taskId !== taskId) throw new Error("task is not active");
	const passed = new Set(execution.verifications.filter((item) => item.attemptId === attemptId && item.passed).map((item) => item.oracle));
	if (task.verification.some((oracle) => !passed.has(oracle))) throw new Error("independent verification is incomplete");
	const attempts = execution.attempts.map((item) => item.attemptId === attemptId ? { ...item, status: "complete" as const } : item);
	return {
		progress: { ...structuredClone(progress), [taskId]: { status: "complete", attempts: progress[taskId]?.attempts ?? 1 } },
		execution: { ...structuredClone(execution), activeAttemptId: null, attempts },
	};
}
