import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { freezeProposal } from "../extensions/workflow-harness/proposal.ts";

test("freezes bounded messages and exact regular artifacts by digest", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-proposal-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "plan.md"), "one\n", "utf8");
	const first = await freezeProposal(root, [{ role: "user", text: "do the work" }], ["plan.md"]);
	const second = await freezeProposal(root, [{ role: "user", text: "do the work" }], ["plan.md"]);
	assert.equal(first.sha256, second.sha256);
	assert.equal(first.artifacts[0]?.size, 4);
	await writeFile(join(root, "plan.md"), "two\n", "utf8");
	const changed = await freezeProposal(root, [{ role: "user", text: "do the work" }], ["plan.md"]);
	assert.notEqual(changed.sha256, first.sha256);
	await assert.rejects(() => freezeProposal(root, [{ role: "user", text: "x" }], ["../escape"]), /escapes workspace|unsafe artifact/);
});
