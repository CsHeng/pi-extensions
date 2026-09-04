import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
	TELEMETRY_SCHEMA_VERSION,
	emptyUsage,
	type SubagentRunResult,
	type TaskResult,
} from "../extensions/subagents/contracts.ts";
import { boundToolContent, formatClock, formatDuration, formatProgress, formatRunResult } from "../extensions/subagents/render.ts";

function task(index: number, output: string): TaskResult {
	return {
		id: `task-${index}`,
		role: index % 3 === 0 ? "worker" : index % 2 === 0 ? "reviewer" : "explorer",
		status: index === 8 ? "failed" : "succeeded",
		output,
		stderr: "",
		usage: emptyUsage(),
		durationMs: 1_500 + index,
		changedPaths: Array.from({ length: 32 }, (_, pathIndex) => `src/${index}/${"p".repeat(300)}-${pathIndex}.ts`),
		convergence: index % 3 === 0 ? "applied" : "not-applicable",
		route: {
			provider: "synthetic",
			model: `model-${"m".repeat(800)}`,
			thinking: "high",
			source: "package-default",
			candidateIndex: 0,
			executionProfileRequested: "deep",
			executionProfileApplied: false,
			reasoningProfileRequested: "deep",
			reasoningProfileApplied: true,
			profileFallbacks: ["execution-role-default"],
			selectionSource: "role-default",
			modelOverrideRequested: false,
			thinkingOverrideRequested: false,
		},
		...(index === 8 ? { error: { code: "synthetic_failure", message: `failure ${"e".repeat(10_000)}` } } : {}),
	};
}

function run(tasks: TaskResult[]): SubagentRunResult {
	return {
		status: "partial",
		tasks,
		usage: emptyUsage(),
		telemetry: {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			runId: "render-contract",
			runDurationMs: 61_500,
			requestedTasks: tasks.length,
			admittedTasks: tasks.length,
			requestedDependencyEdges: 0,
			admittedDependencyEdges: 0,
			explicitModelTasks: 0,
			explicitThinkingTasks: 0,
			launchedChildren: tasks.length,
			peakConcurrency: tasks.length,
			peakConcurrencyByRole: { explorer: 4, reviewer: 4, worker: 2 },
		},
	};
}

test("duration rendering is deterministic and compact", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(999), "999ms");
	assert.equal(formatDuration(1_000), "1.0s");
	assert.equal(formatDuration(61_500), "1m 1.5s");
	assert.equal(formatClock(0), "0s");
	assert.equal(formatClock(5_000), "5s");
	assert.equal(formatClock(61_500), "1m 1s");
	assert.equal(formatClock(3_661_000), "1h 1m 1s");
});

test("aggregate rendering obeys Pi byte and line limits while retaining every task summary", () => {
	const lineHeavy = Array.from({ length: 2_500 }, (_, index) => `line-${index} 😀`).join("\n");
	const longLine = `${"界".repeat(30_000)} end`;
	const result = formatRunResult(run(Array.from({ length: 10 }, (_, index) => task(index, index % 2 === 0 ? lineHeavy : longLine))));

	assert.ok(Buffer.byteLength(result, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(result.split("\n").length <= DEFAULT_MAX_LINES);
	for (let index = 0; index < 10; index += 1) {
		assert.match(result, new RegExp(`^\\[task-${index}\\] (?:explorer|reviewer|worker) (?:succeeded|failed) elapsed=`, "m"));
	}
	assert.match(result, /elapsed=1\.5s/);
	assert.match(result, /source=package-default selection=role-default/);
	assert.match(result, /profiles=execution:deep\/not-applied;reasoning:deep\/applied;fallbacks:execution-role-default/);
	assert.match(result, /Task details truncated/);
});

test("arbitrary final tool text is bounded even when its first line exceeds the byte limit", () => {
	const bounded = boundToolContent("界".repeat(30_000));
	assert.ok(Buffer.byteLength(bounded, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(bounded.split("\n").length <= DEFAULT_MAX_LINES);
	assert.match(bounded, /Tool result truncated/);
});

test("progress includes bounded activity without diagnostic paths or payloads", () => {
	const results = [task(0, "done"), {
		...task(1, ""),
		status: "running" as const,
		durationMs: 5_000,
		diagnosticSessionRef: "subagent-sessions/private/run/task.jsonl",
		activity: {
			phase: "settled-awaiting-exit" as const,
			assistantTurns: 3,
			activeTools: ["read"],
			latestEventType: "agent_settled",
			errorObserved: true,
			errorCount: 2,
			agentEndObserved: true,
			agentSettledObserved: true,
			elapsedMs: 5_000,
			inactiveForMs: 2_000,
		},
	}];
	const progress = formatProgress(results);
	assert.match(progress, /Subagents 1\/2 running, 1 finished · 3 turns · 5s/);
	assert.match(progress, /task-0.*succeeded.*route=synthetic\/model-.*:high.*elapsed=1\.5s/);
	assert.match(progress, /task-1.*settled-awaiting-exit route=synthetic\/model-.*:high elapsed=5\.0s turns=3 tool=read errs=2 inactive=2\.0s/);
	assert.doesNotMatch(progress, /subagent-sessions|private|jsonl/);
});
