import assert from "node:assert/strict";
import test from "node:test";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";

test("graph write hints are optional but remain safe and repository-relative", () => {
	const absoluteWrite = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "edit", scope: ["."], writePaths: ["/tmp/file.ts"] }] });
	assert.equal(absoluteWrite.ok, false);
	if (absoluteWrite.ok) return;
	assert.equal(absoluteWrite.error.code, "invalid_write_path");
	assert.match(absoluteWrite.error.message, /unsafe write path/);
	const missingWrites = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "edit", scope: ["."] }] });
	assert.equal(missingWrites.ok, true);
	if (missingWrites.ok) assert.deepEqual(missingWrites.tasks[0]!.writePaths, []);
});
