import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
	HARD_LIMITS,
	PROFILE_FALLBACKS,
	ROLE_NAMES,
	ROUTE_SELECTION_SOURCES,
	STABLE_TASK_ERROR_CODES,
	SubagentTaskSchema,
	SubagentToolSchema,
	TELEMETRY_SCHEMA_VERSION,
	THINKING_LEVELS,
	truncateUtf8,
} from "../extensions/subagents/contracts.ts";
import type {
	EffectiveRouteV2,
	RunTelemetryV2,
} from "../extensions/subagents/contracts.ts";
import { ROLES } from "../extensions/subagents/roles.ts";

test("subagent roles have fixed least-authority tool sets", () => {
	assert.deepEqual(ROLE_NAMES, ["explorer", "reviewer", "worker"]);
	assert.deepEqual(ROLES.explorer.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(ROLES.reviewer.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(ROLES.worker.tools, ["read", "grep", "find", "ls", "edit", "write"]);
	for (const role of Object.values(ROLES)) {
		assert.equal("name" in role, false);
		assert.equal("canWrite" in role, false);
		assert.equal(role.tools.includes("bash"), false);
		assert.match(role.systemPrompt, /Do not delegate/);
	}
});

test("model-facing string choices serialize as provider-compatible enums", () => {
	const properties = (SubagentTaskSchema as unknown as {
		properties: Record<string, { enum?: unknown; anyOf?: unknown }>;
	}).properties;
	assert.deepEqual(properties.role?.enum, ROLE_NAMES);
	assert.deepEqual(properties.executionProfile?.enum, ["fast", "balanced", "deep"]);
	assert.deepEqual(properties.reasoningProfile?.enum, ["light", "standard", "deep"]);
	assert.deepEqual(properties.thinking?.enum, THINKING_LEVELS);
	assert.equal(properties.role?.anyOf, undefined);
});

test("tool schema preserves old task shapes and accepts exact ephemeral overrides", () => {
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
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{
			id: "write",
			role: "worker",
			objective: "Apply the bounded change",
			scope: ["."],
			inputs: ["Approved task"],
			dependsOn: ["scan"],
			writePaths: ["src/file.ts"],
			verification: ["focused test"],
			resourceLocks: ["src/file.ts"],
			executionProfile: "balanced",
			reasoningProfile: "standard",
		}],
	}), true);
	assert.equal(Check(SubagentToolSchema, { ...valid, model: "some-model" }), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], model: "provider/model" }],
	}), true);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], model: "" }],
	}), false);
	for (const thinking of THINKING_LEVELS) {
		assert.equal(Check(SubagentToolSchema, {
			tasks: [{ ...valid.tasks[0], thinking }],
		}), true);
	}
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], cwd: "/tmp" }],
	}), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], executionProfile: "extreme" }],
	}), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], thinking: "extreme" }],
	}), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], model: "provider/model", unknown: true }],
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

test("model-facing capability fields retain descriptions without freezing prose", () => {
	const taskProperties = (SubagentTaskSchema as unknown as {
		properties: Record<string, { description?: string }>;
	}).properties;
	const toolProperties = (SubagentToolSchema as unknown as {
		properties: Record<string, { description?: string }>;
	}).properties;
	for (const description of [
		toolProperties.tasks?.description,
		taskProperties.dependsOn?.description,
		taskProperties.scope?.description,
		taskProperties.writePaths?.description,
		taskProperties.model?.description,
		taskProperties.thinking?.description,
	]) {
		assert.equal(typeof description, "string");
		assert.ok((description?.trim().length ?? 0) > 0);
	}
});

test("telemetry schema v2 freezes run counters, route attribution, and stable errors", () => {
	const telemetry: RunTelemetryV2 = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		runId: "run-1",
		runDurationMs: 10,
		requestedTasks: 2,
		admittedTasks: 1,
		requestedDependencyEdges: 1,
		admittedDependencyEdges: 0,
		explicitModelTasks: 1,
		explicitThinkingTasks: 1,
		launchedChildren: 1,
		peakConcurrency: 1,
		peakConcurrencyByRole: { explorer: 1, reviewer: 0, worker: 0 },
	};
	const routeEvidence: EffectiveRouteV2 = {
		provider: "provider",
		model: "model",
		thinking: "high",
		source: "user-config",
		candidateIndex: 0,
		executionProfileRequested: "fast",
		reasoningProfileRequested: "deep",
		selectionSource: "explicit-task",
		modelOverrideRequested: true,
		thinkingOverrideRequested: true,
		executionProfileApplied: false,
		reasoningProfileApplied: false,
		profileFallbacks: [],
	};
	assert.equal(TELEMETRY_SCHEMA_VERSION, 2);
	assert.deepEqual(ROUTE_SELECTION_SOURCES, ["role-default", "explicit-task"]);
	assert.deepEqual(PROFILE_FALLBACKS, ["execution-role-default", "reasoning-role-default"]);
	assert.equal(telemetry.requestedDependencyEdges, 1);
	assert.equal(routeEvidence.selectionSource, "explicit-task");
	assert.equal(routeEvidence.source, "user-config");
	assert.deepEqual(STABLE_TASK_ERROR_CODES, [
		"invalid_scope",
		"worker_write_paths_required",
		"model_not_found",
		"model_unavailable",
		"ambiguous_model",
		"thinking_unavailable",
		"worker_no_changes",
	]);
});

test("UTF-8 truncation preserves complete characters and reports omitted bytes", () => {
	const result = truncateUtf8("a😀b", 5);
	assert.equal(result.text, "a😀");
	assert.equal(result.truncatedBytes, 1);
	assert.deepEqual(truncateUtf8("small", 10), { text: "small", truncatedBytes: 0 });
});
