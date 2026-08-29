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

const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: 0.25, turns: 1 };

test("legacy session metrics infer launches without retaining raw task content", () => {
	const text = [
		JSON.stringify({ type: "message", message: { role: "user", content: "SECRET_PROMPT" } }),
		toolResult({ status: "failed", tasks: [], usage: {} }, "Subagent graph rejected (invalid_scope): SECRET_PATH"),
		toolResult({
			status: "succeeded",
			tasks: [{
				id: "SECRET_TASK_ID",
				role: "explorer",
				status: "succeeded",
				output: "SECRET_CHILD_OUTPUT",
				stderr: "SECRET_STDERR",
				usage,
				durationMs: 42,
				changedPaths: [],
				route: { provider: "fixture", model: "luna", thinking: "medium", source: "parent" },
			}],
			usage,
		}),
	].join("\n");
	const metrics = extractSessionMetrics(text, "/redacted/2026_session-legacy123.jsonl");
	assert.equal(metrics.source.telemetryMode, "legacy");
	assert.equal(metrics.totals.toolCalls, 2);
	assert.equal(metrics.totals.launchedChildren, 1);
	assert.equal(metrics.totals.mechanicalDispatchCorrectionCandidates, 1);
	assert.equal(metrics.roles.explorer.launchedChildren, 1);
	assert.deepEqual(metrics.errors, [{ code: "invalid_scope", count: 1 }]);
	assert.equal(metrics.concurrency.observedPeak, null);
	const serialized = JSON.stringify(metrics);
	for (const secret of ["SECRET_PROMPT", "SECRET_PATH", "SECRET_TASK_ID", "SECRET_CHILD_OUTPUT", "SECRET_STDERR"]) {
		assert.equal(serialized.includes(secret), false);
	}
});

test("schema-one session uses authoritative launch and concurrency telemetry", () => {
	const text = toolResult({
		status: "partial",
		telemetry: {
			schemaVersion: 1,
			runId: "run-secret-not-retained",
			runDurationMs: 80,
			requestedTasks: 2,
			admittedTasks: 2,
			launchedChildren: 1,
			peakConcurrency: 1,
			peakConcurrencyByRole: { explorer: 1, reviewer: 0, worker: 0 },
		},
		tasks: [
			{
				id: "a",
				role: "explorer",
				status: "succeeded",
				usage,
				durationMs: 40,
				changedPaths: [],
				telemetry: { childStarted: true },
				route: { provider: "fixture", model: "luna", thinking: "medium", source: "package-default" },
			},
			{
				id: "b",
				role: "worker",
				status: "failed",
				usage: { ...usage, turns: 0, cost: 0 },
				durationMs: 0,
				changedPaths: [],
				telemetry: { childStarted: false },
				error: { code: "new_file_parent_missing" },
			},
		],
	});
	const metrics = extractSessionMetrics(text, "session_schema123.jsonl");
	assert.equal(metrics.source.telemetryMode, "authoritative");
	assert.equal(metrics.totals.launchedChildren, 1);
	assert.equal(metrics.runs[0]?.runDurationMs, 80);
	assert.equal(metrics.runs[0]?.requestedTasks, 2);
	assert.equal(metrics.concurrency.observedPeak, 1);
	assert.deepEqual(metrics.errors, [{ code: "new_file_parent_missing", count: 1 }]);
});

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
