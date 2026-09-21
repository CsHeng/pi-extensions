/** Bounded host-observed execution summaries; never raw reports, prompts, or file bodies. */

/** Managed executor tool name; kept local so the workflow extension stays independently removable. */
export const MANAGED_SESSION_TOOL_NAME = "csheng_subagent_sessions";

export const OBSERVATION_LIMITS = Object.freeze({ maxSessions: 10, maxScalar: 128 });

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
