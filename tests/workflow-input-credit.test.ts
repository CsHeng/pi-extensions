import assert from "node:assert/strict";
import test from "node:test";
import { applyOperation, recordReviewDecision } from "../extensions/workflow/reducer.ts";
import { createWorkflowStore } from "../extensions/workflow/store.ts";
import { createObservationIndex } from "../extensions/workflow/observation.ts";
import { prepareOperation } from "../extensions/workflow/tool.ts";
import type { WorkflowOperation, WorksetState } from "../extensions/workflow/contracts.ts";
const clock = { now: "2026-09-17T00:00:00.000Z", cwd: "/repo", sessionId: "test" };
const open: WorkflowOperation = { operation: "open", expectedRevision: 0, goal: "Existing authorized work", deliveryEndpoint: "source", criteria: [{ key: "c", outcome: "criterion", verification: "check" }], tasks: [{ key: "t", outcome: "task", covers: ["c"] }] };
function reduce(state: WorksetState | undefined, operation: WorkflowOperation): WorksetState {
	const result = applyOperation(state, operation, clock);
	if (!result.ok) throw new Error(result.message);
	return result.state;
}

test("unknown model input permits alignment of existing authority without renewing credit", () => {
	let state = reduce(undefined, open);
	state = reduce(state, { operation: "review", expectedRevision: state.revision, action: "dispatched", fingerprint: "spent" });
	const original = structuredClone(state.workset);
	state = reduce(state, { operation: "delivered", expectedRevision: state.revision, provenance: "unavailable" });
	assert.equal(state.workset.inputGeneration, 1);
	assert.equal(state.workset.review.used, 1);
	assert.equal(state.workset.review.lastFingerprint, "spent");
	assert.equal(applyOperation(state, { operation: "align", expectedRevision: state.revision, inputGeneration: 0, action: "confirm" }, clock).ok, false);
	state = reduce(state, { operation: "align", expectedRevision: state.revision, inputGeneration: 1, action: "confirm" });
	for (const key of ["goal", "goalRevision", "deliveryEndpoint", "authorityReferences", "sourceReferences"] as const) assert.deepEqual(state.workset[key], original[key]);
	assert.equal(applyOperation(state, { operation: "review", expectedRevision: state.revision, action: "dispatched", fingerprint: "other" }, clock).ok, false);
	state = reduce(state, { operation: "delivered", expectedRevision: state.revision });
	assert.equal(state.workset.review.used, 0);
	assert.equal(state.workset.review.lastFingerprint, undefined);
});

test("branch recovery and mismatched bookkeeping generations never replenish credit", () => {
	let state = reduce(undefined, open);
	state = reduce(state, { operation: "review", expectedRevision: state.revision, action: "dispatched", fingerprint: "spent" });
	state = reduce(state, { operation: "branch_reset", expectedRevision: state.revision, reason: "tree", align: true });
	assert.equal(state.workset.review.used, 1);
	assert.equal(state.workset.review.lastFingerprint, "spent");
	state.workset.review.inputGeneration = 0;
	assert.equal(applyOperation(state, { operation: "review", expectedRevision: state.revision, action: "dispatched", fingerprint: "different" }, clock).ok, false);
	const result = recordReviewDecision(state, "blocked", "same", "paused", clock.now);
	assert.equal(result.state.workset.review.used, 1);
});

test("unknown enrollment starts without review credit; tool parameters cannot forge host provenance", async () => {
	const store = createWorkflowStore({ append() {} });
	const deps = { store, observations: createObservationIndex(), ...clock };
	const prepared = await prepareOperation({ ...open, deliveryUnavailable: true }, deps);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	assert.equal((prepared.operation as typeof open).deliveryUnavailable, undefined);
	const unknown = await prepareOperation(open, { ...deps, deliveryUnavailable: true });
	assert.equal(unknown.ok, true);
	if (!unknown.ok) return;
	let state = reduce(undefined, unknown.operation);
	assert.equal(state.workset.review.used, state.workset.reviewPolicy.maxAutomaticReviewsPerInputEpoch);
	state = reduce(state, { operation: "align", expectedRevision: state.revision, inputGeneration: 0, action: "confirm" });
	assert.equal(state.workset.alignment.state, "aligned");
	assert.equal(state.workset.review.used, 1);
	const fenced = await prepareOperation(open, { ...deps, unrecordedInput: true });
	assert.equal(fenced.ok, false);
});
