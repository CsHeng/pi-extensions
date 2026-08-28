import type { ExecutionState, ReviewFindingRecord } from "./session-state.ts";
import type { TaskNodeV1 } from "./task-graph.ts";

export interface CandidateFinding {
	findingId: string;
	severity: "blocker" | "major" | "minor";
	evidence: string;
	withinSlice: boolean;
	proposedRepairPaths: string[];
}

export interface TypedReviewResult {
	dispatchId: string;
	targetSha256: string;
	acceptanceKey: string;
	outcome: "pass" | "findings" | "blocked";
	findings: CandidateFinding[];
}

export interface Adjudication {
	dispatchId: string;
	acceptedFindingIds: string[];
	rejectedFindingIds: string[];
}

function inScope(path: string, task: TaskNodeV1): boolean {
	return task.writePaths.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

export function adjudicateReview(
	execution: ExecutionState,
	result: TypedReviewResult,
	acceptedFindingIds: readonly string[],
): { execution: ExecutionState; adjudication: Adjudication } {
	if (new Set(result.findings.map((item) => item.findingId)).size !== result.findings.length) throw new Error("review finding IDs must be unique");
	const accepted = new Set(acceptedFindingIds);
	if ([...accepted].some((id) => !result.findings.some((item) => item.findingId === id))) throw new Error("cannot accept an unknown review finding");
	if (result.outcome === "pass" && (result.findings.length > 0 || accepted.size > 0)) throw new Error("passing review cannot carry findings");
	if ([...accepted].some((id) => !result.findings.find((item) => item.findingId === id)?.withinSlice)) {
		throw new Error("out-of-slice review evidence cannot authorize repair");
	}
	const records: ReviewFindingRecord[] = result.findings.map((finding) => ({
		dispatchId: result.dispatchId,
		findingId: finding.findingId,
		severity: finding.severity,
		evidence: finding.evidence,
		withinSlice: finding.withinSlice,
		accepted: accepted.has(finding.findingId),
	}));
	return {
		execution: { ...structuredClone(execution), reviewFindings: [...execution.reviewFindings, ...records] },
		adjudication: {
			dispatchId: result.dispatchId,
			acceptedFindingIds: [...accepted].sort(),
			rejectedFindingIds: result.findings.map((item) => item.findingId).filter((id) => !accepted.has(id)).sort(),
		},
	};
}

export function admitFocusedRepair(
	execution: ExecutionState,
	result: TypedReviewResult,
	adjudication: Adjudication,
	task: TaskNodeV1,
): ExecutionState {
	if (adjudication.acceptedFindingIds.length === 0) return structuredClone(execution);
	if (execution.repairConsumed) throw new Error("non-convergent: focused repair budget is exhausted");
	const accepted = result.findings.filter((item) => adjudication.acceptedFindingIds.includes(item.findingId));
	if (accepted.some((finding) => finding.proposedRepairPaths.length === 0 || finding.proposedRepairPaths.some((path) => !inScope(path, task)))) {
		throw new Error("accepted repair must remain inside the admitted task write slice");
	}
	return {
		...structuredClone(execution),
		repairConsumed: true,
		pendingRepairFindingIds: adjudication.acceptedFindingIds,
		activeAttemptId: `repair:${task.taskId}:${adjudication.dispatchId}`,
		attempts: [...execution.attempts, {
			attemptId: `repair:${task.taskId}:${adjudication.dispatchId}`,
			taskId: task.taskId,
			ordinal: execution.attempts.filter((item) => item.taskId === task.taskId).length + 1,
			status: "active",
		}],
		repairContext: {
			attemptId: `repair:${task.taskId}:${adjudication.dispatchId}`,
			taskId: task.taskId,
			findingIds: adjudication.acceptedFindingIds,
			requiredOracles: [...task.verification],
		},
	};
}

export function completeFocusedRepair(execution: ExecutionState, findingIds: readonly string[]): ExecutionState {
	if (execution.pendingRepairFindingIds.length === 0 || !execution.repairContext) throw new Error("no focused repair is pending");
	if ([...findingIds].sort().join("\0") !== [...execution.pendingRepairFindingIds].sort().join("\0")) {
		throw new Error("repair result does not match accepted findings");
	}
	const attempt = execution.attempts.find((item) => item.attemptId === execution.repairContext?.attemptId);
	const passed = new Set(execution.verifications.filter((item) => item.attemptId === execution.repairContext?.attemptId && item.passed).map((item) => item.oracle));
	if (attempt?.status !== "verified" || execution.repairContext.requiredOracles.some((oracle) => !passed.has(oracle))) {
		throw new Error("focused repair verification is incomplete or stale");
	}
	return {
		...structuredClone(execution),
		activeAttemptId: null,
		attempts: execution.attempts.map((item) => item.attemptId === execution.repairContext?.attemptId ? { ...item, status: "complete" as const } : item),
		pendingRepairFindingIds: [],
		repairContext: null,
	};
}
