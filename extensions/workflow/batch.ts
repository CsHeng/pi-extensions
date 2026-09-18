import { randomUUID } from "node:crypto";
import { WORKFLOW_LIMITS, type BatchOperation, type BatchStep, type ReduceResult, type WorkflowOperation } from "./contracts.ts";
import type { ReduceContext } from "./reducer.ts";
import type { WorkflowStore } from "./store.ts";

type Prepared = { ok: true; operation: WorkflowOperation; notices: string[] } | { ok: false; code: Extract<ReduceResult, { ok: false }>["code"]; message: string };

/** Explicit parent-authored bookkeeping only. No checks, child execution or automatic acceptance. */
export async function executeBatch(
	operation: BatchOperation, store: WorkflowStore, context: ReduceContext, toolCallId: string,
	prepare: (operation: WorkflowOperation, draft: WorkflowStore) => Promise<Prepared>, signal?: AbortSignal, canCommit: () => boolean = () => true,
): Promise<ReduceResult> {
	if (!operation.steps.length || operation.steps.length > WORKFLOW_LIMITS.maxBatchSteps || Buffer.byteLength(JSON.stringify(operation)) > WORKFLOW_LIMITS.maxBatchBytes) {
		return { ok: false, code: "limit_exceeded", message: `Batch requires 1-${WORKFLOW_LIMITS.maxBatchSteps} steps within ${WORKFLOW_LIMITS.maxBatchBytes} bytes.` };
	}
	return store.transact(operation.expectedRevision, context, toolCallId, async (draft) => {
		const allocated: Record<string, string> = {};
		let last: ReduceResult | undefined;
		for (const [index, input] of operation.steps.entries()) {
			if (signal?.aborted) return { ok: false, code: "state_unavailable", message: "Batch cancelled." };
			const prefix = `step ${index}`;
			if (!["start", "record", "assess", "close"].includes(input.operation)) return { ok: false, code: "invalid_payload", message: `${prefix}: unsupported batch operation.` };
			if (input.operation === "close" && index !== operation.steps.length - 1) return { ok: false, code: "invalid_payload", message: `${prefix}: close must be the last step.` };
			const step: BatchStep = structuredClone(input);
			const resolve = (id: string): string => {
				if (!id.startsWith("$")) return id;
				if (!/^\$\d+\.(attempt|evidence)$/.test(id) || !Object.hasOwn(allocated, id)) throw new Error(`Unknown or forward reference ${id}; use a prior $N.attempt or $N.evidence allocation.`);
				return allocated[id]!;
			};
			try {
				if (step.operation === "record") {
					if (step.attemptId) step.attemptId = resolve(step.attemptId);
					if (step.evidence?.attemptId) step.evidence.attemptId = resolve(step.evidence.attemptId);
				} else if (step.operation === "assess") step.evidenceIds = step.evidenceIds.map(resolve);
				else if (step.operation === "close" && step.deliveryEvidenceIds) step.deliveryEvidenceIds = step.deliveryEvidenceIds.map(resolve);
			} catch (error) {
				return { ok: false, code: "invalid_payload", message: `${prefix}: ${(error as Error).message}` };
			}
			const before = draft.current()!;
			const prepared = await prepare({ ...step, expectedRevision: before.revision }, draft);
			if (!prepared.ok) return { ...prepared, message: `${prefix}: ${prepared.message}` };
			last = draft.apply(prepared.operation, context, `batch-step-${randomUUID()}`);
			if (!last.ok) return { ...last, message: `${prefix}: ${last.message}` };
			for (const [kind, collection] of [["attempt", "attempts"], ["evidence", "evidence"]] as const) {
				const id = Object.keys(last.state[collection]).find((id) => !Object.hasOwn(before[collection], id));
				if (id) allocated[`$${index}.${kind}`] = id;
			}
		}
		return { ...last as Extract<ReduceResult, { ok: true }>, mapping: allocated };
	}, signal, canCommit);
}
