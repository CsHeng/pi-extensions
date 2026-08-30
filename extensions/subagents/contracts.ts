import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SUBAGENT_TOOL_NAME = "csheng_subagents";
export const SUBAGENT_STATUS_COMMAND = "subagents";
export const CHILD_CAPABILITY_ENV = "CSHENG_SUBAGENT_CAPABILITY";
export const CHILD_MARKER_ENV = "CSHENG_SUBAGENT_CHILD";
export const TELEMETRY_SCHEMA_VERSION = 2 as const;

export const HARD_LIMITS = Object.freeze({
	maxTasks: 10,
	maxConcurrency: 10,
	maxExplorers: 4,
	maxReviewers: 4,
	maxWorkers: 2,
	maxObjectiveBytes: 16 * 1024,
	maxInputBytes: 64 * 1024,
	maxPredecessorOutputBytes: 16 * 1024,
	maxPromptBytes: 128 * 1024,
	maxFinalOutputBytes: 50 * 1024,
	maxStderrBytes: 16 * 1024,
	taskTimeoutMs: 15 * 60 * 1000,
	killGraceMs: 5 * 1000,
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
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];
export type ReasoningProfile = (typeof REASONING_PROFILES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type StableTaskErrorCode = (typeof STABLE_TASK_ERROR_CODES)[number];
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "aborted";
export type RunStatus = "succeeded" | "partial" | "failed" | "aborted";

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
			description: "Repository-relative paths this task may read. Use '.' for the repository root; absolute paths and parent traversal are rejected.",
		}),
		inputs: Type.Optional(BoundedStringArray),
		dependsOn: Type.Optional(Type.Array(Type.String(), {
			maxItems: 32,
			description: "Optional hard predecessor task IDs. Omit for ordinary independent work; use only for an approved implementation order with no intervening parent decision.",
		})),
		writePaths: Type.Optional(Type.Array(Type.String(), {
			maxItems: 32,
			description: "Exact repository-relative files this task may write. Every worker must declare its exact write files; directories, absolute paths, and parent traversal are rejected.",
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

export const SubagentToolSchema = Type.Object(
	{
		tasks: Type.Array(SubagentTaskSchema, {
			minItems: 1,
			maxItems: HARD_LIMITS.maxTasks,
			description: "A bounded foreground task batch. Keep ordinary exploration and review tasks independent and flat; dependsOn is only for eligible hard predecessor edges.",
		}),
	},
	{
		additionalProperties: false,
		description: "Execute one bounded foreground batch of fixed-role subagent tasks.",
	},
);

export interface SubagentTask {
	id: string;
	role: RoleName;
	objective: string;
	scope: string[];
	inputs?: string[];
	dependsOn?: string[];
	writePaths?: string[];
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
	error?: TaskError;
}

export interface RunTelemetryV2 {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
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

/**
 * Runtime-facing additive compatibility shape. New schema-v2 counters are
 * populated by run integration; the strict persisted shape is RunTelemetryV2.
 */
export interface RunTelemetry extends Omit<RunTelemetryV2,
	| "requestedDependencyEdges"
	| "admittedDependencyEdges"
	| "explicitModelTasks"
	| "explicitThinkingTasks"
> {
	requestedDependencyEdges?: number;
	admittedDependencyEdges?: number;
	explicitModelTasks?: number;
	explicitThinkingTasks?: number;
}

export interface SubagentRunResult {
	status: RunStatus;
	tasks: TaskResult[];
	usage: UsageTotals;
	telemetry: RunTelemetry;
}

export interface ChildCapabilityManifest {
	version: 1;
	root: string;
	role: RoleName;
	readRoots: string[];
	writePaths: string[];
}

export function roleConcurrencyCeiling(role: RoleName): number {
	if (role === "worker") return HARD_LIMITS.maxWorkers;
	if (role === "reviewer") return HARD_LIMITS.maxReviewers;
	return HARD_LIMITS.maxExplorers;
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function emptyTaskTelemetry(): TaskTelemetry {
	return { childStarted: false, queueMs: 0, workspaceMs: 0, childMs: 0, convergenceMs: 0 };
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
