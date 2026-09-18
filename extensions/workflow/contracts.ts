/**
 * Canonical workflow records, limits and error codes (WF-02).
 *
 * The model supplies meaning; code allocates identity, revisions, readiness, coverage and
 * freshness. Nothing here reads Pi events or the filesystem: the reducer is pure and the store
 * owns session persistence. Evidence fingerprints stay opaque so WF-03 can compute them.
 */

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_ENTRY_TYPE = "csheng-workflow-state";
export const WORKFLOW_TOOL_NAME = "csheng_workflow";

export const WORKFLOW_LIMITS = {
	maxTasks: 64,
	maxCriteria: 32,
	maxAttempts: 128,
	maxEvidence: 256,
	maxDecisions: 128,
	maxAmendments: 64,
	maxAppliedCalls: 64,
	maxBatchSteps: 16,
	maxBatchBytes: 64 * 1024,
	maxListItems: 32,
	/** Maximum evidence bindings that a completion re-check may scan before refusing to certify. */
	maxCompletionChecks: 64,
	maxSnapshotBytes: 512 * 1024,
	maxGoal: 4000,
	maxEndpoint: 1000,
	maxOutcome: 1000,
	maxTitle: 80,
	maxVerification: 1000,
	maxReference: 500,
	maxReason: 2000,
	maxRationale: 2000,
	maxCheckIdentity: 500,
	maxArtifactReference: 500,
	maxWriteSurface: 32,
	maxKey: 64,
} as const;

export type WorkflowErrorCode =
	| "workset_exists"
	| "workset_paused"
	| "no_workset"
	| "workset_closed"
	| "state_unavailable"
	| "stale_revision"
	| "needs_alignment"
	| "invalid_payload"
	| "unknown_reference"
	| "limit_exceeded"
	| "snapshot_limit"
	| "duplicate_key"
	| "cycle"
	| "coverage_loss"
	| "invalid_transition"
	| "attempt_open"
	| "attempt_unknown"
	| "evidence_required"
	| "not_ready"
	| "completion_deficit";

export interface Deficit {
	code:
		| "unaccepted_criteria"
		| "unaccepted_tasks"
		| "open_attempts"
		| "missing_delivery_evidence"
		| "needs_alignment"
		| "workset_not_active"
		| "uncovered_criteria"
		| "no_required_criteria";
	ids: string[];
	message: string;
}

/** Provenance and semantic sufficiency are independent dimensions; store both honestly. */
export type EvidenceProvenance = "host_observed" | "agent_declared" | "user_declared" | "review";

export interface EvidenceBasis {
	scope: string[];
	/** Opaque digest supplied by the caller; `unavailable` means no reliable basis was established. */
	fingerprint: string;
	fingerprintState: "current" | "unavailable";
}

export interface AuthorityReference {
	id: string;
	description: string;
	source: string;
	limits: string;
}

export interface Workset {
	id: string;
	goal: string;
	goalRevision: number;
	sourceReferences: string[];
	authorityReferences: AuthorityReference[];
	deliveryEndpoint: string;
	repository: { cwd: string; sessionId: string };
	openedAt: string;
	disposition: "active" | "paused" | "closed";
	closeOutcome?: "completed" | "cancelled" | "superseded";
	closeReason?: string;
	alignment: { state: "aligned" | "needs_alignment"; inputGeneration: number; goalRevision: number; deliveryUnavailable?: true };
	inputGeneration: number;
	reviewPolicy: { maxAutomaticReviewsPerInputEpoch: number };
	/** Bounded automatic-review bookkeeping for the current input generation. */
	review: {
		inputGeneration: number;
		used: number;
		lastFingerprint?: string;
		lastDispatchAt?: string;
		pausedReason?: string;
	};
}

export interface Criterion {
	id: string;
	worksetId: string;
	outcome: string;
	verification: string;
	required: boolean;
	semanticRevision: number;
	disposition: "unverified" | "accepted" | "stale" | "retired";
	retired?: { amendmentId: string; reason: string };
	decisionId?: string;
}

export type TaskDisposition = "pending" | "running" | "awaiting_acceptance" | "accepted" | "blocked" | "paused" | "cancelled" | "superseded";

export interface Task {
	id: string;
	worksetId: string;
	title?: string;
	outcome: string;
	semanticRevision: number;
	covers: string[];
	enablingPurpose?: string;
	dependsOn: string[];
	repositoryOwner: string;
	writeSurface: string[];
	executionConstraints: string[];
	disposition: TaskDisposition;
	reason?: string;
	blockClass?: "needs_authority" | "missing_capability" | "non_convergence";
	nextUnblockCondition?: string;
	lineage?: { relation: "split" | "merge" | "replacement"; sourceIds: string[] };
	decisionId?: string;
	currentAttemptId?: string;
}

export interface Attempt {
	id: string;
	worksetId: string;
	taskId: string;
	taskRevision: number;
	basis: EvidenceBasis;
	transport: string;
	state: "running" | "reported" | "failed" | "interrupted" | "unknown";
	startedAt: string;
	endedAt?: string;
	outcome?: string;
}

export interface EvidenceRecord {
	id: string;
	worksetId: string;
	provenance: EvidenceProvenance;
	subject: { kind: "criterion" | "task" | "workset"; id: string };
	revisions: { taskRevision?: number; criterionRevision?: number };
	basis: EvidenceBasis;
	check: { identity: string; result: "pass" | "fail" | "unknown"; exitCode?: number | null };
	freshness: "current" | "stale" | "unavailable";
	artifactReferences: string[];
	attemptId?: string;
	recordedAt: string;
}

export interface AcceptanceDecision {
	id: string;
	worksetId: string;
	subject: { kind: "task" | "criterion"; id: string };
	verdict: "accepted" | "rejected" | "unresolved_verification";
	evidenceIds: string[];
	rationale: string;
	at: string;
}

export interface AmendmentRecord {
	id: string;
	worksetId: string;
	reason: string;
	intentReference: string;
	at: string;
	affected: { tasks: string[]; criteria: string[]; evidence: string[] };
	replacements: Array<{ from: string; to: string; relation: "split" | "merge" | "replacement" }>;
}

export interface WorksetState {
	schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
	revision: number;
	workset: Workset;
	pastWorksets: Record<string, Workset>;
	criteria: Record<string, Criterion>;
	tasks: Record<string, Task>;
	attempts: Record<string, Attempt>;
	evidence: Record<string, EvidenceRecord>;
	decisions: Record<string, AcceptanceDecision>;
	amendments: Record<string, AmendmentRecord>;
	appliedCalls: Record<string, number>;
	next: {
		workset: number;
		criterion: number;
		task: number;
		attempt: number;
		evidence: number;
		decision: number;
		amendment: number;
		authority: number;
	};
}

export interface WorkflowSnapshot {
	schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
	revision: number;
	transition: string;
	at: string;
	state: WorksetState;
}

export interface WorkflowView {
	schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
	revision: number;
	workset: null | {
		id: string;
		goal: string;
		goalRevision: number;
		deliveryEndpoint: string;
		disposition: Workset["disposition"];
		closeOutcome?: Workset["closeOutcome"];
		alignment: Workset["alignment"];
		inputGeneration: number;
		reviewPolicy: Workset["reviewPolicy"];
	};
	criteria: Array<{
		id: string;
		outcome: string;
		required: boolean;
		semanticRevision: number;
		disposition: Criterion["disposition"];
	}>;
	tasks: Array<{
		id: string;
		title?: string;
		outcome: string;
		covers: string[];
		dependsOn: string[];
		semanticRevision: number;
		disposition: TaskDisposition;
		ready: boolean;
		currentAttemptId?: string;
		reason?: string;
		lineage?: Task["lineage"];
	}>;
	attempts: Array<{ id: string; taskId: string; state: Attempt["state"]; taskRevision: number; transport: string }>;
	evidence: Array<{
		id: string;
		subject: EvidenceRecord["subject"];
		provenance: EvidenceProvenance;
		freshness: EvidenceRecord["freshness"];
		result: EvidenceRecord["check"]["result"];
		identity: string;
		recordedAt: string;
	}>;
	deficits: Deficit[];
	records?: {
		tasks?: Task[];
		criteria?: Criterion[];
		attempts?: Attempt[];
		evidence?: EvidenceRecord[];
		decisions?: AcceptanceDecision[];
		amendments?: AmendmentRecord[];
	};
	mapping?: Record<string, string>;
}

export interface FailureResult {
	ok: false;
	code: WorkflowErrorCode;
	message: string;
	deficits?: Deficit[];
	view?: WorkflowView;
}

export interface SuccessResult {
	ok: true;
	state: WorksetState;
	view: WorkflowView;
	mapping?: Record<string, string>;
	notice?: string;
}

export type ReduceResult = SuccessResult | FailureResult;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OpenCriterionInput {
	key: string;
	outcome: string;
	verification: string;
	required?: boolean;
}

export interface OpenTaskInput {
	key: string;
	/** Short imperative subject line rendered in the task view; outcome carries the longer detail. */
	title?: string;
	outcome: string;
	covers?: string[];
	dependsOn?: string[];
	enablingPurpose?: string;
	repositoryOwner?: string;
	writeSurface?: string[];
	executionConstraints?: string[];
}

export interface OpenOperation {
	operation: "open";
	expectedRevision: 0;
	/** Host-owned enrollment fence; never taken from model tool parameters. */
	deliveryUnavailable?: true;
	goal: string;
	deliveryEndpoint: string;
	sourceReferences?: string[];
	authorityReferences?: Array<Omit<AuthorityReference, "id">>;
	criteria: OpenCriterionInput[];
	tasks: OpenTaskInput[];
	reviewPolicy?: { maxAutomaticReviewsPerInputEpoch: number };
}

export interface InspectOperation {
	operation: "inspect";
	detail?: { kind: "task" | "criterion" | "attempt" | "evidence" | "decision" | "amendment"; id: string };
}

export interface AlignOperation {
	operation: "align";
	expectedRevision: number;
	action: "confirm" | "acknowledge" | "pause" | "cancel";
	inputGeneration: number;
	reason?: string;
}

export type AmendmentChange =
	| { kind: "add_criterion"; key: string; outcome: string; verification: string; required?: boolean }
	| { kind: "update_criterion"; id: string; outcome?: string; verification?: string; required?: boolean }
	| { kind: "retire_criterion"; id: string; replacementId?: string; reason: string }
	| { kind: "add_task"; key: string; title?: string; outcome: string; covers?: string[]; dependsOn?: string[]; enablingPurpose?: string; repositoryOwner?: string; writeSurface?: string[]; executionConstraints?: string[] }
	| { kind: "update_task"; id: string; outcome?: string; covers?: string[]; dependsOn?: string[]; writeSurface?: string[]; executionConstraints?: string[]; enablingPurpose?: string; repositoryOwner?: string }
	| { kind: "split_task"; id: string; into: Array<{ key: string; title?: string; outcome: string; covers?: string[]; dependsOn?: string[] }> }
	| { kind: "merge_tasks"; ids: string[]; key: string; title?: string; outcome: string; covers?: string[]; dependsOn?: string[] }
	| { kind: "replace_task"; id: string; key: string; title?: string; outcome: string; covers?: string[]; dependsOn?: string[] }
	| { kind: "update_goal"; goal?: string; deliveryEndpoint?: string; sourceReferences?: string[] }
	| { kind: "suspend_task"; id: string; reason: string }
	| { kind: "cancel_task"; id: string; reason: string };

export interface AmendOperation {
	operation: "amend";
	expectedRevision: number;
	reason: string;
	intentReference: string;
	changes: AmendmentChange[];
	alignInputGeneration?: number;
}

export interface StartOperation {
	operation: "start";
	expectedRevision: number;
	taskId: string;
	transport?: string;
	basis?: Partial<EvidenceBasis>;
	alignInputGeneration?: number;
}

export interface RecordOperation {
	operation: "record";
	expectedRevision: number;
	attemptId?: string;
	attempt?: { state: "reported" | "failed" | "interrupted" | "unknown"; outcome: string };
	/** Link an observed managed transport (managed:<handle>:<episode>) to the attempt after the child exists. */
	transport?: string;
	taskDisposition?: { disposition: "pending" | "blocked"; reason?: string; blockClass?: Task["blockClass"]; nextUnblockCondition?: string };
	evidence?: {
		provenance: EvidenceProvenance;
		subject: { kind: "criterion" | "task" | "workset"; id: string };
		fingerprint?: string;
		fingerprintState?: "current" | "unavailable";
		scope?: string[];
		checkIdentity: string;
		result: "pass" | "fail" | "unknown";
		exitCode?: number | null;
		artifactReferences?: string[];
		attemptId?: string;
		/** Binds this evidence to a host-observed tool result; only real observations are accepted. */
		observationId?: string;
		/** Requires an observed public managed result envelope for this handle/episode/action. */
		managed?: { handle: string; episode: number; action?: "create" | "continue" | "inspect" | "apply" | "close"; candidateId?: string };
	};
	alignInputGeneration?: number;
}

export interface AssessOperation {
	operation: "assess";
	expectedRevision: number;
	subject: { kind: "task" | "criterion"; id: string };
	verdict: "accepted" | "rejected" | "unresolved_verification";
	evidenceIds: string[];
	rationale: string;
	alignInputGeneration?: number;
}

export interface PauseOperation {
	operation: "pause";
	expectedRevision: number;
	reason: string;
}

export interface ResumeOperation {
	operation: "resume";
	expectedRevision: number;
}

export interface CloseOperation {
	operation: "close";
	expectedRevision: number;
	outcome: "completed" | "cancelled" | "superseded";
	reason: string;
	deliveryEvidenceIds?: string[];
}

/** Tool-only transaction; never nested or replayed by the reducer. Revisions are host-filled per step. */
export type BatchStep =
	| Omit<StartOperation, "expectedRevision" | "alignInputGeneration">
	| Omit<RecordOperation, "expectedRevision" | "alignInputGeneration">
	| Omit<AssessOperation, "expectedRevision" | "alignInputGeneration">
	| Omit<CloseOperation, "expectedRevision">;

export interface BatchOperation {
	operation: "batch";
	expectedRevision: number;
	steps: BatchStep[];
}

/** Internal operation: mark evidence stale when a recomputed basis no longer matches. */
export interface RefreshOperation {
	operation: "refresh";
	expectedRevision: number;
	fingerprints: Record<string, string>;
}

/** Internal operation: reconcile copied or restarted state on session start, fork, or tree navigation. */
export interface BranchResetOperation {
	operation: "branch_reset";
	expectedRevision: number;
	reason: string;
	/** Fork/tree navigation requires explicit alignment before new mutations. */
	align: boolean;
}

/** Internal operation: mark a proven real delivery, or fence an unattributable native delivery. */
export interface DeliveredOperation {
	operation: "delivered";
	expectedRevision: number;
	provenance?: "unavailable";
}

/** Internal operation: record one bounded automatic-review decision for the current input generation. */
export interface ReviewOperation {
	operation: "review";
	expectedRevision: number;
	action: "dispatched" | "blocked";
	fingerprint: string;
	reason?: string;
}

export type WorkflowOperation =
	| OpenOperation
	| InspectOperation
	| AlignOperation
	| AmendOperation
	| StartOperation
	| RecordOperation
	| AssessOperation
	| PauseOperation
	| ResumeOperation
	| CloseOperation
	| RefreshOperation
	| ReviewOperation
	| DeliveredOperation
	| BranchResetOperation;

export const MUTATING_OPERATIONS = ["align", "amend", "start", "record", "assess", "pause", "resume", "close"] as const;
