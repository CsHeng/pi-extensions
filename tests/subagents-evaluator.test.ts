import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extractSessionMetrics,
	resolveSessionPath,
} from "../.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts";

function toolResult(details: Record<string, unknown>, text = "Subagent run complete"): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolName: "csheng_subagents",
			content: [{ type: "text", text }],
			details,
		},
	});
}

function telemetry(version: 1 | 2, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: version,
		runId: "SECRET_RUN_ID",
		runDurationMs: 80,
		requestedTasks: 1,
		admittedTasks: 1,
		launchedChildren: 1,
		peakConcurrency: 1,
		peakConcurrencyByRole: { explorer: 1, reviewer: 0, worker: 0 },
		...(version === 2 ? {
			requestedDependencyEdges: 0,
			admittedDependencyEdges: 0,
			explicitModelTasks: 0,
			explicitThinkingTasks: 0,
		} : {}),
		...overrides,
	};
}

const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: 0.25, turns: 1 };

function task(role: "explorer" | "reviewer" | "worker", overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "SECRET_TASK_ID",
		role,
		status: "succeeded",
		output: "SECRET_CHILD_OUTPUT",
		stderr: "SECRET_STDERR",
		usage,
		durationMs: 42,
		changedPaths: role === "worker" ? ["SECRET_REPOSITORY_PATH"] : [],
		telemetry: { childStarted: true },
		route: {
			provider: "fixture",
			model: "resolved-luna",
			thinking: "medium",
			source: "package-default",
			selectionSource: "role-default",
		},
		...overrides,
	};
}

test("legacy evidence remains readable and does not infer unavailable metrics", () => {
	const text = [
		JSON.stringify({ type: "message", message: { role: "user", content: "SECRET_PROMPT" } }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "csheng_subagents", arguments: { model: "SECRET_RAW_SELECTOR" } }],
			},
		}),
		toolResult({ status: "failed", tasks: [], usage: {} }, "Subagent graph rejected (invalid_scope): SECRET_PATH SECRET_CANDIDATE_LIST"),
		toolResult({
			status: "succeeded",
			tasks: [task("explorer", {
				model: "SECRET_RAW_TASK_SELECTOR",
				diagnosticSessionRef: "SECRET_DIAGNOSTIC_PATH",
				activity: { phase: "running", latestEventType: "SECRET_ACTIVITY_PAYLOAD" },
				route: { provider: "fixture", model: "luna", thinking: "medium", source: "parent" },
			})],
			usage,
		}),
	].join("\n");
	const metrics = extractSessionMetrics(text, "/redacted/2026_session-legacy123.jsonl");
	assert.equal(metrics.schemaVersion, 2);
	assert.equal(metrics.source.telemetryMode, "legacy");
	assert.equal(metrics.totals.toolCalls, 2);
	assert.equal(metrics.totals.requestedTasks, 1);
	assert.equal(metrics.totals.admittedTasks, 1);
	assert.equal(metrics.totals.launchedChildren, 1);
	assert.equal(metrics.totals.singletonRuns, 1);
	assert.deepEqual(metrics.totals.hardDependencyEdges, { known: 0, unavailableRuns: 2 });
	assert.deepEqual(metrics.totals.explicitModelTasks, { known: 0, unavailableRuns: 2 });
	assert.deepEqual(metrics.totals.explicitThinkingTasks, { known: 0, unavailableRuns: 2 });
	assert.equal(metrics.totals.mechanicalDispatchCorrectionCandidates, 1);
	assert.equal(metrics.roles.explorer.launchedChildren, 1);
	assert.deepEqual(metrics.errors, [{ code: "invalid_scope", count: 1 }]);
	assert.equal(metrics.concurrency.observedPeak, null);
	assert.equal(metrics.runs[0]?.requestedTasks, null);
	assert.equal(metrics.runs[0]?.admittedTasks, null);
	assert.equal(metrics.runs[0]?.requestedDependencyEdges, null);
	assert.equal(metrics.runs[1]?.telemetrySchemaVersion, null);
	assert.equal(metrics.routes[0]?.selectionSource, "unavailable");
	const serialized = JSON.stringify(metrics);
	for (const secret of [
		"SECRET_PROMPT",
		"SECRET_PATH",
		"SECRET_TASK_ID",
		"SECRET_CHILD_OUTPUT",
		"SECRET_STDERR",
		"SECRET_RAW_SELECTOR",
		"SECRET_RAW_TASK_SELECTOR",
		"SECRET_CANDIDATE_LIST",
		"SECRET_REPOSITORY_PATH",
		"SECRET_DIAGNOSTIC_PATH",
		"SECRET_ACTIVITY_PAYLOAD",
	]) {
		assert.equal(serialized.includes(secret), false);
	}
});

test("runtime schema one is authoritative only for its available fields", () => {
	const text = toolResult({
		status: "partial",
		telemetry: telemetry(1, {
			requestedTasks: 2,
			admittedTasks: 2,
			launchedChildren: 1,
		}),
		tasks: [
			task("explorer"),
			task("worker", {
				status: "failed",
				usage: { ...usage, turns: 0, cost: 0 },
				durationMs: 0,
				changedPaths: [],
				telemetry: { childStarted: false },
				route: undefined,
				error: { code: "new_file_parent_missing" },
			}),
		],
	});
	const metrics = extractSessionMetrics(text, "session_schema123.jsonl");
	assert.equal(metrics.source.telemetryMode, "authoritative");
	assert.equal(metrics.totals.requestedTasks, 2);
	assert.equal(metrics.totals.admittedTasks, 2);
	assert.equal(metrics.totals.launchedChildren, 1);
	assert.equal(metrics.totals.singletonRuns, 0);
	assert.deepEqual(metrics.totals.hardDependencyEdges, { known: 0, unavailableRuns: 1 });
	assert.equal(metrics.runs[0]?.telemetryAuthority, "authoritative");
	assert.equal(metrics.runs[0]?.telemetrySchemaVersion, 1);
	assert.equal(metrics.runs[0]?.runDurationMs, 80);
	assert.equal(metrics.runs[0]?.requestedDependencyEdges, null);
	assert.equal(metrics.runs[0]?.explicitModelTasks, null);
	assert.equal(metrics.concurrency.observedPeak, 1);
	assert.deepEqual(metrics.errors, [{ code: "new_file_parent_missing", count: 1 }]);
});

test("runtime schema two reports topology, overrides, route attribution, and zero-change evidence", () => {
	const text = [
		toolResult({
			status: "succeeded",
			telemetry: telemetry(2, {
				requestedTasks: 3,
				admittedTasks: 3,
				launchedChildren: 3,
				peakConcurrency: 3,
				requestedDependencyEdges: 1,
				admittedDependencyEdges: 1,
				explicitModelTasks: 1,
				explicitThinkingTasks: 1,
			}),
			tasks: [
				task("explorer", {
					route: {
						provider: "fixture",
						model: "explicit-selene",
						thinking: "high",
						source: "parent",
						selectionSource: "explicit-task",
					},
				}),
				task("reviewer"),
				task("worker", { changedPaths: undefined }),
			],
		}),
		toolResult({
			status: "succeeded",
			telemetry: telemetry(2),
			tasks: [task("worker", { changedPaths: [] })],
		}),
		toolResult({
			status: "failed",
			telemetry: telemetry(2, { launchedChildren: 1 }),
			tasks: [task("worker", {
				status: "failed",
				changedPaths: [],
				error: { code: "worker_no_changes" },
			})],
		}),
	].join("\n");
	const metrics = extractSessionMetrics(text, "session_schema-v2.jsonl");
	assert.equal(metrics.totals.requestedTasks, 5);
	assert.equal(metrics.totals.admittedTasks, 5);
	assert.equal(metrics.totals.launchedChildren, 5);
	assert.equal(metrics.totals.singletonRuns, 2);
	assert.equal(metrics.totals.zeroChangeWorkers, 1);
	assert.deepEqual(metrics.totals.hardDependencyEdges, { known: 1, unavailableRuns: 0 });
	assert.deepEqual(metrics.totals.explicitModelTasks, { known: 1, unavailableRuns: 0 });
	assert.deepEqual(metrics.totals.explicitThinkingTasks, { known: 1, unavailableRuns: 0 });
	assert.equal(metrics.runs[0]?.requestedDependencyEdges, 1);
	assert.equal(metrics.runs[0]?.admittedDependencyEdges, 1);
	assert.equal(metrics.runs[0]?.explicitModelTasks, 1);
	assert.equal(metrics.runs[0]?.explicitThinkingTasks, 1);
	assert.equal(metrics.runs[0]?.roles.explorer.tasks, 1);
	assert.equal(metrics.runs[0]?.roles.reviewer.tasks, 1);
	assert.equal(metrics.runs[1]?.roles.worker.usage.cost, 0.25);
	assert.deepEqual(metrics.routes.map((route) => route.selectionSource).sort(), ["explicit-task", "role-default"]);
	assert.deepEqual(metrics.errors, [{ code: "worker_no_changes", count: 1 }]);
});

test("schema-two pre-admission failure retains requested evidence without task arguments", () => {
	const text = [
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{
					type: "toolCall",
					name: "csheng_subagents",
					arguments: {
						tasks: [{ id: "SECRET_ARGUMENT_TASK_ID", model: "SECRET_ARGUMENT_SELECTOR", thinking: "high" }],
					},
				}],
			},
		}),
		toolResult({
			status: "failed",
			telemetry: telemetry(2, {
				requestedTasks: 2,
				admittedTasks: 0,
				launchedChildren: 0,
				peakConcurrency: 0,
				requestedDependencyEdges: 3,
				admittedDependencyEdges: 0,
				explicitModelTasks: 1,
				explicitThinkingTasks: 2,
				runErrorCode: "dependency_cycle",
			}),
			tasks: [],
		}, "Subagent graph rejected (secret_selector): SECRET_ARGUMENT_SELECTOR candidates SECRET_CANDIDATE"),
	].join("\n");
	const metrics = extractSessionMetrics(text, "session_rejected-v2.jsonl");
	assert.equal(metrics.totals.requestedTasks, 2);
	assert.equal(metrics.totals.admittedTasks, 0);
	assert.equal(metrics.totals.launchedChildren, 0);
	assert.deepEqual(metrics.totals.hardDependencyEdges, { known: 3, unavailableRuns: 0 });
	assert.deepEqual(metrics.totals.explicitModelTasks, { known: 1, unavailableRuns: 0 });
	assert.deepEqual(metrics.totals.explicitThinkingTasks, { known: 2, unavailableRuns: 0 });
	assert.equal(metrics.runs[0]?.admittedDependencyEdges, 0);
	assert.equal(metrics.totals.mechanicalDispatchCorrectionCandidates, 1);
	assert.deepEqual(metrics.errors, [{ code: "dependency_cycle", count: 1 }]);
	const serialized = JSON.stringify(metrics);
	for (const secret of ["SECRET_ARGUMENT_TASK_ID", "SECRET_ARGUMENT_SELECTOR", "SECRET_CANDIDATE", "secret_selector"]) {
		assert.equal(serialized.includes(secret), false);
	}
});

test("singleton runs for every role remain derivable from per-run role summaries", () => {
	const text = (["explorer", "reviewer", "worker"] as const).map((role) => toolResult({
		status: "succeeded",
		telemetry: telemetry(2),
		tasks: [task(role)],
	})).join("\n");
	const metrics = extractSessionMetrics(text, "session_singletons.jsonl");
	assert.equal(metrics.totals.singletonRuns, 3);
	assert.deepEqual(metrics.runs.map((run) => roleWithTask(run.roles)), ["explorer", "reviewer", "worker"]);
});

function roleWithTask(roles: Record<"explorer" | "reviewer" | "worker", { tasks: number }>): string {
	return Object.entries(roles).find(([, metric]) => metric.tasks === 1)?.[0] ?? "none";
}

test("session ID resolution refuses ambiguous matches", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-evaluator-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "one"));
	await mkdir(join(root, "two"));
	const id = "fixture-session-1234";
	await writeFile(join(root, "one", `a_${id}.jsonl`), "");
	assert.equal(await resolveSessionPath(id, root), join(root, "one", `a_${id}.jsonl`));
	await writeFile(join(root, "two", `b_${id}.jsonl`), "");
	await assert.rejects(resolveSessionPath(id, root), /ambiguous_session_id/);
});
