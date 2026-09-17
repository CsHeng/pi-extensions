/**
 * Host-observed execution facts for workflow evidence (WF-03).
 *
 * The index only ever contains facts that a real tool result reported in this extension
 * instance. It keeps bounded structured summaries, never raw reports, prompts, or file bodies.
 * A referenced handle or observation that is not present here cannot be fabricated by the model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Managed executor tool name; kept local so the workflow extension stays independently removable. */
export const MANAGED_SESSION_TOOL_NAME = "csheng_subagent_sessions";

export const OBSERVATION_LIMITS = Object.freeze({ maxEntries: 256, maxSessions: 10, maxScalar: 128 });

export interface ManagedSessionObservation {
	handle: string;
	episode: number;
	role: string;
	state: string;
	reportComplete: boolean;
	candidate?: { id: string; status: string; changedPaths: number; appliedPaths: number };
}

export interface ManagedResultObservation {
	action: string | null;
	status: string;
	sessions: ManagedSessionObservation[];
}

export interface HostObservation {
	/** Host tool-call identity; the only supported provenance for bound evidence. */
	toolCallId: string;
	toolName: string;
	/** Wall-clock time the host reported the result; evidence cannot claim to verify an earlier attempt. */
	at: string;
	/** Session that produced the result; a delivery from another session or branch is not this session's evidence. */
	sessionId: string;
	isError: boolean;
	exitCode?: number | null;
	managed?: ManagedResultObservation;
}

export interface ManagedQuery {
	handle: string;
	episode: number;
	action?: string;
	candidateId?: string;
}

export interface ObservationIndex {
	record(observation: HostObservation): void;
	get(toolCallId: string): HostObservation | undefined;
	findManaged(query: ManagedQuery): { observation: HostObservation; session: ManagedSessionObservation } | undefined;
	/** Drop every observation, for example when tree navigation abandons the branch that produced them. */
	reset(): void;
	size(): number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const bounded = (value: unknown, fallback = ""): string => (typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, OBSERVATION_LIMITS.maxScalar) : fallback);

function summarizeSession(value: unknown): ManagedSessionObservation | undefined {
	if (!isRecord(value)) return undefined;
	const handle = bounded(value.handle);
	const episode = typeof value.episode === "number" && Number.isSafeInteger(value.episode) ? value.episode : undefined;
	if (handle.length === 0 || episode === undefined) return undefined;
	const candidate = isRecord(value.candidate)
		? {
			id: bounded(value.candidate.id),
			status: bounded(value.candidate.status, "unknown"),
			changedPaths: Array.isArray(value.candidate.changedPaths) ? value.candidate.changedPaths.length : 0,
			appliedPaths: Array.isArray(value.candidate.appliedPaths) ? value.candidate.appliedPaths.length : 0,
		}
		: undefined;
	return {
		handle,
		episode,
		role: bounded(value.role, "unknown"),
		state: bounded(value.state, "unknown"),
		reportComplete: value.reportComplete === true,
		...(candidate === undefined ? {} : { candidate }),
	};
}

/** Defensive parse of a public managed result envelope; unknown shapes are not observed. */
export function summarizeManagedResult(details: unknown): ManagedResultObservation | undefined {
	if (!isRecord(details)) return undefined;
	const status = bounded(details.status);
	if (status.length === 0) return undefined;
	const action = typeof details.action === "string" ? bounded(details.action) : null;
	const sessions = Array.isArray(details.sessions)
		? details.sessions.slice(0, OBSERVATION_LIMITS.maxSessions).map(summarizeSession).filter((session): session is ManagedSessionObservation => session !== undefined)
		: [];
	return { action, status, sessions };
}

export function summarizeHostObservation(event: { toolCallId: string; toolName: string; isError: boolean; result?: unknown; sessionId?: string; at?: string }): HostObservation {
	const details = isRecord(event.result) ? event.result.details : undefined;
	const observation: HostObservation = {
		toolCallId: bounded(event.toolCallId),
		toolName: bounded(event.toolName),
		at: event.at ?? new Date().toISOString(),
		sessionId: bounded(event.sessionId),
		isError: event.isError,
	};
	if (isRecord(details) && typeof details.exitCode === "number") observation.exitCode = details.exitCode;
	if (event.toolName === MANAGED_SESSION_TOOL_NAME) {
		const managed = summarizeManagedResult(details);
		if (managed) observation.managed = managed;
	}
	return observation;
}

export function createObservationIndex(): ObservationIndex {
	const observations = new Map<string, HostObservation>();
	return {
		record(observation) {
			observations.set(observation.toolCallId, observation);
			while (observations.size > OBSERVATION_LIMITS.maxEntries) {
				const oldest = observations.keys().next().value;
				if (oldest === undefined) break;
				observations.delete(oldest);
			}
		},
		get: (toolCallId) => observations.get(toolCallId),
		reset: () => observations.clear(),
		findManaged(query) {
			const entries = [...observations.values()].reverse();
			for (const observation of entries) {
				if (!observation.managed) continue;
				if (query.action !== undefined && observation.managed.action !== query.action) continue;
				for (const session of observation.managed.sessions) {
					if (session.handle !== query.handle || session.episode !== query.episode) continue;
					if (query.candidateId !== undefined && session.candidate?.id !== query.candidateId) continue;
					return { observation, session };
				}
			}
			return undefined;
		},
		size: () => observations.size,
	};
}

export function registerObservationHooks(pi: ExtensionAPI, index: ObservationIndex): void {
	pi.on("tool_execution_end", (event, ctx) => {
		index.record(summarizeHostObservation({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			result: event.result,
			sessionId: ctx.sessionManager.getSessionId(),
		}));
	});
}
