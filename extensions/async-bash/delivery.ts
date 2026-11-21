import { inBashScope, type BashExecutionEvent, type BashScope } from "./execution.ts";

const TERMINAL = new Set(["exited", "cancelled", "timeout", "interrupted"]);
const MAX_OBSOLETE_BASH_FACTS = 8;

export interface BashFact {
	executionId: string;
	toolCallId?: string;
	sessionId: string | null;
	branchAnchor: string | null;
	status: string;
	exitCode: number | null;
	outputTail: string;
	consumed: boolean;
	returning: boolean;
	suppressed: boolean;
}

/**
 * Queuing a wake is not consumption. A fact is consumed only when a model request
 * projects it or a tool result returns that terminal. A dropped queue stays inspectable.
 */
export function createBashDelivery() {
	const facts = new Map<string, BashFact>();
	const trimObsolete = (): void => {
		const obsolete = [...facts.values()].filter(fact => fact.consumed || fact.suppressed);
		// Durable inspect belongs to the execution owner; delivered/suppressed
		// notice metadata must not retain another copy of terminal output.
		for (const fact of obsolete) fact.outputTail = "";
		for (const fact of obsolete.slice(0, Math.max(0, obsolete.length - MAX_OBSOLETE_BASH_FACTS))) facts.delete(fact.executionId);
	};

	const scoped = (fact: BashFact, scope: BashScope): boolean => inBashScope(fact, scope);

	const deliverable = (fact: BashFact, scope: BashScope): boolean => !fact.consumed && !fact.returning && !fact.suppressed && scoped(fact, scope) && TERMINAL.has(fact.status);

	const remember = (event: BashExecutionEvent, returning: boolean): void => {
		if (!event.executionId || !TERMINAL.has(event.status)) return;
		const existing = facts.get(event.executionId);
		if (existing?.consumed) return;
		facts.set(event.executionId, {
			executionId: event.executionId,
			...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
			sessionId: event.sessionId,
			branchAnchor: event.branchAnchor,
			status: event.status,
			exitCode: event.exitCode,
			outputTail: event.outputTail,
			consumed: false,
			returning,
			suppressed: existing?.suppressed === true,
		});
		trimObsolete();
	};

	return {
		noteReady(event: BashExecutionEvent): void { remember(event, false); },
		noteReturning(event: BashExecutionEvent): void { remember(event, true); },
		notePull(executionId: string): void {
			const fact = facts.get(executionId);
			if (fact) fact.consumed = true;
			trimObsolete();
		},
		fence(): void {
			for (const fact of facts.values()) if (!fact.consumed) fact.suppressed = true;
			trimObsolete();
		},
		/** In-scope terminals not yet projected or observed. Survives owner output eviction. */
		pending(scope: BashScope): BashFact[] {
			return [...facts.values()].filter((fact) => deliverable(fact, scope)).map((fact) => ({ ...fact }));
		},
		acknowledge(executionIds: readonly string[]): void {
			for (const executionId of executionIds) {
				const fact = facts.get(executionId);
				if (fact) fact.consumed = true;
			}
			trimObsolete();
		},
		inspectable(executionId: string): BashFact | undefined {
			return facts.get(executionId);
		},
	};
}
