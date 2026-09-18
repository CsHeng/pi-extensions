import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAlignmentRuntime, rearmAlignment, registerAlignmentHooks } from "../../../extensions/workflow/alignment.ts";
import { reconcileBranch } from "../../../extensions/workflow/branch.ts";
import { createObservationIndex, registerObservationHooks } from "../../../extensions/workflow/observation.ts";
import { registerReviewPolicy } from "../../../extensions/workflow/review.ts";
import { registerSettlementBarrier } from "../../../extensions/workflow/settlement.ts";
import { createWorkflowStore } from "../../../extensions/workflow/store.ts";
import { registerWorkflowTool } from "../../../extensions/workflow/tool.ts";
import { registerWorkflowUi } from "../../../extensions/workflow/ui.ts";

/**
 * Frozen v1 host fixture. Never registered by the package's v2 entry point.
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
