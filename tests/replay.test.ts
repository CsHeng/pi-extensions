import assert from "node:assert/strict";
import test from "node:test";

import { completePendingChild, replaySessionState, schedulePendingChild, sessionEntry } from "../extensions/workflow-harness/replay.ts";
import { newSessionState } from "../extensions/workflow-harness/session-state.ts";

test("child scheduling is replay-idempotent and stale results cannot advance state", () => {
	const initial = newSessionState("request-1", "/work");
	const pending = { dispatchId: "dispatch-1", intent: "review" as const, expectedTool: "submit_review_result", status: "scheduled" as const, command: null, brief: "bounded review", taskId: null, attemptId: null };
	const scheduled = schedulePendingChild(initial, pending);
	const repeated = schedulePendingChild(scheduled, pending);
	assert.deepEqual(repeated, scheduled);
	assert.throws(() => schedulePendingChild(scheduled, { ...pending, dispatchId: "dispatch-2" }), /another child/);
	const replayed = replaySessionState([sessionEntry(scheduled)]);
	assert.deepEqual(replayed?.pendingChild, pending);
	assert.throws(() => completePendingChild(scheduled, "stale"), /stale/);
	assert.equal(completePendingChild(scheduled, "dispatch-1").pendingChild, null);
});
