import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	inventoryProblems,
	inventoryProblemsForDiscovered,
	LANE_GROUPS,
	sourceInventory,
	validateLaneGroups,
} from "../scripts/test-lane-inventory.ts";

const testsDirectory = join(fileURLToPath(new URL(".", import.meta.url)));

test("every discovered source test has exactly one lane assignment", () => {
	assert.deepEqual(inventoryProblems(testsDirectory), []);
	assert.ok(sourceInventory().length > 0);
});

test("duplicate membership across lane groups is rejected", () => {
	const broken = {
		...LANE_GROUPS,
		fast: [...LANE_GROUPS.fast, "package.test.ts"] as readonly string[],
	};
	const problems = validateLaneGroups(broken);
	assert.equal(problems.length, 1);
	assert.match(problems[0]!, /duplicate assignment: package\.test\.ts \(.*\)/);
});

test("unassigned discovered file is reported", () => {
	const discovered = [...sourceInventory(), "orphan-fixture.test.ts"];
	assert.deepEqual(inventoryProblemsForDiscovered(discovered), ["unassigned: orphan-fixture.test.ts"]);
});
