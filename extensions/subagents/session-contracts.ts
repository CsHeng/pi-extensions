import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { validateGraphStructure } from "./graph.ts";
import { HARD_LIMITS, SubagentTaskSchema, type TaskResult, type EffectiveRoute, type ProvenanceTelemetry } from "./contracts.ts";

export const SUBAGENT_SESSION_TOOL_NAME = "csheng_subagent_sessions";
export const MANAGED_SESSION_VERSION = 2;
export const MANAGED_LIMITS = Object.freeze({
	maxSessions: 10, maxEpisodes: 256, maxRegistryBytes: 2 * 1024 * 1024,
	maxStoreBytes: 512 * 1024 * 1024, maxNativeBytes: 32 * 1024 * 1024,
	maxEntries: 100_000, maxNativeLineBytes: 1024 * 1024, maxCandidateBytes: 64 * 1024 * 1024,
});
const opaque = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const version = Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes });
const episode = Type.Object({ handle: opaque, requestId: opaque, expectedEpisode: version,
	message: Type.String({ minLength: 1, maxLength: HARD_LIMITS.maxInputBytes }),
}, { additionalProperties: false });
export const SubagentSessionToolSchema = Type.Object({
	action: StringEnum(["create", "continue", "inspect", "apply", "close"] as const, { description: "create requires requestId and tasks; continue requires episodes (handle, requestId, expectedEpisode, message); inspect accepts an optional handle; apply requires handle, expectedEpisode and candidateId; close requires handle and expectedEpisode." }),
	requestId: Type.Optional(Type.String({ ...opaque, description: "Required for create. Stable caller-selected identity for replay; reuse only for the same request." })),
	tasks: Type.Optional(Type.Array(SubagentTaskSchema, { minItems: 1, maxItems: HARD_LIMITS.maxTasks, description: "Create tasks. Full workers require scope [\".\"] for one coherent source/tool view; writePaths remain exact. Read-only roles may use narrower scopes." })),
	episodes: Type.Optional(Type.Array(episode, { minItems: 1, maxItems: HARD_LIMITS.maxTasks })),
	handle: Type.Optional(opaque), expectedEpisode: Type.Optional(Type.Integer({ ...version, description: "Required for apply and close. Use the exact episode returned by the latest relevant result." })), candidateId: Type.Optional(opaque),
	disposition: Type.Optional(StringEnum(["retain", "discard"] as const)),
}, { additionalProperties: false });
export type SessionRequest = Static<typeof SubagentSessionToolSchema>;

export class ManagedError extends Error {
	readonly code: string;
	readonly missingFields?: string[];
	constructor(code: string, missingFields?: string[]) { super(code); this.name = "ManagedError"; this.code = code; if (missingFields) this.missingFields = missingFields; }
}
export function parseSessionRequest(raw: unknown): SessionRequest {
	if (!Check(SubagentSessionToolSchema, raw)) throw new ManagedError("invalid_session_request");
	const input = raw as SessionRequest;
	const fields: Record<SessionRequest["action"], readonly string[]> = {
		create: ["action", "requestId", "tasks"], continue: ["action", "episodes"],
		inspect: ["action", "handle"], apply: ["action", "handle", "expectedEpisode", "candidateId"],
		close: ["action", "handle", "expectedEpisode", "disposition"],
	};
	if (Object.keys(input).some((key) => !fields[input.action].includes(key))) throw new ManagedError("invalid_action_fields");
	if (input.action === "create") {
		if (!input.requestId || !input.tasks) throw new ManagedError("missing_create_fields", [!input.requestId && "requestId", !input.tasks && "tasks"].filter((value): value is string => !!value));
		const graph = validateGraphStructure({ tasks: input.tasks });
		if (!graph.ok) throw new ManagedError(graph.error.code);
	}
	if (input.action === "continue") {
		if (!input.episodes || new Set(input.episodes.map((item) => item.handle)).size !== input.episodes.length) throw new ManagedError("invalid_episodes");
		if (input.episodes.some((item) => Buffer.byteLength(item.message) > HARD_LIMITS.maxInputBytes)) throw new ManagedError("message_too_large");
	}
	if ((input.action === "apply" || input.action === "close") && (!input.handle || input.expectedEpisode === undefined)) throw new ManagedError("missing_session_version", [!input.handle && "handle", input.expectedEpisode === undefined && "expectedEpisode"].filter((value): value is string => !!value));
	if (input.action === "apply" && !input.candidateId) throw new ManagedError("missing_candidate");
	return input;
}

export interface SessionOwner {
	repo: string;
	parentSessionId: string;
	/** Native parent entry on the creating branch; null represents its root. */
	anchor: string | null;
}
export interface CurrentOwner extends SessionOwner { branch: readonly string[] }
export type ManagedState = "idle" | "running" | "interrupted" | "closed";
export type ApplyStatus = "not-applied" | "applying" | "applied" | "partial" | "conflict" | "unknown";
export interface CandidateRef {
	id: string;
	episode: number;
	status: ApplyStatus;
	changedPaths: string[];
	appliedPaths: string[];
}
export interface EpisodeExecution {
	startedAtMs: number;
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
	/** This request failed; result remains the latest committed episode evidence. */
	requestError?: { code: string };
}
export interface SessionActionResult {
	schemaVersion: 1 | 2;
	action: SessionRequest["action"] | null;
	requestTelemetry?: ManagedRequestTelemetry;
	status: "succeeded" | "partial" | "failed" | "aborted";
	sessions: SessionView[];
	error?: { code: string; missingFields?: string[] };
}
