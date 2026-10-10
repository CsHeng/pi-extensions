import assert from "node:assert/strict";
import test from "node:test";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";

test("access grants accept absolute paths and reject relative paths", () => {
	const absoluteWrite = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "edit", access: [{ permission: "write", scope: "/tmp/write" }] }] });
	assert.equal(absoluteWrite.ok, true);
	const relative = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "edit", access: [{ permission: "write", scope: "src" }] }] });
	assert.equal(relative.ok, false);
});
