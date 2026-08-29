import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
	HARD_LIMITS,
	ROLE_NAMES,
	SubagentToolSchema,
	truncateUtf8,
} from "../extensions/subagents/contracts.ts";
import { ROLES } from "../extensions/subagents/roles.ts";

test("subagent roles have fixed least-authority tool sets", () => {
	assert.deepEqual(ROLE_NAMES, ["explorer", "reviewer", "worker"]);
	assert.deepEqual(ROLES.explorer.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(ROLES.reviewer.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(ROLES.worker.tools, ["read", "grep", "find", "ls", "edit", "write"]);
	for (const role of Object.values(ROLES)) {
		assert.equal(role.tools.includes("bash"), false);
		assert.match(role.systemPrompt, /Do not delegate/);
	}
});

test("tool schema accepts one bounded task array and rejects arbitrary runtime fields", () => {
	const valid = {
		tasks: [{
			id: "scan",
			role: "explorer",
			objective: "Find evidence",
			scope: ["src"],
			executionProfile: "fast",
			reasoningProfile: "light",
		}],
	};
	assert.equal(Check(SubagentToolSchema, valid), true);
	assert.equal(Check(SubagentToolSchema, { ...valid, model: "some-model" }), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], cwd: "/tmp" }],
	}), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], executionProfile: "extreme" }],
	}), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], model: "provider/model" }],
	}), false);
	assert.equal(Check(SubagentToolSchema, { tasks: [] }), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: Array.from({ length: HARD_LIMITS.maxTasks + 1 }, (_, index) => ({
			id: `t${index}`,
			role: "explorer",
			objective: "x",
			scope: ["."],
		})),
	}), false);
});

test("UTF-8 truncation preserves complete characters and reports omitted bytes", () => {
	const result = truncateUtf8("a😀b", 5);
	assert.equal(result.text, "a😀");
	assert.equal(result.truncatedBytes, 1);
	assert.deepEqual(truncateUtf8("small", 10), { text: "small", truncatedBytes: 0 });
});
