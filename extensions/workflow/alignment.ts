/** Model-preparation alignment. Receipts and native events alone never mutate the ledger.
 * New native user occurrences participate only in context; unknown origin asks the main agent
 * to align existing authority without granting permission or refilling automatic-review credit.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_LIMITS, type WorksetState } from "./contracts.ts";
import { createPreparedInputTracker, type PreparedInputTracker } from "../shared/prepared-input.ts";
import { isUserInputSource } from "./host-adapter.ts";
import type { WorkflowStore } from "./store.ts";

export const ALIGNMENT_CONTEXT_TYPE = "csheng-workflow-alignment";

export interface AlignmentRuntime {
	/** Last effective input origin, NOT a receipt/queue flag or a prohibition on alignment. */
	deliveryUnavailable: boolean;
	/** A failed observation commit blocks sensitive tools until context preparation succeeds. */
	unrecordedInput: boolean;
	tracker: PreparedInputTracker;
	/** Current reminder projection: which generation was projected and whether a message exists. */
	projection: { generation: number | null; projected: boolean };
}

export interface AlignmentHooksDeps {
	/** Shared runtime that also fences review while a prepared-input observation is uncommitted. */
	runtime: AlignmentRuntime;
	/** Called on every real input receipt. */
	onRealInput?: () => void;
}

export function createAlignmentRuntime(): AlignmentRuntime {
	return { deliveryUnavailable: true, unrecordedInput: false, tracker: createPreparedInputTracker(), projection: { generation: null, projected: false } };
}

/** Rearm the pending reminder from durable state after a recovery boundary or lost projection. */
export function rearmAlignment(runtime: AlignmentRuntime, state: WorksetState | undefined): void {
	if (!state || state.workset.disposition === "closed" || state.workset.alignment.state === "aligned") {
		runtime.projection = { generation: null, projected: false };
		return;
	}
	runtime.projection = { generation: state.workset.inputGeneration, projected: false };
}

export function alignmentReminder(state: WorksetState): string {
	const workset = state.workset;
	const deficits = `${workset.goal}`.slice(0, 300);
	return [
		`Workflow alignment required for workset ${workset.id} (goal revision ${workset.goalRevision}, delivered input generation ${workset.inputGeneration}).`,
		`Current goal: ${deficits}`,
		...(workset.alignment.deliveryUnavailable ? ["This native input's source is unconfirmed. Reconcile the actual model context against existing authority; alignment is not new permission, and does not replenish automatic-review credit."] : []),
		`Before starting tasks, accepting results, or completing the workset, call csheng_workflow with operation "align" (action confirm, acknowledge, pause, or cancel), or pass alignInputGeneration in the next amend. Inspect first when the current state is unclear.`,
	].join("\n");
}

export function registerAlignmentHooks(pi: ExtensionAPI, store: WorkflowStore, deps: AlignmentHooksDeps): AlignmentRuntime {
	const runtime = deps.runtime;
	let projectionKey = "";
	pi.on("input", (event) => {
		runtime.tracker.received(event);
		if (isUserInputSource(event.source)) deps.onRealInput?.();
		// In particular, do not remove the current reminder for a queued/dropped receipt.
	});
	pi.on("before_agent_start", () => { runtime.tracker.prepare(); });
	pi.on("message_start", (event) => { runtime.tracker.observe(event.message); });

	pi.on("context", (event) => {
		// Only provider preparation can commit a new input. Consuming is transactional with the
		// durable snapshot: a failed append keeps the occurrence pending and tools fenced.
		runtime.unrecordedInput = true;
		for (const input of runtime.tracker.peek(event.messages)) {
			if (input.provenance !== "extension") {
				const state = store.current();
				if (state && state.workset.disposition !== "closed") {
					const result = store.apply({ operation: "delivered", expectedRevision: state.revision, ...(input.provenance === "unknown" ? { provenance: "unavailable" as const } : {}) }, { now: new Date().toISOString(), cwd: "", sessionId: "" }, `model-input-${input.id}-${state.revision}`);
					if (!result.ok) throw new Error(result.message);
					runtime.projection = { generation: result.state.workset.inputGeneration, projected: false };
				}
				runtime.deliveryUnavailable = input.provenance === "unknown";
			}
			runtime.tracker.commit([input.id]);
		}
		runtime.unrecordedInput = false;
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === ALIGNMENT_CONTEXT_TYPE));
		const state = store.current();
		if (!state || state.workset.disposition === "closed") return { messages };
		if (state.workset.alignment.state === "aligned") return { messages };
		const generation = state.workset.inputGeneration;
		const key = `${state.workset.id}:${state.workset.goalRevision}:${generation}:${state.workset.alignment.deliveryUnavailable ?? false}`;
		if (runtime.projection.generation !== generation || projectionKey !== key) {
			runtime.projection = { generation, projected: false };
			projectionKey = key;
		}
		const content = alignmentReminder(state).slice(0, WORKFLOW_LIMITS.maxGoal);
		const existing = event.messages.findIndex((message) => message.role === "custom" && message.customType === ALIGNMENT_CONTEXT_TYPE && message.content === content);
		if (existing >= 0) {
			runtime.projection.projected = true;
			// Retain the one current marker in its original position, never move it past tool results.
			return { messages: event.messages.filter((message, index) => index === existing || !(message.role === "custom" && message.customType === ALIGNMENT_CONTEXT_TYPE)) };
		}
		if (runtime.projection.projected) return { messages };
		runtime.projection.projected = true;
		// A streaming projection is ephemeral. Attach once immediately after the delivered input,
		// not after the latest tool result and not between an assistant call and its results.
		const position = messages.findLastIndex((message) => message.role === "user") + 1;
		messages.splice(position, 0, {
			role: "custom", customType: ALIGNMENT_CONTEXT_TYPE, content, display: false, timestamp: Date.now(),
		});
		return { messages };
	});

	pi.on("session_compact", () => {
		rearmAlignment(runtime, store.current());
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "error") {
			// A request that failed before delivery must not consume the one-shot projection.
			runtime.projection.projected = false;
		}
	});

	pi.on("agent_settled", () => {
		// Undelivered receipts cannot become a durable review veto. Pi owns its pending queues.
		if (!runtime.unrecordedInput) runtime.tracker.reset();
	});

	pi.on("session_shutdown", () => {
		runtime.tracker.reset();
		runtime.unrecordedInput = false;
		runtime.projection = { generation: null, projected: false };
	});

	return runtime;
}
