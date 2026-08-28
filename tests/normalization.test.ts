import assert from "node:assert/strict";
import test from "node:test";

import { admitNormalization } from "../extensions/workflow-harness/normalization.ts";

const graph = {
	schemaVersion: 1,
	graphId: "g-1",
	requestId: "r-1",
	approved: true,
	rootFormalRole: "planning",
	terminalTaskIds: ["T1"],
	tasks: [{ taskId: "T1", description: "do it", dependsOn: [], readPaths: [], writePaths: ["src/a.ts"], resourceLocks: ["source"], isolation: "controller-checkout", verification: ["test"], doneWhen: ["passes"], review: { required: false, reasons: [] }, attemptLimit: 1, recovery: "fix-forward" }],
};

test("admits only typed graphs bound to a semantically complete frozen proposal", () => {
	const submission = { schemaVersion: 1 as const, proposalSha256: "proposal", graph, semanticCheck: { omittedWork: [], inventedWork: [], unauthorizedReordering: [] } };
	assert.equal(admitNormalization(submission, "proposal").graphId, "g-1");
	assert.throws(() => admitNormalization({ ...submission, proposalSha256: "other" }, "proposal"), /not bound/);
	assert.throws(() => admitNormalization({ ...submission, semanticCheck: { ...submission.semanticCheck, omittedWork: ["missing"] } }, "proposal"), /did not pass/);
});
