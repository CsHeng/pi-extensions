import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LOOP_DELIVERY_CHANGED, LOOP_DELIVERY_REQUEST, LOOP_FACTS_EVENT, LOOP_SNAPSHOT_REQUEST, parseLoopFacts,
	type LoopDeliveryRequest, type LoopDeliverySnapshot, type LoopExecutionReference, type LoopFacts, type LoopSnapshotRequest,
} from "./loop-facts.ts";

export interface ExecutionScope {
	/** Native tool calls started in this external interaction, including its automatic result runs. */
	toolCallIds: ReadonlySet<string>;
	/** Explicit control/query receipts may adopt already-running work without parsing opaque IDs. */
	executionKeys?: ReadonlySet<string>;
	runIds?: ReadonlySet<string>;
	/** Executions already present before the interaction; never infer that they are its work. */
	excludedExecutions?: ReadonlySet<string>;
}
export interface QuiescenceExecution extends LoopExecutionReference { key: string; phase: string }
export interface ExecutionQuiescence {
	state: "busy" | "quiescent" | "unavailable";
	mainIdle: boolean;
	hasPendingMessages: boolean;
	activeExecutions: number;
	pendingDeliveries: number;
	scheduledDeliveries: number;
	executions: QuiescenceExecution[];
	reason?: string;
}
export function executionKey(producer: string, id: string): string { return `${producer}:${id}`; }

/** One passive boundary for measurement and any future no-new-result continuation policy.
 * Quiescence is necessary, never permission or a business/task-completion judgment.
 * Existing terminal-result delivery must NOT wait for all sibling executions to finish.
 */
export function evaluateExecutionQuiescence(input: {
	mainIdle: boolean;
	hasPendingMessages: boolean;
	aborted?: boolean;
	facts: readonly LoopFacts[];
	delivery?: LoopDeliverySnapshot;
	scope?: ExecutionScope;
}): ExecutionQuiescence {
	const executions: QuiescenceExecution[] = [];
	let unknown = false;
	let activeExecutions = 0;
	const selected = (item: LoopExecutionReference): boolean => {
		if (!input.scope) return true;
		if (input.scope.executionKeys?.has(executionKey(item.producer, item.id)) || (item.runId && input.scope.runIds?.has(item.runId))) return true;
		if (input.scope.excludedExecutions?.has(executionKey(item.producer, item.id))) return false;
		if (item.toolCallId) return input.scope.toolCallIds.has(item.toolCallId);
		unknown = true;
		return false;
	};
	for (const facts of input.facts) {
		if (facts.producer === "workflow") continue; // Passive task data never prolongs or triggers work.
		if (facts.availability === "unknown" || facts.availability === "unavailable") { unknown = true; continue; }
		if (facts.availability === "inactive") continue;
		for (const item of facts.executions) {
			const ref = { producer: facts.producer, id: item.id, ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}), ...(item.runId ? { runId: item.runId } : {}) };
			executions.push({ ...ref, key: executionKey(ref.producer, ref.id), phase: item.phase });
			if (item.phase !== "terminal" && selected(ref)) activeExecutions++;
		}
	}
	const pendingDeliveries = input.delivery?.pending.filter(selected).length ?? 0;
	const scheduledDeliveries = input.delivery?.scheduled.filter(selected).length ?? 0;
	const blocked = input.delivery?.blocked === true && (!input.scope || pendingDeliveries > 0 || scheduledDeliveries > 0);
	const busy = !input.mainIdle || input.hasPendingMessages || activeExecutions > 0 || pendingDeliveries > 0 || scheduledDeliveries > 0;
	const reason = input.aborted ? "interrupted" : blocked ? "delivery-blocked" : unknown ? "execution-state-unavailable" : undefined;
	return {
		state: reason ? "unavailable" : busy ? "busy" : "quiescent",
		mainIdle: input.mainIdle, hasPendingMessages: input.hasPendingMessages,
		activeExecutions, pendingDeliveries, scheduledDeliveries, executions,
		...(reason ? { reason } : {}),
	};
}

/** Pull authoritative snapshots without adding a waiter, timer, prompt, or model turn. */
export function readExecutionQuiescence(pi: ExtensionAPI, ctx: ExtensionContext, scope?: ExecutionScope): ExecutionQuiescence {
	const facts: LoopFacts[] = [];
	let delivery: LoopDeliverySnapshot | undefined;
	let unavailable = false;
	const sessionId = ctx.sessionManager.getSessionId();
	const anchor = ctx.sessionManager.getLeafId();
	const branch = new Set(ctx.sessionManager.getBranch().map(entry => entry.id));
	const inScope = (value: { sessionId: string | null; branchAnchor: string | null }) => value.sessionId === sessionId
		&& (value.branchAnchor === null || value.branchAnchor === anchor || branch.has(value.branchAnchor));
	try {
		pi.events.emit(LOOP_SNAPSHOT_REQUEST, { version: 1, accept: (raw: LoopFacts) => {
			const parsed = parseLoopFacts(raw);
			if (parsed?.producer === "workflow") return;
			if (parsed && inScope(parsed)) facts.push(parsed);
			else unavailable = true;
		} } satisfies LoopSnapshotRequest);
		pi.events.emit(LOOP_DELIVERY_REQUEST, { version: 1, accept: (value: LoopDeliverySnapshot) => {
			if (value?.version === 1 && inScope(value) && Array.isArray(value.pending) && Array.isArray(value.scheduled)) delivery = value;
			else unavailable = true;
		} } satisfies LoopDeliveryRequest);
		if (unavailable) throw new Error("scope observation unavailable");
		return evaluateExecutionQuiescence({ mainIdle: ctx.isIdle(), hasPendingMessages: ctx.hasPendingMessages(), ...(ctx.signal ? { aborted: ctx.signal.aborted } : {}), facts, ...(delivery ? { delivery } : {}), ...(scope ? { scope } : {}) });
	} catch {
		return { state: "unavailable", mainIdle: false, hasPendingMessages: false, activeExecutions: 0, pendingDeliveries: 0, scheduledDeliveries: 0, executions: [], reason: "observation-unavailable" };
	}
}

/** Coalesce invalidations, then query current facts; do not finalize from a raw terminal event.
 * The query includes pending/reserved delivery even before a late notification handler runs.
 */
export function observeExecutionQuiescence(pi: ExtensionAPI, changed: () => void): () => void {
	let queued = false;
	let disposed = false;
	const invalidate = () => {
		if (queued || disposed) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (!disposed) { try { changed(); } catch { /* Passive observers must not affect execution or delivery. */ } }
		});
	};
	const stops = [pi.events.on(LOOP_FACTS_EVENT, invalidate), pi.events.on(LOOP_DELIVERY_CHANGED, invalidate)];
	return () => { disposed = true; for (const stop of stops) stop(); };
}
