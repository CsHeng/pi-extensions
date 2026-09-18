import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAlignmentRuntime, rearmAlignment, registerAlignmentHooks } from "./alignment.ts";
import { reconcileBranch } from "./branch.ts";
import { createObservationIndex, registerObservationHooks } from "./observation.ts";
import { registerReviewPolicy } from "./review.ts";
import { registerSettlementBarrier } from "./settlement.ts";
import { createWorkflowStore } from "./store.ts";
import { registerWorkflowTool } from "./tool.ts";
import { registerWorkflowUi } from "./ui.ts";

/**
 * Task-level workflow extension (WF-02 core).
 *
 * Owns one branch-local workset: criteria, tasks, attempts, evidence bindings, revisions and
 * the truthful completion predicate. The main agent owns meaning and acceptance; managed
 * execution stays with `csheng_subagent_sessions`. Alignment and settlement reconciliation are
 * added by WF-04 on top of the same reducer/store.
 */
export default function workflowExtension(pi: ExtensionAPI): void {
	const store = createWorkflowStore({ append: (customType, data) => pi.appendEntry(customType, data) });
	const ui = registerWorkflowUi(pi, store);
	const observations = createObservationIndex();
	registerObservationHooks(pi, observations);
	const alignmentRuntime = createAlignmentRuntime();
	pi.on("session_start", (event, ctx) => {
		ui.detach();
		store.replay(ctx.sessionManager.getBranch());
		observations.reset();
		// Replay is history, not a newly prepared user input or a fresh review allowance.
		alignmentRuntime.tracker.reset();
		alignmentRuntime.unrecordedInput = false;
		alignmentRuntime.deliveryUnavailable = true;
		reconcileBranch(store, { reason: event.reason === "fork" ? "fork" : "session restart", align: event.reason === "fork", now: new Date().toISOString() });
		rearmAlignment(alignmentRuntime, store.current());
		ui.attach(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		ui.detach();
		// Tree navigation abandons the branch that produced the observations.
		observations.reset();
		store.replay(ctx.sessionManager.getBranch());
		alignmentRuntime.tracker.reset();
		alignmentRuntime.unrecordedInput = false;
		alignmentRuntime.deliveryUnavailable = true;
		reconcileBranch(store, { reason: "tree navigation", align: true, now: new Date().toISOString() });
		rearmAlignment(alignmentRuntime, store.current());
		ui.attach(ctx);
	});
	registerWorkflowTool(pi, store, observations, () => alignmentRuntime.deliveryUnavailable, () => alignmentRuntime.unrecordedInput);
	registerReviewPolicy(pi, store, { pendingHumanInput: () => alignmentRuntime.unrecordedInput, barrier: registerSettlementBarrier(pi) });
	registerAlignmentHooks(pi, store, { runtime: alignmentRuntime });
}
