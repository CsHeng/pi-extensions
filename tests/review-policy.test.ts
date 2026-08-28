import assert from "node:assert/strict";
import test from "node:test";

import { consumeReviewBatch, nextReviewBatch, recordFormalReview, recordStandaloneReview, recordWorkerRequestedReview } from "../extensions/workflow-harness/review-policy.ts";

test("formal and same-target worker review reasons coalesce into one dispatch", () => {
	let reasons = recordFormalReview([], "stage-1", "target", "acceptance");
	reasons = recordWorkerRequestedReview(reasons, "stage-1", "target", "acceptance");
	reasons = recordFormalReview(reasons, "stage-1", "target", "acceptance");
	const batch = nextReviewBatch(reasons);
	assert.equal(batch?.reasonIds.length, 2);
	assert.equal(nextReviewBatch(consumeReviewBatch(reasons, batch!)), undefined);
});

test("non-formal work has no automatic reason and standalone review has no stage", () => {
	assert.equal(nextReviewBatch([]), undefined);
	const reasons = recordStandaloneReview([], "target", "manual");
	assert.equal(reasons[0]?.stageInstanceId, null);
	assert.equal(nextReviewBatch(reasons)?.reasonIds.length, 1);
});

test("different frozen targets remain distinct bounded batches", () => {
	let reasons = recordFormalReview([], "stage-1", "target-a", "acceptance");
	reasons = recordWorkerRequestedReview(reasons, "stage-1", "target-b", "acceptance");
	const first = nextReviewBatch(reasons)!;
	const second = nextReviewBatch(consumeReviewBatch(reasons, first))!;
	assert.notEqual(first.targetSha256, second.targetSha256);
});
