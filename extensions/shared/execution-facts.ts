/** Neutral execution facts. Producers and the consumer share this contract; neither imports the other's implementation. */

export const EXECUTION_FACTS_EVENT = "notices.facts.v1";
export const EXECUTION_FACTS_REQUEST = "notices.snapshot.v1";
export const NOTICE_TYPE = "notices.notice";
/** Sent only after an identified native notice participates in request preparation, never on enqueue or persistence alone. */
export const NOTICE_ACK = "notices.ack.v1";

export type ExecutionProducer = "tasklist" | "async-bash" | "agents";
export type ProducerAvailability = "ready" | "inactive" | "unavailable" | "unknown";
export type ExecutionFactPhase = "queued" | "preparing" | "running" | "terminal";
export type NoticeDisposition = "pending" | "returning" | "observed";

export interface ExecutionFact {
	id: string;
	/** Host call that enrolled this execution; attribution only, never an authority token. */
	toolCallId?: string;
	/** Native Agent run grouping, when this producer has one. */
	runId?: string;
	phase: ExecutionFactPhase;
	status: string;
	exitCode: number | null;
	/** Bounded delivery text. Empty unless this terminal is eligible to notify. */
	summary: string;
	/** Source-owned observation. The consumer must not notify returning or observed terminals. */
	disposition: NoticeDisposition;
	/**
	 * Attention notice for a non-terminal execution that reached a source-owned checkpoint while it
	 * keeps running. It is not a result: the model decides whether to renew, cancel or keep waiting.
	 */
	checkpoint?: ExecutionCheckpoint;
}

export interface ExecutionCheckpoint {
	/** Unique per execution; a later checkpoint gets a new id. */
	id: string;
	/** Bounded delivery text. Empty unless this checkpoint is eligible to notify. */
	summary: string;
	disposition: NoticeDisposition;
}

/** Delivery identity of a checkpoint notice; distinct from the execution's terminal notice. */
export function checkpointNoticeId(executionId: string, checkpointId: string): string {
	return `${executionId}@${checkpointId}`;
}

/** Execution id behind a notice id, for acknowledgments that may name a checkpoint notice. */
export function noticeExecutionId(noticeId: string): { executionId: string; checkpointId?: string } {
	const at = noticeId.indexOf("@");
	return at < 0 ? { executionId: noticeId } : { executionId: noticeId.slice(0, at), checkpointId: noticeId.slice(at + 1) };
}

export interface TaskFacts {
	revision: number;
	title: string;
	tasks: Array<{ id: string; title: string; status: string }>;
}

export interface ProducerFacts {
	version: 1;
	producer: ExecutionProducer;
	availability: ProducerAvailability;
	sessionId: string | null;
	branchAnchor: string | null;
	generation: string;
	executions: ExecutionFact[];
	tasks?: TaskFacts;
}

export interface ProducerFactsRequest {
	version: 1;
	accept: (facts: ProducerFacts) => void;
}

/** Read-only result-delivery observation. Absence means the notices consumer is not loaded. */
export const NOTICE_DELIVERY_REQUEST = "notices.delivery-state.request.v1";
export const NOTICE_DELIVERY_CHANGED = "notices.delivery-state.changed.v1";
export interface ExecutionRef { producer: "async-bash" | "agents"; id: string; toolCallId?: string; runId?: string }
export interface NoticeDeliverySnapshot {
	version: 1;
	sessionId: string | null;
	branchAnchor: string | null;
	pending: ExecutionRef[];
	/** A native completion handoff reserved/proposed but not yet resolved by request preparation or a lifecycle boundary. */
	scheduled: ExecutionRef[];
	blocked: boolean;
}
export interface NoticeDeliveryRequest { version: 1; accept: (state: NoticeDeliverySnapshot) => void }

export interface NoticeAck {
	version: 1;
	producer: ExecutionProducer;
	ids: string[];
}

export function emptyProducerFacts(producer: ExecutionProducer, availability: ProducerAvailability, sessionId: string | null = null, branchAnchor: string | null = null): ProducerFacts {
	return { version: 1, producer, availability, sessionId, branchAnchor, generation: availability, executions: [] };
}

export function parseProducerFacts(value: unknown): ProducerFacts | undefined {
	if (!value || typeof value !== "object") return undefined;
	const facts = value as Partial<ProducerFacts>;
	if (facts.version !== 1 || (facts.producer !== "tasklist" && facts.producer !== "async-bash" && facts.producer !== "agents")) return undefined;
	if (facts.availability !== "ready" && facts.availability !== "inactive" && facts.availability !== "unavailable" && facts.availability !== "unknown") return undefined;
	if (!Array.isArray(facts.executions)) return undefined;
	return facts as ProducerFacts;
}
