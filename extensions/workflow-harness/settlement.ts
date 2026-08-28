import type { ExecutionState, PendingChild, ReviewReason, TerminalOutcome } from "./session-state.ts";
import type { FormalRole } from "./task-graph.ts";
import { graphIsTerminal, type TaskGraphV1, type TaskProgressMap } from "./task-graph.ts";

export interface SettlementInput {
	graph: TaskGraphV1 | null;
	progress: TaskProgressMap;
	execution: ExecutionState;
	reviewReasons: readonly ReviewReason[];
	pendingChild: PendingChild | null;
	formalRole: FormalRole;
	stageInstanceId: string | null;
	stageCompleted: boolean;
	stageTargetSha256: string | null;
}

export interface SettlementResult {
	outcome: TerminalOutcome;
	settled: true;
}

export function pendingSettlementReasons(input: SettlementInput): string[] {
	const reasons: string[] = [];
	if (input.graph && !input.graph.approved) reasons.push("graph-approval");
	if (input.graph && !graphIsTerminal(input.graph, input.progress)) reasons.push("graph-work");
	if (input.formalRole !== "none") {
		if (!input.stageInstanceId || !input.stageCompleted || !input.stageTargetSha256) reasons.push("formal-stage-completion");
		else if (!input.reviewReasons.some((reason) => reason.reasonId === `formal:${input.stageInstanceId}` && reason.targetSha256 === input.stageTargetSha256 && ["consumed", "blocked"].includes(reason.status))) reasons.push("formal-stage-review");
	}
	if (input.pendingChild) reasons.push("pending-child");
	if (input.execution.activeAttemptId) reasons.push("active-attempt");
	if (input.execution.pendingRepairFindingIds.length > 0) reasons.push("pending-repair");
	if (input.reviewReasons.some((reason) => reason.status === "pending")) reasons.push("pending-review");
	for (const task of input.graph?.tasks ?? []) {
		if (input.progress[task.taskId]?.status !== "complete") continue;
		const attempt = [...input.execution.attempts].reverse().find((item) => item.taskId === task.taskId && item.status === "complete");
		const passed = new Set(input.execution.verifications.filter((item) => item.attemptId === attempt?.attemptId && item.passed).map((item) => item.oracle));
		if (!attempt || task.verification.some((oracle) => !passed.has(oracle))) reasons.push(`verification:${task.taskId}`);
	}
	return [...new Set(reasons)];
}

export function settle(input: SettlementInput): SettlementResult {
	const pending = pendingSettlementReasons(input);
	if (pending.length > 0) throw new Error(`cannot settle while pending: ${pending.join(", ")}`);
	return { outcome: "pass", settled: true };
}
