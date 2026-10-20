import { inShellScope, type ShellExecutionEvent, type ShellScope } from "./execution.ts";

const TERMINAL = new Set(["exited", "cancelled", "deadline", "interrupted"]);
/** Consumed wake copies only. This is not the Jobs list. */
const MAX_OBSOLETE_SHELL_FACTS = 8;

function textOf(facts: ShellFact[]): string | undefined {
	if (facts.length === 0) return undefined;
	return facts.map((fact) => `Shell execution ${fact.executionId} finished with status ${fact.status}, exit_code ${fact.exitCode === null ? "unknown" : String(fact.exitCode)}. This is the same execution, not a second tool result.\n${fact.outputTail}`.trim()).join("\n");
}

export interface ShellFact {
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
export function createShellDelivery() {
	const facts = new Map<string, ShellFact>();
	const trimObsolete = (): void => {
		const obsolete = [...facts.values()].filter(fact => fact.consumed || fact.suppressed);
		// Durable inspect belongs to the execution owner; delivered/suppressed
		// notification metadata must not retain another copy of terminal output.
		for (const fact of obsolete) fact.outputTail = "";
		for (const fact of obsolete.slice(0, Math.max(0, obsolete.length - MAX_OBSOLETE_SHELL_FACTS))) facts.delete(fact.executionId);
	};

	const scoped = (fact: ShellFact, scope: ShellScope): boolean => inShellScope(fact, scope);

	const deliverable = (fact: ShellFact, scope: ShellScope): boolean => !fact.consumed && !fact.returning && !fact.suppressed && scoped(fact, scope) && TERMINAL.has(fact.status);

	const remember = (event: ShellExecutionEvent, returning: boolean): void => {
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
		noteReady(event: ShellExecutionEvent): void { remember(event, false); },
		noteReturning(event: ShellExecutionEvent): void { remember(event, true); },
		notePull(executionId: string): void {
			const fact = facts.get(executionId);
			if (fact) fact.consumed = true;
			trimObsolete();
		},
		fence(): void {
			for (const fact of facts.values()) if (!fact.consumed) fact.suppressed = true;
			trimObsolete();
		},
		hasDeliverable(scope: ShellScope): boolean {
			return [...facts.values()].some((fact) => deliverable(fact, scope));
		},
		preview(scope: ShellScope): string | undefined {
			return textOf([...facts.values()].filter((fact) => deliverable(fact, scope)));
		},
		project(scope: ShellScope): string | undefined {
			const ready = [...facts.values()].filter((fact) => deliverable(fact, scope));
			const text = textOf(ready);
			if (!text) return undefined;
			for (const fact of ready) fact.consumed = true;
			trimObsolete();
			return text;
		},
		/** In-scope terminals not yet projected or observed. Survives owner output eviction. */
		pending(scope: ShellScope): ShellFact[] {
			return [...facts.values()].filter((fact) => deliverable(fact, scope)).map((fact) => ({ ...fact }));
		},
		acknowledge(executionIds: readonly string[]): void {
			for (const executionId of executionIds) {
				const fact = facts.get(executionId);
				if (fact) fact.consumed = true;
			}
			trimObsolete();
		},
		inspectable(executionId: string): ShellFact | undefined {
			return facts.get(executionId);
		},
	};
}
