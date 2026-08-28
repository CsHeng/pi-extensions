import assert from "node:assert/strict";
import test from "node:test";

import { admitRootRole, childMarker, mayActivateRoot } from "../extensions/workflow-harness/activation.ts";

test("only authorized root context assigns a stable formal stage", () => {
	const first = admitRootRole("run-1", "root-skill-selection", "design", 0, "source-digest");
	const replay = admitRootRole("run-1", "root-skill-selection", "design", 0, "source-digest");
	assert.equal(first.stageInstanceId, replay.stageInstanceId);
	assert.notEqual(first.stageInstanceId, null);
	assert.equal(admitRootRole("run-1", "explicit-role", "none", 0, "source").stageInstanceId, null);
});

test("extension child markers cannot activate a root", () => {
	const marker = childMarker("run-1", "dispatch-1");
	assert.equal(mayActivateRoot("extension", marker), false);
	assert.equal(mayActivateRoot("interactive"), true);
});
