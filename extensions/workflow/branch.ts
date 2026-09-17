/**
 * Branch and restart reconciliation (WF-02 lifecycle).
 *
 * Pi replays the active branch. Copied state may claim attempts that no live process owns, and
 * fork/tree navigation carries historical intent that the main agent must re-align explicitly
 * before any new mutation or continuation. Reconciliation is one ordinary persisted transition.
 */
import { randomUUID } from "node:crypto";
import type { ReduceResult } from "./contracts.ts";
import type { WorkflowStore } from "./store.ts";

export interface BranchReconcileOptions {
	reason: string;
	/** Fork/tree navigation requires explicit alignment before new mutations. */
	align: boolean;
	now: string;
}

export function reconcileBranch(store: WorkflowStore, options: BranchReconcileOptions): ReduceResult | undefined {
	const state = store.current();
	if (!state || store.recovery() !== undefined) return undefined;
	const running = Object.values(state.attempts).some((attempt) => attempt.worksetId === state.workset.id && attempt.state === "running");
	const align = options.align && state.workset.alignment.state !== "needs_alignment";
	if (!running && !align) return undefined;
	return store.apply(
		{ operation: "branch_reset", expectedRevision: state.revision, reason: options.reason, align },
		{ now: options.now, cwd: state.workset.repository.cwd, sessionId: state.workset.repository.sessionId },
		`branch-${randomUUID()}`,
	);
}
