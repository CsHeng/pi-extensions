import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SUBAGENT_TOOL_NAME = "csheng_subagents";
export const SUBAGENT_STATUS_COMMAND = "subagents";
export const CHILD_CAPABILITY_ENV = "CSHENG_SUBAGENT_CAPABILITY";
export const CHILD_MARKER_ENV = "CSHENG_SUBAGENT_CHILD";
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

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
export type RoleName = (typeof ROLE_NAMES)[number];
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];
export type ReasoningProfile = (typeof REASONING_PROFILES)[number];
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "aborted";
export type RunStatus = "succeeded" | "partial" | "failed" | "aborted";

const RoleSchema = StringEnum(ROLE_NAMES);
const ExecutionProfileSchema = StringEnum(EXECUTION_PROFILES);
const ReasoningProfileSchema = StringEnum(REASONING_PROFILES);
const BoundedStringArray = Type.Array(Type.String(), { maxItems: 32 });

export const SubagentTaskSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64 }),
		role: RoleSchema,
		objective: Type.String({ minLength: 1 }),
		scope: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 }),
		inputs: Type.Optional(BoundedStringArray),
		dependsOn: Type.Optional(BoundedStringArray),
		writePaths: Type.Optional(BoundedStringArray),
		verification: Type.Optional(BoundedStringArray),
		resourceLocks: Type.Optional(BoundedStringArray),
		executionProfile: Type.Optional(ExecutionProfileSchema),
		reasoningProfile: Type.Optional(ReasoningProfileSchema),
	},
	{ additionalProperties: false },
);

export const SubagentToolSchema = Type.Object(
	{
		tasks: Type.Array(SubagentTaskSchema, { minItems: 1, maxItems: HARD_LIMITS.maxTasks }),
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
	verification?: string[];
	resourceLocks?: string[];
	executionProfile?: ExecutionProfile;
	reasoningProfile?: ReasoningProfile;
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
export type ProfileFallback = "execution-role-default" | "reasoning-role-default";

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
}

export interface TaskError {
	code: string;
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

export interface RunTelemetry {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	runId: string;
	runDurationMs: number;
	requestedTasks: number;
	admittedTasks: number;
	launchedChildren: number;
	peakConcurrency: number;
	peakConcurrencyByRole: Record<RoleName, number>;
	runErrorCode?: string;
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
