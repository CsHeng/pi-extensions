import assert from "node:assert/strict";
import test from "node:test";

import { mayActivateRoot } from "../extensions/workflow-harness/activation.ts";
import { buildChildDispatch, validateChildResult } from "../extensions/workflow-harness/child-dispatch.ts";

test("child dispatch separates native command, bounded brief, marker, and typed result", () => {
	const worker = { name: "inspect-result", description: "independent assessment", sourcePath: "/opaque/SKILL.md" };
	const dispatch = buildChildDispatch("run-1", "review", "review only target digest abc", "submit_review_result", worker);
	assert.equal(dispatch.command, "/skill:inspect-result");
	assert.equal(dispatch.command?.includes(dispatch.brief), false);
	assert.equal(mayActivateRoot("extension", dispatch.marker), false);
	assert.doesNotThrow(() => validateChildResult(dispatch, "submit_review_result", dispatch.dispatchId));
	assert.throws(() => validateChildResult(dispatch, "submit_task_graph", dispatch.dispatchId), /does not match/);
});

test("generic fallback uses the same typed child boundary without a Skill command", () => {
	const dispatch = buildChildDispatch("run-1", "review", "review target", "submit_review_result", null);
	assert.equal(dispatch.command, null);
	assert.equal(dispatch.marker.rootActivation, false);
});
