import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { validateGraphStructure } from "./graph.ts";
import { observationWaitMilliseconds } from "../shared/observation-budget.ts";
import { COLLABORATION_CONTRACT_VERSION, HARD_LIMITS, SubagentTaskSchema, type TaskResult, type EffectiveRoute, type ProvenanceTelemetry } from "./contracts.ts";

export const SUBAGENT_SESSION_TOOL_NAME = "agent";
export const MANAGED_SESSION_VERSION = COLLABORATION_CONTRACT_VERSION;
export const MANAGED_LIMITS = Object.freeze({
	maxSessions: 10, maxEpisodes: 256, maxRegistryBytes: 2 * 1024 * 1024,
	maxWorkspaceBytes: 8 * 1024 * 1024 * 1024, maxNativeBytes: 32 * 1024 * 1024,
	// Native JSONL parsing remains bounded independently of filesystem entries.
	maxEntries: 100_000, maxNativeLineBytes: 1024 * 1024, maxCandidateBytes: 64 * 1024 * 1024,
});
// Legacy warning shape remains readable in historical responses; no current action estimates aggregate storage.
const cleanupGuidance = "Cleanup is optional and user-owned: close unneeded handles with disposition=discard to remove their working files (registry/native history remains). For a full reset, stop all Pi/subagent processes using this agent directory, then back up and remove <agent-dir>/subagent-managed-sessions (default ~/.pi/agent/subagent-managed-sessions). A reset loses retained histories, candidates and replay records. No automatic cleanup is performed.";
export const MANAGED_STORAGE_WARNINGS = {
	high: { code: "managed_storage_high", message: `Managed storage exceeds the advisory 8 GiB or 1,000,000-entry threshold; work is not blocked. ${cleanupGuidance}` },
	unavailable: { code: "managed_storage_unavailable", message: `Managed storage could not be fully estimated; work is not blocked. ${cleanupGuidance}` },
} as const;
export type ManagedStorageWarning = (typeof MANAGED_STORAGE_WARNINGS)[keyof typeof MANAGED_STORAGE_WARNINGS];

const opaque = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9]+$" });
const version = Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes });
const episode = Type.Object({ handle: opaque, expectedEpisode: version,
	message: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxInputBytes }),
}, { additionalProperties: false });
export const SubagentSessionToolSchema = Type.Object({
	action: StringEnum(["create", "continue", "inspect", "apply", "close", "refresh", "join", "cancel"] as const, { description: "create starts a batch of bounded tasks; continue sends a message using an existing Agent's pinned input and worktree, not the latest parent files; inspect alone lists this session's Agents, or one handle/runId; join waits for a run within a bounded observation budget; cancel stops a run or one task; apply merges one accepted candidate; close retains or discards an owned session; refresh explicitly merges current parent files into an idle Agent's input; it may conflict, and success invalidates the old candidate." }),
	tasks: Type.Optional(Type.Array(SubagentTaskSchema, { minItems: 1, maxItems: HARD_LIMITS.maxTasks, description: "Create tasks. Each task declares a role, objective, readable label and explicit access grants. A write grant may name several repository roots. Role selects purpose and routing, not permission. Independent tasks may run in parallel." })),
	episodes: Type.Optional(Type.Array(episode, { minItems: 1, maxItems: HARD_LIMITS.maxTasks, description: "Continue episodes: each names an idle Agent handle, the exact expectedEpisode, and the next message." })),
	handle: Type.Optional(opaque), expectedEpisode: Type.Optional(Type.Integer({ ...version, description: "Required for apply, refresh and close. Use the exact episode returned by the latest relevant result." })), candidateId: Type.Optional(opaque),
	disposition: Type.Optional(StringEnum(["retain", "discard"] as const)),
	runId: Type.Optional(opaque),
	mode: Type.Optional(StringEnum(["async", "foreground"] as const, { description: "create/continue: foreground waits within this call for one run; async returns a submission receipt." })),
	waitSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Observation budget for create/continue/join; default 180 seconds, with explicit finite durations honored without a product cap. Expiry returns this call while execution continues. inspect returns immediately." })),
	taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "\\S", description: "cancel only: optional task handle within the run, or its readable label. Omit for join, which waits for the whole run." })),
}, { additionalProperties: false });
export type SessionRequest = Static<typeof SubagentSessionToolSchema>;

export interface ConflictScope {
	rootId: string;
	/** Candidate change scope, not a claim that every listed path conflicts. */
	changedPaths: string[];
	changedCount: number;
	pathsTruncated: boolean;
}
export interface ManagedErrorDiagnostics {
	missingFields?: string[];
	unexpectedFields?: string[];
	invalidFields?: string[];
	conflicts?: ConflictScope[];
}
export class ManagedError extends Error implements ManagedErrorDiagnostics {
	readonly code: string;
	readonly missingFields?: string[];
	readonly unexpectedFields?: string[];
	readonly invalidFields?: string[];
	readonly conflicts?: ConflictScope[];
	readonly detail?: string;
	constructor(code: string, diagnostics: ManagedErrorDiagnostics = {}, detail?: string) {
		super(code); this.name = "ManagedError"; this.code = code;
		if (diagnostics.missingFields) this.missingFields = diagnostics.missingFields;
		if (diagnostics.unexpectedFields) this.unexpectedFields = diagnostics.unexpectedFields;
		if (diagnostics.invalidFields) this.invalidFields = diagnostics.invalidFields;
		if (diagnostics.conflicts) this.conflicts = diagnostics.conflicts;
		if (detail) this.detail = detail;
	}
}
export function parseSessionRequest(raw: unknown): SessionRequest {
	if (!Check(SubagentSessionToolSchema, raw)) {
		// Keep the rejection addressable: name the failing field, never echo the value.
		const failing = Errors(SubagentSessionToolSchema, raw)[0];
		const params = failing?.params as { additionalProperties?: unknown; requiredProperties?: unknown } | undefined;
		const named = failing?.keyword === "additionalProperties" && Array.isArray(params?.additionalProperties) ? params.additionalProperties[0]
			: failing?.keyword === "required" && Array.isArray(params?.requiredProperties) ? params.requiredProperties[0]
			: (failing?.instancePath ?? "").split("/").filter(Boolean).at(-1);
		const field = typeof named === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(named) ? [named] : undefined;
		const kind = failing?.keyword === "required" ? "missingFields" : failing?.keyword === "additionalProperties" ? "unexpectedFields" : "invalidFields";
		throw new ManagedError("invalid_session_request", field ? { [kind]: field } : undefined);
	}
	const input = raw as SessionRequest;
	const fields: Record<SessionRequest["action"], readonly string[]> = {
		create: ["action", "tasks", "mode", "waitSeconds"], continue: ["action", "episodes", "mode", "waitSeconds"],
		inspect: ["action", "handle", "runId"], apply: ["action", "handle", "expectedEpisode", "candidateId"],
		close: ["action", "handle", "expectedEpisode", "disposition"], refresh: ["action", "handle", "expectedEpisode"],
		join: ["action", "runId", "mode", "waitSeconds"], cancel: ["action", "runId", "taskId"],
	};
	const unexpected = Object.keys(input).filter((key) => !fields[input.action].includes(key));
	if (unexpected.length > 0) throw new ManagedError("invalid_action_fields", { unexpectedFields: unexpected });
	if (input.waitSeconds !== undefined) { try { observationWaitMilliseconds(input.waitSeconds); } catch { throw new ManagedError("invalid_wait_seconds"); } }
	if (input.waitSeconds !== undefined && input.mode === "async") throw new ManagedError("wait_requires_foreground");
	if (input.action === "create") {
		if (!input.tasks) throw new ManagedError("missing_create_fields", { missingFields: ["tasks"] });
		const graph = validateGraphStructure({ tasks: input.tasks });
		if (!graph.ok) throw new ManagedError(graph.error.code, undefined, graph.error.message);
	}
	if (input.action === "continue") {
		if (!input.episodes || new Set(input.episodes.map((item) => item.handle)).size !== input.episodes.length) throw new ManagedError("invalid_episodes");
		if (input.episodes.some((item) => Buffer.byteLength(item.message) > HARD_LIMITS.maxInputBytes)) throw new ManagedError("message_too_large");
	}
	if ((input.action === "apply" || input.action === "close" || input.action === "refresh") && (!input.handle || input.expectedEpisode === undefined)) throw new ManagedError("missing_session_version", { missingFields: [!input.handle && "handle", input.expectedEpisode === undefined && "expectedEpisode"].filter((value): value is string => !!value) });
	if (input.action === "apply" && !input.candidateId) throw new ManagedError("missing_candidate", { missingFields: ["candidateId"] });
	if ((input.action === "join" || input.action === "cancel") && !input.runId) throw new ManagedError("missing_run_id", { missingFields: ["runId"] });
	if (input.action === "join" && input.mode !== undefined) {
		if (input.mode !== "foreground") throw new ManagedError("invalid_join_mode");
		const { mode: _mode, ...canonical } = input;
		return canonical as SessionRequest;
	}
	return input;
}

export interface SessionOwner {
	repo: string;
	parentSessionId: string;
	/** Native parent entry on the creating branch; null represents its root. */
	anchor: string | null;
}
export interface CurrentOwner extends SessionOwner { branch: readonly string[] }
export type ManagedState = "idle" | "queued" | "running" | "interrupted" | "closed";
export type ApplyStatus = "not-applied" | "applying" | "applied" | "partial" | "conflict" | "unknown";
export interface CandidateRootStatus {
	rootId: string;
	destination: string;
	status: ApplyStatus;
	changedPaths: string[];
	appliedPaths: string[];
	git?: import("./git-workspace.ts").GitCandidate;
	attempt?: import("./git-workspace.ts").GitApplyAttempt;
}
export interface CandidateRef {
	id: string;
	episode: number;
	status: ApplyStatus;
	changedPaths: string[];
	appliedPaths: string[];
	roots: CandidateRootStatus[];
}
/** Bounded per-root owned-resource outcome, independent of whether a candidate was frozen. */
export interface OwnedRootOutcome {
	id: string;
	destination: string;
	status: string;
	recovery?: "required";
	release: string;
}
export interface EpisodeExecution {
	startedAtMs: number;
	inheritSkills?: boolean;
	provenance: ProvenanceTelemetry;
}
export interface ManagedRequestTelemetry {
	version: 1;
	ownerSessionId: string;
	invocationId: string;
	startedAtMs: number;
	durationMs: number | null;
	extensionEpoch: string | null;
	configurationEpoch: string | null;
	requestedTasks: number | null;
	admittedTasks: number | null;
	launchedChildren: number;
	replayedEpisodes: number;
}
export interface SessionView {
	/** Readable task label from the accepted call; `handle` remains the persistent identity. */
	label?: string;
	/** Current owner/episode-scoped observation, not retained evidence or candidate readiness. */
	liveActivity?: Pick<import("./observer-events.ts").ObserverTask, "executionPhase" | "elapsedMs" | "calls" | "callsTruncated"> & { runId: string };
	execution?: EpisodeExecution;
	route?: EffectiveRoute;
	handle: string;
	role: "explorer" | "reviewer" | "worker";
	episode: number;
	state: ManagedState;
	reportComplete: boolean;
	result?: TaskResult;
	candidate?: CandidateRef;
	retained?: boolean;
	release?: { status: "pending" | "partial" | "complete"; remaining: string[] };
	/** Per-root destination/apply/recovery/release projection; present once an explicit release exists
	 * (candidate-only roots already travel inside `candidate`). */
	roots?: OwnedRootOutcome[];
	/** This request failed; result remains the latest committed episode evidence. */
	requestError?: { code: string; detail?: string };
}
export interface SessionActionResult {
	schemaVersion: typeof MANAGED_SESSION_VERSION;
	action: SessionRequest["action"] | null;
	requestTelemetry?: ManagedRequestTelemetry;
	/** Legacy advisory on historical envelopes; current actions do not generate it. */
	warnings?: ManagedStorageWarning[];
	status: "accepted" | "succeeded" | "partial" | "failed" | "aborted";
	kind?: "submission" | "execution";
	runId?: string;
	generation?: string;
	cancelOutcome?: string;
	/** Observation budget expired; this does not cancel or settle the execution. */
	wait?: { status: "expired"; waitSeconds: number };
	sessions: SessionView[];
	error?: ManagedErrorDiagnostics & { code: string; detail?: string };
}
