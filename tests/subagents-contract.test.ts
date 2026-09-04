import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
	CHILD_ACTIVITY_PHASES,
	CHILD_CAPABILITY_MANIFEST_V1,
	CHILD_CAPABILITY_MANIFEST_V2,
	HARD_LIMITS,
	PROFILE_FALLBACKS,
	ROLE_NAMES,
	ROUTE_SELECTION_SOURCES,
	STABLE_TASK_ERROR_CODES,
	SubagentTaskSchema,
	SubagentToolSchema,
	TASK_EXECUTION_PHASES,
	TELEMETRY_SCHEMA_VERSION,
	TELEMETRY_SCHEMA_VERSION_V2,
	THINKING_LEVELS,
	isSafeDiagnosticRef,
	isSafePathGrammar,
	truncateUtf8,
} from "../extensions/subagents/contracts.ts";
import type {
	ChildCapabilityManifestV1,
	ChildCapabilityManifestV2,
	EffectiveRouteV2,
	NormalizedChildCapability,
	RunTelemetryV2,
	RunTelemetryV3,
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
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], externalReadRoots: [] }],
	}), true);
	for (const count of [0, 1, 8]) {
		assert.equal(Check(SubagentToolSchema, {
			tasks: [{
				...valid.tasks[0],
				externalReadRoots: Array.from({ length: count }, (_, index) => `/external/root-${index}`),
			}],
		}), true);
	}
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{
			id: "review",
			role: "reviewer",
			objective: "Review evidence",
			scope: ["."],
			externalReadRoots: Array.from({ length: 8 }, (_, index) => `/external/root-${index}`),
		}],
	}), true);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{
			...valid.tasks[0],
			externalReadRoots: Array.from({ length: 9 }, (_, index) => `/external/root-${index}`),
		}],
	}), false);
	assert.equal(Check(SubagentToolSchema, {
		tasks: [{ ...valid.tasks[0], externalReadRoots: [""] }],
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
		taskProperties.externalReadRoots?.description,
		taskProperties.model?.description,
		taskProperties.thinking?.description,
	]) {
		assert.equal(typeof description, "string");
		assert.ok((description?.trim().length ?? 0) > 0);
	}
});

test("telemetry schema v2 freezes run counters, route attribution, and stable errors", () => {
	const telemetry: RunTelemetryV2 = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION_V2,
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
	assert.equal(TELEMETRY_SCHEMA_VERSION_V2, 2);
	assert.equal(TELEMETRY_SCHEMA_VERSION, 3);
	assert.equal(telemetry.schemaVersion, 2);
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
		"diagnostic_session_unavailable",
		"diagnostic_storage_unavailable",
		"diagnostic_session_limit",
		"child_exit_stalled",
		"repository_root_unavailable",
		"scope_outside_repository",
		"external_read_roots_forbidden",
		"invalid_external_read_root",
		"external_read_root_unavailable",
		"external_read_root_not_external",
		"duplicate_external_read_root",
	]);
	assert.equal("pathCount" in telemetry, false);
	assert.equal("externalReadRootCount" in telemetry, false);
	assert.equal("repositoryCount" in telemetry, false);
});

test("telemetry schema v3 adds start time, provenance, and optional effective caps", () => {
	const unavailable: RunTelemetryV3 = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		runId: "run-1",
		runDurationMs: 10,
		requestedTasks: 1,
		admittedTasks: 1,
		requestedDependencyEdges: 0,
		admittedDependencyEdges: 0,
		explicitModelTasks: 0,
		explicitThinkingTasks: 0,
		launchedChildren: 1,
		peakConcurrency: 1,
		peakConcurrencyByRole: { explorer: 1, reviewer: 0, worker: 0 },
		startedAtMs: 1,
		provenance: { available: false },
	};
	const available: RunTelemetryV3 = {
		...unavailable,
		provenance: { available: true, extensionEpoch: "ext-1", configurationEpoch: "cfg-1" },
		effectiveMaxConcurrency: 10,
		effectiveRoleConcurrency: { explorer: 4, reviewer: 4, worker: 2 },
	};
	assert.equal(unavailable.schemaVersion, 3);
	assert.equal(unavailable.provenance.available, false);
	assert.equal(available.provenance.available, true);
	assert.equal("pathCount" in available, false);
	assert.deepEqual(TASK_EXECUTION_PHASES, [
		"queued",
		"workspace-preparation",
		"child-execution",
		"convergence-critical",
		"settled",
	]);
});

test("path grammar and private capability manifests are exact and additive", () => {
	assert.equal(HARD_LIMITS.maxExternalReadRoots, 8);
	assert.equal(HARD_LIMITS.maxPathBytes, 4096);
	assert.equal(CHILD_CAPABILITY_MANIFEST_V1, 1);
	assert.equal(CHILD_CAPABILITY_MANIFEST_V2, 2);
	assert.equal(isSafePathGrammar("src/file.ts"), true);
	assert.equal(isSafePathGrammar("."), true);
	assert.equal(isSafePathGrammar(""), false);
	assert.equal(isSafePathGrammar("bad\0path"), false);
	assert.equal(isSafePathGrammar("bad\u0001path"), false);
	assert.equal(isSafePathGrammar("bad\u007Fpath"), false);
	assert.equal(isSafePathGrammar("bad\u2028path"), false);
	assert.equal(isSafePathGrammar("bad\u2029path"), false);
	assert.equal(isSafePathGrammar("x".repeat(HARD_LIMITS.maxPathBytes)), true);
	assert.equal(isSafePathGrammar("x".repeat(HARD_LIMITS.maxPathBytes + 1)), false);
	const v1: ChildCapabilityManifestV1 = {
		version: 1,
		root: "/repo",
		role: "explorer",
		readRoots: ["/repo"],
		writePaths: [],
	};
	const v2: ChildCapabilityManifestV2 = {
		version: 2,
		root: "/repo",
		role: "reviewer",
		readRoots: ["/repo"],
		writePaths: [],
		externalReadRoots: ["/other"],
	};
	const runtime: NormalizedChildCapability = {
		version: 2,
		root: "/repo",
		role: "explorer",
		readRoots: ["/repo"],
		writePaths: [],
		externalReadRoots: [],
	};
	assert.equal(v1.version, CHILD_CAPABILITY_MANIFEST_V1);
	assert.equal(v2.version, CHILD_CAPABILITY_MANIFEST_V2);
	assert.equal("externalReadRoots" in v1, false);
	assert.deepEqual(runtime.externalReadRoots, []);
	assert.equal(runtime.version, 2);
});

test("diagnostic and activity contracts are bounded and additive", () => {
	assert.deepEqual(CHILD_ACTIVITY_PHASES, [
		"starting",
		"running",
		"settling",
		"settled-awaiting-exit",
		"closed",
	]);
	assert.equal(HARD_LIMITS.heartbeatMs, 5_000);
	assert.equal(HARD_LIMITS.settledExitGraceMs, 10_000);
	assert.equal(HARD_LIMITS.diagnosticRetentionMs, 30 * 24 * 60 * 60 * 1_000);
	assert.equal(HARD_LIMITS.diagnosticRootBytes, 512 * 1024 * 1024);
	assert.equal(HARD_LIMITS.diagnosticChildBytes, 32 * 1024 * 1024);
	assert.equal(HARD_LIMITS.diagnosticRunBytes, 256 * 1024 * 1024);
	assert.equal(HARD_LIMITS.maxDiagnosticScopes, 20);
	assert.equal(HARD_LIMITS.maxDiagnosticTimelineEntries, 200);
	assert.equal(HARD_LIMITS.maxDiagnosticLineBytes, 1024 * 1024);
	assert.equal(HARD_LIMITS.maxDiagnosticRenderBytes, 64 * 1024);
	assert.equal(isSafeDiagnosticRef("subagent-sessions/parent/run/task.jsonl"), true);
	for (const unsafe of ["", "/absolute/run/task.jsonl", "../run/task.jsonl", "subagent-sessions/../run/task.jsonl", "subagent-sessions\\parent\\run\\task.jsonl"]) {
		assert.equal(isSafeDiagnosticRef(unsafe), false);
	}
});

test("UTF-8 truncation preserves complete characters and reports omitted bytes", () => {
	const result = truncateUtf8("a😀b", 5);
	assert.equal(result.text, "a😀");
	assert.equal(result.truncatedBytes, 1);
	assert.deepEqual(truncateUtf8("small", 10), { text: "small", truncatedBytes: 0 });
});
