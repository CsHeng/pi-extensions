import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SUBAGENT_STATUS_COMMAND = "subagents";
export const CHILD_CAPABILITY_ENV = "CSHENG_SUBAGENT_CAPABILITY";
export const CHILD_MARKER_ENV = "CSHENG_SUBAGENT_CHILD";
export const TELEMETRY_SCHEMA_VERSION_V2 = 2 as const;
export const TELEMETRY_SCHEMA_VERSION_V3 = 3 as const;
export const TELEMETRY_SCHEMA_VERSION = 4 as const;

export const HARD_LIMITS = Object.freeze({
	maxTasks: 10,
	maxExternalReadRoots: 8,
	maxPathBytes: 4096,
	maxObjectiveBytes: 16 * 1024,
	maxInputBytes: 64 * 1024,
	maxPredecessorOutputBytes: 16 * 1024,
	maxPromptBytes: 128 * 1024,
	maxFinalOutputBytes: 50 * 1024,
	maxProtocolLineBytes: 1024 * 1024,
	maxPendingToolCalls: 1024,
	maxWaitSpans: 2048,
	maxStderrBytes: 16 * 1024,
	taskTimeoutMs: 15 * 60 * 1000,
	killGraceMs: 5 * 1000,
	heartbeatMs: 5 * 1000,
	settledExitGraceMs: 10 * 1000,
	diagnosticRetentionMs: 30 * 24 * 60 * 60 * 1000,
	diagnosticRootBytes: 512 * 1024 * 1024,
	diagnosticChildBytes: 32 * 1024 * 1024,
	diagnosticRunBytes: 256 * 1024 * 1024,
	maxDiagnosticScopes: 20,
	maxDiagnosticTimelineEntries: 200,
	maxDiagnosticLineBytes: 1024 * 1024,
	maxDiagnosticRenderBytes: 64 * 1024,
});

export const ROLE_NAMES = ["explorer", "reviewer", "worker"] as const;
export const EXECUTION_PROFILES = ["fast", "balanced", "deep"] as const;
export const REASONING_PROFILES = ["light", "standard", "deep"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const STABLE_TASK_ERROR_CODES = [
	"invalid_scope",
	"worker_write_paths_required",
	"model_not_found",
	"model_unavailable",
	"ambiguous_model",
	"thinking_unavailable",
	"worker_no_changes",
	"incomplete_report",
	"diagnostic_session_unavailable",
	"diagnostic_storage_unavailable",
	"diagnostic_session_limit",
	"child_exit_stalled",
	"repository_root_unavailable",
	"scope_outside_repository",
	"external_read_roots_forbidden",
	"invalid_external_read_root",
	"external_read_root_unavailable",
	"external_read_root_not_external",
	"duplicate_external_read_root",
] as const;
export const CHILD_CAPABILITY_MANIFEST_V1 = 1 as const;
export const CHILD_CAPABILITY_MANIFEST_V2 = 2 as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];
export type ReasoningProfile = (typeof REASONING_PROFILES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type StableTaskErrorCode = (typeof STABLE_TASK_ERROR_CODES)[number];
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "aborted";
export type RunStatus = "succeeded" | "partial" | "failed" | "aborted";
export const TASK_EXECUTION_PHASES = [
	"queued",
	"workspace-preparation",
	"child-execution",
	"convergence-critical",
	"settled",
] as const;
export type TaskExecutionPhase = (typeof TASK_EXECUTION_PHASES)[number];
export const CHILD_ACTIVITY_PHASES = [
	"starting",
	"running",
	"settling",
	"settled-awaiting-exit",
	"closed",
] as const;
export type ChildActivityPhase = (typeof CHILD_ACTIVITY_PHASES)[number];

export interface ChildActivity {
	phase: ChildActivityPhase;
	assistantTurns: number;
	activeTools: string[];
	latestEventType?: string;
	latestStopReason?: string;
	errorObserved: boolean;
	errorCount: number;
	agentEndObserved: boolean;
	agentSettledObserved: boolean;
	elapsedMs: number;
	inactiveForMs: number;
}

const RoleSchema = StringEnum(ROLE_NAMES);
const ExecutionProfileSchema = StringEnum(EXECUTION_PROFILES);
const ReasoningProfileSchema = StringEnum(REASONING_PROFILES);
const ThinkingLevelSchema = Object.assign(StringEnum(THINKING_LEVELS), {
	description: "Exact ephemeral Pi thinking level supplied only for an explicit user choice; it overrides reasoning-profile and route defaults.",
});
const BoundedStringArray = Type.Array(Type.String(), { maxItems: 32 });

export const SubagentTaskSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64 }),
		role: RoleSchema,
		objective: Type.String({ minLength: 1 }),
		scope: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			maxItems: 32,
			description: "Repository-relative paths this task may read. Prefer '.' for the repository root. Physically contained absolute or parent-traversing spellings are canonicalized to repository-relative form; declare Git-contained paths outside the current repository in externalReadRoots.",
		}),
		inputs: Type.Optional(BoundedStringArray),
		dependsOn: Type.Optional(Type.Array(Type.String(), {
			maxItems: 32,
			description: "Optional hard predecessor task IDs. Omit for ordinary independent work; use only for an approved implementation order with no intervening parent decision.",
		})),
		writePaths: Type.Optional(Type.Array(Type.String(), {
			maxItems: 32,
			description: "Optional initial repository-relative write regions, advisory for managed v3 workers. Actual in-scope additions, deletions, renames and mode changes are discovered from Git; absolute paths and parent traversal remain invalid.",
		})),
		externalReadRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
			maxItems: HARD_LIMITS.maxExternalReadRoots,
			description: "Explorer/reviewer-only exact absolute Git-contained read roots outside the current repository. At most eight entries. Omit for ordinary current-repository work; workers cannot declare this field.",
		})),
		verification: Type.Optional(BoundedStringArray),
		resourceLocks: Type.Optional(BoundedStringArray),
		executionProfile: Type.Optional(ExecutionProfileSchema),
		reasoningProfile: Type.Optional(ReasoningProfileSchema),
		model: Type.Optional(Type.String({
			minLength: 1,
			description: "Exact ephemeral model selector supplied only for an explicit user model choice; it overrides default model routing for this task.",
		})),
		thinking: Type.Optional(ThinkingLevelSchema),
	},
	{ additionalProperties: false },
);

export interface SubagentTask {
	id: string;
	role: RoleName;
	objective: string;
	scope: string[];
	inputs?: string[];
	dependsOn?: string[];
	writePaths?: string[];
	externalReadRoots?: string[];
	verification?: string[];
	resourceLocks?: string[];
	executionProfile?: ExecutionProfile;
	reasoningProfile?: ReasoningProfile;
	model?: string;
	thinking?: ThinkingLevel;
}

export interface SubagentToolInput {
	tasks: SubagentTask[];
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export type RouteSource = "parent" | "package-default" | "user-config";
export const ROUTE_SELECTION_SOURCES = ["role-default", "explicit-task"] as const;
export const PROFILE_FALLBACKS = ["execution-role-default", "reasoning-role-default"] as const;
export type RouteSelectionSource = (typeof ROUTE_SELECTION_SOURCES)[number];
export type ProfileFallback = (typeof PROFILE_FALLBACKS)[number];

/** Schema-v2 attribution attached to every successfully selected task route. */
export interface TaskRouteEvidenceV2 {
	selectionSource: RouteSelectionSource;
	modelOverrideRequested: boolean;
	thinkingOverrideRequested: boolean;
	executionProfileApplied: boolean;
	reasoningProfileApplied: boolean;
	profileFallbacks: ProfileFallback[];
}

export interface EffectiveRoute {
	provider: string;
	model: string;
	thinking: string;
	source: RouteSource;
	candidateIndex: number;
	executionProfileRequested?: ExecutionProfile;
	executionProfileApplied: boolean;
	reasoningProfileRequested?: ReasoningProfile;
	reasoningProfileApplied: boolean;
	profileFallbacks: ProfileFallback[];
	/** Added by schema-v2 routing; optional until the route decision is made. */
	selectionSource?: RouteSelectionSource;
	modelOverrideRequested?: boolean;
	thinkingOverrideRequested?: boolean;
}

export type EffectiveRouteV2 = EffectiveRoute & TaskRouteEvidenceV2;

export type TaskErrorCode = StableTaskErrorCode | (string & {});

export interface TaskError {
	code: TaskErrorCode;
	message: string;
}

export interface TaskTelemetry {
	childStarted: boolean;
	queueMs: number;
	workspaceMs: number;
	childMs: number;
	convergenceMs: number;
}

export interface TaskResult {
	/** Bounded Pi-native episode observations; missing is unavailable, not zero. */
	observation?: import("./observability.ts").NativeObservation;
	observationVersion?: 1;
	id: string;
	role: RoleName;
	status: TaskStatus;
	output: string;
	stderr: string;
	usage: UsageTotals;
	durationMs: number;
	changedPaths: string[];
	convergence: "not-applicable" | "applied" | "not-applied" | "conflict";
	telemetry?: TaskTelemetry;
	route?: EffectiveRoute;
	stopReason?: string;
	/** Mechanical report completeness; absent in historical results. */
	reportComplete?: boolean;
	/** Managed worker tools recorded ready and drained for this native episode. */
	workerToolsSettled?: boolean;
	diagnosticSessionRef?: string;
	activity?: ChildActivity;
	error?: TaskError;
}

export interface RunTelemetryV2 {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION_V2;
	runId: string;
	runDurationMs: number;
	requestedTasks: number;
	admittedTasks: number;
	requestedDependencyEdges: number;
	admittedDependencyEdges: number;
	explicitModelTasks: number;
	explicitThinkingTasks: number;
	launchedChildren: number;
	peakConcurrency: number;
	peakConcurrencyByRole: Record<RoleName, number>;
	runErrorCode?: string;
}

export type ProvenanceTelemetry =
	| { available: false }
	| { available: true; extensionEpoch: string; configurationEpoch: string };

export interface RunTelemetryV3 extends Omit<RunTelemetryV2, "schemaVersion"> {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION_V3;
	startedAtMs: number;
	provenance: ProvenanceTelemetry;
	effectiveMaxConcurrency?: number;
	effectiveRoleConcurrency?: Record<RoleName, number>;
}

export interface TimeSpan {
	startMs: number | null;
	endMs: number | null;
}
export type WaitReason = "dependency" | "capacity" | "role-capacity" | "resource-lock" | "ready";
export interface RunTiming {
	boundary: "tool-entry" | "scheduler";
	scheduler: TimeSpan | null;
	children: Array<TimeSpan & { taskId: string; role: RoleName }>;
	waits: Array<TimeSpan & { taskId: string; reasons: WaitReason[] }>;
	complete: boolean;
}
export interface RunTelemetryV4 extends Omit<RunTelemetryV3, "schemaVersion" | "runDurationMs"> {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	runDurationMs: number | null;
	timing: RunTiming;
}

/** Historical/in-memory builders may omit new evidence; never infer it. */
export interface RunTelemetry extends Omit<RunTelemetryV4,
	| "timing"
	| "requestedDependencyEdges"
	| "admittedDependencyEdges"
	| "explicitModelTasks"
	| "explicitThinkingTasks"
	| "startedAtMs"
	| "provenance"
	| "effectiveMaxConcurrency"
	| "effectiveRoleConcurrency"
> {
	timing?: RunTiming;
	requestedDependencyEdges?: number;
	admittedDependencyEdges?: number;
	explicitModelTasks?: number;
	explicitThinkingTasks?: number;
	startedAtMs?: number;
	provenance?: ProvenanceTelemetry;
	effectiveMaxConcurrency?: number;
	effectiveRoleConcurrency?: Partial<Record<RoleName, number>>;
}

export interface SubagentRunResult {
	status: RunStatus;
	tasks: TaskResult[];
	usage: UsageTotals;
	telemetry: RunTelemetry;
}

export interface ChildCapabilityManifestV1 {
	version: typeof CHILD_CAPABILITY_MANIFEST_V1;
	root: string;
	role: RoleName;
	readRoots: string[];
	writePaths: string[];
}

export interface ChildCapabilityManifestV2 {
	version: typeof CHILD_CAPABILITY_MANIFEST_V2;
	root: string;
	role: RoleName;
	readRoots: string[];
	writePaths: string[];
	externalReadRoots: string[];
	/** Runtime-derived native guidance, never supplied by a model task. */
	guidance?: { contextFiles: Array<{ path: string; content: string }>; readRoots: string[]; physicalRoots: string[] };
	/** Managed v3 source-root writes; initial writePaths are advisory. */
	writeRoot?: boolean;
}

/** Normalized runtime capability after exact v1 or v2 parse. */
export type NormalizedChildCapability = ChildCapabilityManifestV2;

/**
 * Producer/runtime capability shape. Existing v1 literals remain valid until
 * the guard and runner slices migrate to normalized v2.
 */
export type ChildCapabilityManifest = ChildCapabilityManifestV1 | ChildCapabilityManifestV2;

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function emptyTaskTelemetry(): TaskTelemetry {
	return { childStarted: false, queueMs: 0, workspaceMs: 0, childMs: 0, convergenceMs: 0 };
}

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

const UNSAFE_PATH_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/;

export function isSafePathGrammar(value: string): boolean {
	return value.length > 0 && utf8Bytes(value) <= HARD_LIMITS.maxPathBytes && !UNSAFE_PATH_CHARS.test(value);
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
