/** Neutral notification facts. Producers and the consumer share this contract; neither imports the other's implementation. */

export const LOOP_FACTS_EVENT = "csheng.loop-notifications.facts.v1";
export const LOOP_SNAPSHOT_REQUEST = "csheng.loop-notifications.snapshot.v1";
export const LOOP_NOTICE_TYPE = "csheng.loop-notifications.notice";
/** Sent only after a notice is projected into a model request, never when a send is queued. */
export const LOOP_NOTICE_ACK = "csheng.loop-notifications.ack.v1";

export type LoopProducer = "workflow" | "retained-shell" | "subagents";
export type LoopAvailability = "ready" | "inactive" | "unavailable" | "unknown";
export type LoopPhase = "queued" | "preparing" | "running" | "terminal";
export type LoopDisposition = "pending" | "returning" | "observed";

export interface LoopExecution {
	id: string;
	/** Host call that enrolled this execution; attribution only, never an authority token. */
	toolCallId?: string;
	/** Native Agent run grouping, when this producer has one. */
	runId?: string;
	phase: LoopPhase;
	status: string;
	exitCode: number | null;
	/** Bounded delivery text. Empty unless this terminal is eligible to notify. */
	summary: string;
	/** Source-owned observation. The consumer must not notify returning or observed terminals. */
	disposition: LoopDisposition;
}

export interface LoopTaskSnapshot {
	revision: number;
	goal: string;
	paused: boolean;
	cancelled: boolean;
	tasks: Array<{ id: string; title: string; status: string }>;
}

export interface LoopFacts {
	version: 1;
	producer: LoopProducer;
	availability: LoopAvailability;
	sessionId: string | null;
	branchAnchor: string | null;
	generation: string;
	executions: LoopExecution[];
	tasks?: LoopTaskSnapshot;
}

export interface LoopSnapshotRequest {
	version: 1;
	accept: (facts: LoopFacts) => void;
}

/** Read-only result-delivery observation. Absence means no notification consumer is loaded. */
export const LOOP_DELIVERY_REQUEST = "csheng.job-notifications.delivery-state.request.v1";
export const LOOP_DELIVERY_CHANGED = "csheng.job-notifications.delivery-state.changed.v1";
export interface LoopExecutionReference { producer: "retained-shell" | "subagents"; id: string; toolCallId?: string; runId?: string }
export interface LoopDeliverySnapshot {
	version: 1;
	sessionId: string | null;
	branchAnchor: string | null;
	pending: LoopExecutionReference[];
	/** A completion wake reserved/queued but not yet projected into a provider request. */
	scheduled: LoopExecutionReference[];
	blocked: boolean;
}
export interface LoopDeliveryRequest { version: 1; accept: (state: LoopDeliverySnapshot) => void }

export interface LoopNoticeAck {
	version: 1;
	producer: LoopProducer;
	ids: string[];
}

export function emptyLoopFacts(producer: LoopProducer, availability: LoopAvailability, sessionId: string | null = null, branchAnchor: string | null = null): LoopFacts {
	return { version: 1, producer, availability, sessionId, branchAnchor, generation: availability, executions: [] };
}

export function parseLoopFacts(value: unknown): LoopFacts | undefined {
	if (!value || typeof value !== "object") return undefined;
	const facts = value as Partial<LoopFacts>;
	if (facts.version !== 1 || (facts.producer !== "workflow" && facts.producer !== "retained-shell" && facts.producer !== "subagents")) return undefined;
	if (facts.availability !== "ready" && facts.availability !== "inactive" && facts.availability !== "unavailable" && facts.availability !== "unknown") return undefined;
	if (!Array.isArray(facts.executions)) return undefined;
	return facts as LoopFacts;
}
