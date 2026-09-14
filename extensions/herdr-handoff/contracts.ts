import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const HANDOFF_TOOL_NAME = "herdr_handoff";
export const HANDOFF_STATUS_COMMAND = "herdr-handoff";
export const HANDOFF_REQUEST_PROTOCOL = "pi-herdr-handoff/v1";
export const HANDOFF_RETURN_PROTOCOL = "pi-herdr-return/v1";
export const HANDOFF_RESULT_SCHEMA_VERSION = 1 as const;
export const RETURN_START_SENTINEL = "<<<PI_HERDR_RETURN_V1>>>";
export const RETURN_END_SENTINEL = "<<<END_PI_HERDR_RETURN_V1>>>";
export const LAUNCH_CONFIG_FILE = "herdr-handoff.json";

export const HARD_LIMITS = Object.freeze({
	maxPlanBytes: 64 * 1024,
	maxObjectiveBytes: 8 * 1024,
	maxWritePaths: 32,
	maxNonGoals: 32,
	maxVerificationEntries: 32,
	maxContextEntries: 32,
	maxPromptBytes: 128 * 1024,
	maxReturnEnvelopeBytes: 32 * 1024,
	maxReturnLines: 240,
	maxSummaryBytes: 4 * 1024,
	maxEvidenceBytes: 8 * 1024,
	maxContinueMessageBytes: 16 * 1024,
	maxArgvItems: 32,
	maxArgvItemBytes: 4 * 1024,
	maxArgvTotalBytes: 16 * 1024,
	minWaitMs: 5_000,
	defaultWaitMs: 30 * 60 * 1000,
	maxWaitMs: 30 * 60 * 1000,
	minStartupTimeoutMs: 3_001,
	maxStartupTimeoutMs: 300_000,
	cancelWaitMs: 5_000,
	maxActiveOperations: 1,
	maxClarifications: 1,
	maxRepairs: 1,
	maxRecoveryWaits: 1,
	maxHandleBytes: 128,
	maxIdentifierBytes: 32,
	maxTargetBytes: 64,
	maxQuestions: 16,
	maxRisks: 16,
});

export const HANDOFF_ACTIONS = ["begin", "continue", "wait", "cancel"] as const;
export const HANDOFF_MODES = ["delegate-return", "transfer"] as const;
export const TARGET_TYPES = ["message-existing", "start-and-ask"] as const;
export const CONTINUE_INTENTS = ["clarification", "repair"] as const;
export const HANDOFF_STATES = [
	"new",
	"prompting",
	"waiting",
	"returned",
	"blocked",
	"timed_out",
	"transferred",
	"cancelled",
	"failed",
	"stale",
] as const;
export const HANDOFF_EVENTS = [
	"begin_delegate",
	"begin_transfer",
	"prompt_submitted",
	"settled_idle",
	"settled_done",
	"settled_blocked",
	"observed_working",
	"timed_out",
	"continue_clarification",
	"continue_repair",
	"recovery_wait",
	"cancel_requested",
	"cancel_confirmed",
	"cancel_unconfirmed",
	"identity_mismatch",
	"operation_failed",
] as const;
export const BRIDGE_STATUSES = ["returned", "transferred", "blocked", "timed_out", "cancelled", "failed"] as const;
export const AGENT_OUTCOMES = ["implemented", "no_changes", "blocked", "needs_authority", "failed"] as const;
export const WORKSPACE_STATUSES = [
	"within_declared_writes",
	"scope_violation",
	"history_changed",
	"not_inspected",
	"unavailable",
] as const;
export const CHECKOUT_KINDS = ["linked-worktree"] as const;
export const ROUTE_EVIDENCE = ["launch-profile", "externally_configured_unverified"] as const;
export const LIFECYCLE_STATES = ["idle", "working", "blocked", "done", "unknown"] as const;
export const HANDOFF_ERROR_CODES = [
	"herdr_environment_required",
	"herdr_cli_unavailable",
	"herdr_cli_incompatible",
	"herdr_protocol_error",
	"handoff_active",
	"invalid_handoff_request",
	"plan_outside_repository",
	"plan_too_large",
	"invalid_write_path",
	"launch_config_invalid",
	"launch_profile_not_found",
	"agent_start_failed",
	"agent_not_ready",
	"agent_auth_blocked",
	"agent_not_found",
	"agent_kind_mismatch",
	"agent_busy",
	"agent_blocked",
	"agent_unknown",
	"self_target_rejected",
	"stale_handle",
	"workspace_not_git",
	"workspace_mismatch",
	"workspace_dirty",
	"transfer_requires_isolation",
	"baseline_unavailable",
	"agent_prompt_stalled",
	"handoff_timed_out",
	"handoff_blocked",
	"malformed_return",
	"return_id_mismatch",
	"scope_violation",
	"history_changed",
	"index_changed",
	"claim_mismatch",
	"continuation_budget_exhausted",
	"ownership_transferred",
	"cancel_unconfirmed",
] as const;

export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];
export type HandoffMode = (typeof HANDOFF_MODES)[number];
export type HandoffState = (typeof HANDOFF_STATES)[number];
export type HandoffEvent = (typeof HANDOFF_EVENTS)[number];
export type BridgeStatus = (typeof BRIDGE_STATUSES)[number];
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export type CheckoutKind = (typeof CHECKOUT_KINDS)[number];
export type RouteEvidence = (typeof ROUTE_EVIDENCE)[number];
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];

/** One owner for the code-to-message mapping; the Record type forces every code to have a message. */
const HANDOFF_ERROR_MESSAGES: Record<HandoffErrorCode, string> = {
	herdr_environment_required: "Herdr environment is required.",
	herdr_cli_unavailable: "Herdr CLI is unavailable.",
	herdr_cli_incompatible: "Herdr CLI is incompatible.",
	herdr_protocol_error: "Herdr CLI protocol is invalid.",
	handoff_active: "A handoff is already active.",
	invalid_handoff_request: "Handoff request is invalid.",
	plan_outside_repository: "Plan file is outside the repository.",
	plan_too_large: "Canonical plan exceeds the size ceiling.",
	invalid_write_path: "Write path is invalid.",
	launch_config_invalid: "Launch configuration is invalid.",
	launch_profile_not_found: "Launch profile was not found.",
	agent_start_failed: "Agent start failed.",
	agent_not_ready: "Agent is not ready.",
	agent_auth_blocked: "Agent authentication is blocked.",
	agent_not_found: "Agent was not found.",
	agent_kind_mismatch: "Agent kind does not match.",
	agent_busy: "Agent is busy.",
	agent_blocked: "Agent is blocked.",
	agent_unknown: "Agent state is unknown.",
	self_target_rejected: "Caller pane cannot be the recipient.",
	stale_handle: "Handoff handle is stale.",
	workspace_not_git: "Workspace is not a Git checkout.",
	workspace_mismatch: "Workspace does not match the trusted repository.",
	workspace_dirty: "Workspace is dirty.",
	transfer_requires_isolation: "Transfer requires an isolated linked worktree.",
	baseline_unavailable: "Workspace baseline is unavailable.",
	agent_prompt_stalled: "Agent prompt stalled.",
	handoff_timed_out: "Handoff observation timed out.",
	handoff_blocked: "Handoff is blocked.",
	malformed_return: "Recipient return envelope is malformed.",
	return_id_mismatch: "Recipient return envelope handoff ID does not match.",
	scope_violation: "Workspace changes exceeded declared writes.",
	history_changed: "Git history changed.",
	index_changed: "Git index changed.",
	claim_mismatch: "Recipient changed-path claim does not match postflight.",
	continuation_budget_exhausted: "Continuation budget is exhausted.",
	ownership_transferred: "Handoff ownership was transferred.",
	cancel_unconfirmed: "Cancellation was not confirmed.",
};

export function handoffErrorMessage(code: HandoffErrorCode): string {
	return HANDOFF_ERROR_MESSAGES[code];
}

const ModeSchema = StringEnum(HANDOFF_MODES);
const IntentSchema = StringEnum(CONTINUE_INTENTS);
const IdentifierSchema = Type.String({
	minLength: 1,
	maxLength: HARD_LIMITS.maxIdentifierBytes,
	pattern: "^[a-z][a-z0-9_-]{0,31}$",
});
const WaitTimeoutSchema = Type.Integer({
	minimum: HARD_LIMITS.minWaitMs,
	maximum: HARD_LIMITS.maxWaitMs,
});
const BoundedPathArray = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	maxItems: HARD_LIMITS.maxWritePaths,
});
const BoundedTextArray = Type.Array(Type.String({ minLength: 1 }), {
	maxItems: HARD_LIMITS.maxNonGoals,
});

export const HandoffPlanSchema = Type.Union([
	Type.Object({
		source: Type.Literal("inline"),
		text: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxPlanBytes }),
	}, { additionalProperties: false }),
	Type.Object({
		source: Type.Literal("file"),
		path: Type.String({ minLength: 1, maxLength: 4096 }),
	}, { additionalProperties: false }),
]);

export const HandoffTargetSchema = Type.Union([
	Type.Object({
		type: Type.Literal("message-existing"),
		target: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxTargetBytes }),
		kind: IdentifierSchema,
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("start-and-ask"),
		profileId: IdentifierSchema,
	}, { additionalProperties: false }),
]);

export const HandoffRequestSchema = Type.Object({
	objective: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxObjectiveBytes }),
	plan: HandoffPlanSchema,
	allowedWrites: BoundedPathArray,
	nonGoals: BoundedTextArray,
	verification: Type.Array(Type.String({ minLength: 1 }), {
		maxItems: HARD_LIMITS.maxVerificationEntries,
	}),
	context: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		maxItems: HARD_LIMITS.maxContextEntries,
	})),
}, { additionalProperties: false });

export const BeginHandoffSchema = Type.Object({
	action: Type.Literal("begin"),
	mode: ModeSchema,
	target: HandoffTargetSchema,
	request: HandoffRequestSchema,
	waitTimeoutMs: Type.Optional(WaitTimeoutSchema),
}, { additionalProperties: false });

export const ContinueHandoffSchema = Type.Object({
	action: Type.Literal("continue"),
	handle: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxHandleBytes }),
	intent: IntentSchema,
	message: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxContinueMessageBytes }),
	waitTimeoutMs: Type.Optional(WaitTimeoutSchema),
}, { additionalProperties: false });

export const WaitHandoffSchema = Type.Object({
	action: Type.Literal("wait"),
	handle: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxHandleBytes }),
	waitTimeoutMs: WaitTimeoutSchema,
}, { additionalProperties: false });

export const CancelHandoffSchema = Type.Object({
	action: Type.Literal("cancel"),
	handle: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxHandleBytes }),
}, { additionalProperties: false });

export const HandoffToolSchema = {
	...Type.Union([
		BeginHandoffSchema,
		ContinueHandoffSchema,
		WaitHandoffSchema,
		CancelHandoffSchema,
	]),
	type: "object" as const,
	description: "Hand one bounded implementation package to a persistent Herdr-managed coding agent. Use only after an explicit user request for Herdr or a named external harness handoff.",
};

/**
 * Model-facing input types derive from their runtime schemas so a schema change cannot
 * leave a second hand-written declaration behind.
 */
export type HandoffPlan = Static<typeof HandoffPlanSchema>;
export type HandoffRequest = Static<typeof HandoffRequestSchema>;
export type BeginHandoffInput = Static<typeof BeginHandoffSchema>;
export type ContinueHandoffInput = Static<typeof ContinueHandoffSchema>;
export type WaitHandoffInput = Static<typeof WaitHandoffSchema>;
export type CancelHandoffInput = Static<typeof CancelHandoffSchema>;
export type HandoffToolInput = BeginHandoffInput | ContinueHandoffInput | WaitHandoffInput | CancelHandoffInput;

export interface LaunchProfile {
	kind: string;
	args: string[];
	startupTimeoutMs?: number;
}

export interface PublicHandoffHandle {
	token: string;
	paneId: string;
	workspaceId: string;
	tabId: string;
	recipientKind: string;
	recipientName?: string;
	checkoutKind: CheckoutKind;
	checkoutPath: string;
}

export interface ContinuationCounters {
	clarifications: number;
	repairs: number;
	recoveryWaits: number;
}

export interface RecipientReturnEnvelope {
	protocol: typeof HANDOFF_RETURN_PROTOCOL;
	handoff_id: string;
	outcome: AgentOutcome;
	summary: string;
	changed_paths: string[];
	verification: RecipientVerificationRecord[];
	questions: string[];
	risks: string[];
}

export interface RecipientVerificationRecord {
	check: string;
	status: "passed" | "failed" | "not_run";
	evidence: string;
}

export interface WorkspaceEvidence {
	status: WorkspaceStatus;
	changedPaths: string[];
	violations: string[];
}

export interface HandoffError {
	code: HandoffErrorCode;
	message: string;
}

export interface HandoffResult {
	schemaVersion: typeof HANDOFF_RESULT_SCHEMA_VERSION;
	handoffId: string;
	mode: HandoffMode;
	action: HandoffAction;
	planSha256: string;
	bridgeStatus: BridgeStatus;
	agentOutcome?: AgentOutcome;
	workspaceStatus: WorkspaceStatus;
	handle?: PublicHandoffHandle;
	recipientKind?: string;
	recipientName?: string;
	paneId?: string;
	workspaceId?: string;
	tabId?: string;
	checkoutKind?: CheckoutKind;
	checkoutPath?: string;
	lifecycleState?: LifecycleState;
	lifecycleSequence?: number;
	continuation: ContinuationCounters;
	recipientReturn?: RecipientReturnEnvelope;
	workspace?: WorkspaceEvidence;
	routeEvidence?: RouteEvidence;
	durationMs: number;
	error?: HandoffError;
}

export interface HandoffMachine {
	status: HandoffState;
	mode?: HandoffMode;
	clarificationUsed: boolean;
	repairUsed: boolean;
	recoveryWaitUsed: boolean;
	unresolvedCancellation: boolean;
	activeOperation: boolean;
}

export interface TransitionSuccess {
	ok: true;
	machine: HandoffMachine;
}

export interface TransitionFailure {
	ok: false;
	code: HandoffErrorCode;
	machine: HandoffMachine;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

interface TransitionRule {
	from: HandoffState;
	event: HandoffEvent;
	to: HandoffState;
	mode?: HandoffMode;
	requireClarificationAvailable?: boolean;
	requireRepairAvailable?: boolean;
	requireRecoveryAvailable?: boolean;
}

export const TRANSITION_TABLE: readonly TransitionRule[] = Object.freeze([
	{ from: "new", event: "begin_delegate", to: "prompting" },
	{ from: "new", event: "begin_transfer", to: "prompting" },
	{ from: "prompting", event: "prompt_submitted", to: "waiting" },
	{ from: "prompting", event: "operation_failed", to: "failed" },
	{ from: "prompting", event: "identity_mismatch", to: "stale" },
	{ from: "prompting", event: "cancel_requested", to: "prompting" },
	{ from: "prompting", event: "cancel_confirmed", to: "cancelled" },
	{ from: "prompting", event: "cancel_unconfirmed", to: "failed" },
	{ from: "waiting", event: "settled_idle", to: "returned", mode: "delegate-return" },
	{ from: "waiting", event: "settled_done", to: "returned", mode: "delegate-return" },
	{ from: "waiting", event: "settled_blocked", to: "blocked", mode: "delegate-return" },
	{ from: "waiting", event: "observed_working", to: "waiting", mode: "delegate-return" },
	{ from: "waiting", event: "observed_working", to: "transferred", mode: "transfer" },
	{ from: "waiting", event: "timed_out", to: "timed_out" },
	{ from: "waiting", event: "operation_failed", to: "failed" },
	{ from: "waiting", event: "identity_mismatch", to: "stale" },
	{ from: "waiting", event: "cancel_requested", to: "waiting" },
	{ from: "waiting", event: "cancel_confirmed", to: "cancelled" },
	{ from: "waiting", event: "cancel_unconfirmed", to: "failed" },
	{ from: "returned", event: "continue_clarification", to: "prompting", requireClarificationAvailable: true },
	{ from: "returned", event: "continue_repair", to: "prompting", requireRepairAvailable: true },
	{ from: "returned", event: "identity_mismatch", to: "stale" },
	{ from: "blocked", event: "recovery_wait", to: "waiting", requireRecoveryAvailable: true },
	{ from: "blocked", event: "identity_mismatch", to: "stale" },
	{ from: "blocked", event: "cancel_requested", to: "blocked" },
	{ from: "blocked", event: "cancel_confirmed", to: "cancelled" },
	{ from: "blocked", event: "cancel_unconfirmed", to: "failed" },
	{ from: "timed_out", event: "recovery_wait", to: "waiting", requireRecoveryAvailable: true },
	{ from: "timed_out", event: "identity_mismatch", to: "stale" },
	{ from: "timed_out", event: "cancel_requested", to: "timed_out" },
	{ from: "timed_out", event: "cancel_confirmed", to: "cancelled" },
	{ from: "timed_out", event: "cancel_unconfirmed", to: "failed" },
]);

const OWNED_HANDLE_STATES: ReadonlySet<HandoffState> = new Set([
	"prompting",
	"waiting",
	"returned",
	"blocked",
	"timed_out",
	"failed",
]);

export function initialHandoffMachine(): HandoffMachine {
	return {
		status: "new",
		clarificationUsed: false,
		repairUsed: false,
		recoveryWaitUsed: false,
		unresolvedCancellation: false,
		activeOperation: false,
	};
}

export function emptyContinuation(): ContinuationCounters {
	return { clarifications: 0, repairs: 0, recoveryWaits: 0 };
}

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncatedBytes: number } {
	const size = utf8Bytes(value);
	if (size <= maxBytes) return { text: value, truncatedBytes: 0 };
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	const text = value.slice(0, low);
	return { text, truncatedBytes: size - utf8Bytes(text) };
}

function cloneMachine(machine: HandoffMachine): HandoffMachine {
	return { ...machine };
}

function matchingRule(machine: HandoffMachine, event: HandoffEvent): TransitionRule | undefined {
	return TRANSITION_TABLE.find((rule) => {
		if (rule.from !== machine.status || rule.event !== event) return false;
		if (rule.mode !== undefined && rule.mode !== machine.mode) return false;
		return true;
	});
}

export function transitionHandoff(machine: HandoffMachine, event: HandoffEvent): TransitionResult {
	const current = cloneMachine(machine);
	if ((event === "begin_delegate" || event === "begin_transfer") && current.unresolvedCancellation) {
		return { ok: false, code: "cancel_unconfirmed", machine: current };
	}
	if ((event === "begin_delegate" || event === "begin_transfer") && current.status !== "new") {
		return { ok: false, code: "handoff_active", machine: current };
	}
	if (
		(event === "continue_clarification" || event === "continue_repair" || event === "recovery_wait" || event.startsWith("cancel_"))
		&& current.status === "transferred"
	) {
		return { ok: false, code: "ownership_transferred", machine: current };
	}
	const rule = matchingRule(current, event);
	if (!rule) {
		return { ok: false, code: "herdr_protocol_error", machine: current };
	}
	if (rule.requireClarificationAvailable && current.clarificationUsed) {
		return { ok: false, code: "continuation_budget_exhausted", machine: current };
	}
	if (rule.requireRepairAvailable && current.repairUsed) {
		return { ok: false, code: "continuation_budget_exhausted", machine: current };
	}
	if (rule.requireRecoveryAvailable && current.recoveryWaitUsed) {
		return { ok: false, code: "continuation_budget_exhausted", machine: current };
	}

	const next = cloneMachine(current);
	next.status = rule.to;
	if (event === "begin_delegate") next.mode = "delegate-return";
	if (event === "begin_transfer") next.mode = "transfer";
	if (event === "continue_clarification") next.clarificationUsed = true;
	if (event === "continue_repair") next.repairUsed = true;
	if (event === "recovery_wait") next.recoveryWaitUsed = true;
	if (event === "cancel_unconfirmed") next.unresolvedCancellation = true;
	if (event === "cancel_confirmed") next.unresolvedCancellation = false;
	next.activeOperation = next.status === "prompting" || next.status === "waiting";
	return { ok: true, machine: next };
}

export function ownsLiveHandle(machine: HandoffMachine): boolean {
	return machine.status !== "new"
		&& machine.status !== "transferred"
		&& machine.status !== "cancelled"
		&& machine.status !== "stale"
		&& (OWNED_HANDLE_STATES.has(machine.status) || machine.unresolvedCancellation);
}

export function claimsCompletion(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(claimsCompletion);
	if (typeof value !== "object" || value === null) return false;
	for (const [key, nested] of Object.entries(value)) {
		if (key === "verified" || key === "completed" || key === "completion") return true;
		if (nested === "verified" || nested === "completed") return true;
		if (claimsCompletion(nested)) return true;
	}
	return false;
}
