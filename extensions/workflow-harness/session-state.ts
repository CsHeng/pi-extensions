import { admitTaskGraph, type FormalRole, type TaskGraphV1, type TaskProgressMap } from "./task-graph.ts";
import type { ExactUserAuthority } from "./authority.ts";
import type { AdmissionKind } from "./activation.ts";
import type { FrozenProposalV1 } from "./proposal.ts";

export const SESSION_ENTRY_TYPE = "workflow.harness.session.v1";

export type LifecycleState = "capture" | "normalize" | "approval" | "execute" | "assess" | "verify" | "settle" | "blocked";
export type TerminalOutcome = "pass" | "needs-input" | "needs-authority" | "non-convergent" | "blocked";

export interface SelectedWorker {
	intent: "design" | "planning" | "implementation" | "review" | "normalization" | "verification";
	name: string;
	description: string;
	sourcePath: string;
}

export interface ReviewReason {
	reasonId: string;
	stageInstanceId: string | null;
	kind: "formal-stage" | "worker-requested-review" | "explicit-user" | "task-policy" | "risk-policy" | "observed-risk";
	targetSha256: string;
	acceptanceKey: string;
	status: "pending" | "consumed" | "blocked";
}

export interface PendingChild {
	dispatchId: string;
	intent: SelectedWorker["intent"];
	expectedTool: string;
	status: "scheduled" | "dispatched";
	command: string | null;
	brief: string;
	taskId: string | null;
	attemptId: string | null;
}

export interface StageTarget {
	sha256: string;
	acceptanceKey: string;
	artifacts: FrozenProposalV1["artifacts"];
}

export interface PendingReviewResult {
	dispatchId: string;
	targetSha256: string;
	acceptanceKey: string;
	outcome: "pass" | "findings" | "blocked";
	findings: Array<{
		findingId: string;
		severity: "blocker" | "major" | "minor";
		evidence: string;
		withinSlice: boolean;
		proposedRepairPaths: string[];
	}>;
}

export interface RepairContext {
	attemptId: string;
	taskId: string;
	findingIds: string[];
	requiredOracles: string[];
}

export interface AttemptRecord {
	attemptId: string;
	taskId: string;
	ordinal: number;
	status: "active" | "worker-reported" | "verified" | "complete" | "blocked";
}

export interface ObservedOperation {
	operationId: string;
	attemptId: string;
	toolName: string;
	paths: string[];
	suspendedContainment: boolean;
}

export interface WorkerResultRecord {
	attemptId: string;
	taskId: string;
	outcome: "pass" | "blocked" | "needs-input";
	evidence: string[];
	observedOperationIds: string[];
}

export interface VerificationRecord {
	attemptId: string;
	taskId: string;
	oracle: string;
	passed: boolean;
}

export interface ReviewFindingRecord {
	dispatchId: string;
	findingId: string;
	severity: "blocker" | "major" | "minor";
	evidence: string;
	withinSlice: boolean;
	accepted: boolean;
}

export interface ExecutionState {
	activeAttemptId: string | null;
	attempts: AttemptRecord[];
	operations: ObservedOperation[];
	workerResults: WorkerResultRecord[];
	verifications: VerificationRecord[];
	reviewFindings: ReviewFindingRecord[];
	repairConsumed: boolean;
	pendingRepairFindingIds: string[];
	exactUserAuthorities: ExactUserAuthority[];
	pendingReviewResult: PendingReviewResult | null;
	repairContext: RepairContext | null;
}

export interface HarnessSessionStateV1 {
	schemaVersion: 1;
	requestId: string;
	workspaceRoot: string;
	lifecycle: LifecycleState;
	formalRole: FormalRole;
	stageOrdinal: number;
	stageInstanceId: string | null;
	admissionKind: AdmissionKind | null;
	admissionSha256: string | null;
	skillSnapshotSha256: string | null;
	stageTarget: StageTarget | null;
	stageCompleted: boolean;
	proposal: FrozenProposalV1 | null;
	graph: TaskGraphV1 | null;
	progress: TaskProgressMap;
	workers: SelectedWorker[];
	reviewReasons: ReviewReason[];
	pendingChild: PendingChild | null;
	execution: ExecutionState;
	terminalOutcome: TerminalOutcome | null;
	settled: boolean;
	updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validProposal(value: unknown): boolean {
	return exactRecord(value, ["artifacts", "messages", "schemaVersion", "sha256"]) && value.schemaVersion === 1 && typeof value.sha256 === "string" &&
		Array.isArray(value.messages) && value.messages.every((item) => exactRecord(item, ["role", "text"]) && ["user", "assistant"].includes(item.role as string) && typeof item.text === "string") &&
		Array.isArray(value.artifacts) && value.artifacts.every((item) => exactRecord(item, ["path", "sha256", "size"]) && typeof item.path === "string" && typeof item.sha256 === "string" && Number.isInteger(item.size));
}

function validExecution(value: Record<string, unknown>): boolean {
	if (!exactRecord(value, ["activeAttemptId", "attempts", "exactUserAuthorities", "operations", "pendingRepairFindingIds", "pendingReviewResult", "repairConsumed", "repairContext", "reviewFindings", "verifications", "workerResults"])) return false;
	if (value.activeAttemptId !== null && typeof value.activeAttemptId !== "string") return false;
	if (typeof value.repairConsumed !== "boolean" || !stringArray(value.pendingRepairFindingIds)) return false;
	if (!Array.isArray(value.attempts) || !value.attempts.every((item) => exactRecord(item, ["attemptId", "ordinal", "status", "taskId"]) && typeof item.attemptId === "string" && typeof item.taskId === "string" && Number.isInteger(item.ordinal) && ["active", "worker-reported", "verified", "complete", "blocked"].includes(item.status as string))) return false;
	if (!Array.isArray(value.operations) || !value.operations.every((item) => exactRecord(item, ["attemptId", "operationId", "paths", "suspendedContainment", "toolName"]) && typeof item.operationId === "string" && typeof item.attemptId === "string" && typeof item.toolName === "string" && stringArray(item.paths) && typeof item.suspendedContainment === "boolean")) return false;
	if (!Array.isArray(value.workerResults) || !value.workerResults.every((item) => exactRecord(item, ["attemptId", "evidence", "observedOperationIds", "outcome", "taskId"]) && typeof item.attemptId === "string" && typeof item.taskId === "string" && ["pass", "blocked", "needs-input"].includes(item.outcome as string) && stringArray(item.evidence) && stringArray(item.observedOperationIds))) return false;
	if (!Array.isArray(value.verifications) || !value.verifications.every((item) => exactRecord(item, ["attemptId", "oracle", "passed", "taskId"]) && typeof item.attemptId === "string" && typeof item.taskId === "string" && typeof item.oracle === "string" && typeof item.passed === "boolean")) return false;
	if (!Array.isArray(value.reviewFindings) || !value.reviewFindings.every((item) => exactRecord(item, ["accepted", "dispatchId", "evidence", "findingId", "severity", "withinSlice"]) && typeof item.dispatchId === "string" && typeof item.findingId === "string" && typeof item.evidence === "string" && ["blocker", "major", "minor"].includes(item.severity as string) && typeof item.withinSlice === "boolean" && typeof item.accepted === "boolean")) return false;
	if (!Array.isArray(value.exactUserAuthorities) || !value.exactUserAuthorities.every((item) => exactRecord(item, ["authorityId", "consumed", "inputSha256", "source", "taskId", "toolName"]) && typeof item.authorityId === "string" && typeof item.taskId === "string" && typeof item.toolName === "string" && typeof item.inputSha256 === "string" && item.source === "user" && typeof item.consumed === "boolean")) return false;
	if (value.repairContext !== null && !(exactRecord(value.repairContext, ["attemptId", "findingIds", "requiredOracles", "taskId"]) && typeof value.repairContext.attemptId === "string" && typeof value.repairContext.taskId === "string" && stringArray(value.repairContext.findingIds) && stringArray(value.repairContext.requiredOracles))) return false;
	if (value.pendingReviewResult !== null && !(exactRecord(value.pendingReviewResult, ["acceptanceKey", "dispatchId", "findings", "outcome", "targetSha256"]) && typeof value.pendingReviewResult.dispatchId === "string" && typeof value.pendingReviewResult.targetSha256 === "string" && typeof value.pendingReviewResult.acceptanceKey === "string" && ["pass", "findings", "blocked"].includes(value.pendingReviewResult.outcome as string) && Array.isArray(value.pendingReviewResult.findings))) return false;
	return true;
}

const STATE_KEYS = [
	"formalRole",
	"execution",
	"admissionKind",
	"admissionSha256",
	"graph",
	"lifecycle",
	"pendingChild",
	"progress",
	"proposal",
	"requestId",
	"reviewReasons",
	"schemaVersion",
	"settled",
	"stageInstanceId",
	"skillSnapshotSha256",
	"stageTarget",
	"stageCompleted",
	"stageOrdinal",
	"terminalOutcome",
	"updatedAt",
	"workers",
	"workspaceRoot",
] as const;

export function isHarnessSessionState(value: unknown): value is HarnessSessionStateV1 {
	if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...STATE_KEYS].sort().join("\0")) return false;
	if (value.schemaVersion !== 1 || typeof value.requestId !== "string" || typeof value.workspaceRoot !== "string") return false;
	if (!["capture", "normalize", "approval", "execute", "assess", "verify", "settle", "blocked"].includes(value.lifecycle as string)) return false;
	if (!["design", "planning", "implementation", "none"].includes(value.formalRole as string)) return false;
	if (!Number.isInteger(value.stageOrdinal) || (value.stageOrdinal as number) < 0) return false;
	if (value.stageInstanceId !== null && typeof value.stageInstanceId !== "string") return false;
	if (value.admissionKind !== null && !["explicit-role", "approved-graph", "root-skill-selection"].includes(value.admissionKind as string)) return false;
	if (value.admissionSha256 !== null && typeof value.admissionSha256 !== "string") return false;
	if (value.skillSnapshotSha256 !== null && typeof value.skillSnapshotSha256 !== "string") return false;
	if (value.stageTarget !== null && !(exactRecord(value.stageTarget, ["acceptanceKey", "artifacts", "sha256"]) && typeof value.stageTarget.sha256 === "string" && typeof value.stageTarget.acceptanceKey === "string" && Array.isArray(value.stageTarget.artifacts))) return false;
	if (typeof value.stageCompleted !== "boolean") return false;
	if (value.proposal !== null && !validProposal(value.proposal)) return false;
	if (value.graph !== null) {
		try {
			admitTaskGraph(value.graph);
		} catch {
			return false;
		}
	}
	if (!isRecord(value.progress) || !Array.isArray(value.workers) || !value.workers.every((item) => exactRecord(item, ["description", "intent", "name", "sourcePath"]) && ["design", "planning", "implementation", "review", "normalization", "verification"].includes(item.intent as string) && typeof item.name === "string" && typeof item.description === "string" && typeof item.sourcePath === "string")) return false;
	if (!Array.isArray(value.reviewReasons) || !value.reviewReasons.every((item) => exactRecord(item, ["acceptanceKey", "kind", "reasonId", "stageInstanceId", "status", "targetSha256"]) && typeof item.reasonId === "string" && (item.stageInstanceId === null || typeof item.stageInstanceId === "string") && typeof item.targetSha256 === "string" && typeof item.acceptanceKey === "string" && ["formal-stage", "worker-requested-review", "explicit-user", "task-policy", "risk-policy", "observed-risk"].includes(item.kind as string) && ["pending", "consumed", "blocked"].includes(item.status as string))) return false;
	if (value.pendingChild !== null && !(exactRecord(value.pendingChild, ["attemptId", "brief", "command", "dispatchId", "expectedTool", "intent", "status", "taskId"]) && typeof value.pendingChild.dispatchId === "string" && typeof value.pendingChild.expectedTool === "string" && typeof value.pendingChild.brief === "string" && (value.pendingChild.command === null || typeof value.pendingChild.command === "string") && (value.pendingChild.taskId === null || typeof value.pendingChild.taskId === "string") && (value.pendingChild.attemptId === null || typeof value.pendingChild.attemptId === "string") && ["scheduled", "dispatched"].includes(value.pendingChild.status as string))) return false;
	if (!isRecord(value.execution)) return false;
	if (!validExecution(value.execution)) return false;
	if (value.terminalOutcome !== null && !["pass", "needs-input", "needs-authority", "non-convergent", "blocked"].includes(value.terminalOutcome as string)) return false;
	return typeof value.settled === "boolean" && typeof value.updatedAt === "string";
}

export function cloneSessionState(state: HarnessSessionStateV1): HarnessSessionStateV1 {
	return structuredClone(state);
}

export function newSessionState(requestId: string, workspaceRoot: string, now = new Date().toISOString()): HarnessSessionStateV1 {
	return {
		schemaVersion: 1,
		requestId,
		workspaceRoot,
		lifecycle: "capture",
		formalRole: "none",
		stageOrdinal: 0,
		stageInstanceId: null,
		admissionKind: null,
		admissionSha256: null,
		skillSnapshotSha256: null,
		stageTarget: null,
		stageCompleted: false,
		proposal: null,
		graph: null,
		progress: {},
		workers: [],
		reviewReasons: [],
		pendingChild: null,
		execution: {
			activeAttemptId: null,
			attempts: [],
			operations: [],
			workerResults: [],
			verifications: [],
			reviewFindings: [],
			repairConsumed: false,
			pendingRepairFindingIds: [],
			exactUserAuthorities: [],
			pendingReviewResult: null,
			repairContext: null,
		},
		terminalOutcome: null,
		settled: false,
		updatedAt: now,
	};
}

export function updateSessionState(
	state: HarnessSessionStateV1,
	changes: Partial<Omit<HarnessSessionStateV1, "schemaVersion" | "requestId" | "workspaceRoot">>,
	now = new Date().toISOString(),
): HarnessSessionStateV1 {
	if (state.settled) throw new Error("settled session is immutable");
	const next = { ...cloneSessionState(state), ...structuredClone(changes), updatedAt: now };
	if (!isHarnessSessionState(next)) throw new Error("invalid session state transition");
	return next;
}
