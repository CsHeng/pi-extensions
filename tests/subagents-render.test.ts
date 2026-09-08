import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
	TELEMETRY_SCHEMA_VERSION,
	emptyUsage,
	type SubagentRunResult,
	type TaskResult,
} from "../extensions/subagents/contracts.ts";
import {
	boundToolContent,
	formatClock,
	formatDuration,
	formatManagedContent,
	formatManagedResult,
	formatProgress,
	formatRunResult,
} from "../extensions/subagents/render.ts";
import type { SessionActionResult, SessionView } from "../extensions/subagents/session-contracts.ts";
import type { NativeObservation } from "../extensions/subagents/observability.ts";

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
	const progress = formatProgress(results, 12_000);
	assert.match(progress, /Subagents 1\/2 running, 1 finished · 3 turns · 12s/);
	assert.match(formatProgress(results), /3 turns · unknown/);
	assert.match(progress, /task-0.*succeeded.*route=synthetic\/model-.*:high.*elapsed=1\.5s/);
	assert.match(progress, /task-1.*settled-awaiting-exit route=synthetic\/model-.*:high elapsed=5\.0s turns=3 tool=read errs=2 inactive=2\.0s/);
	assert.doesNotMatch(progress, /subagent-sessions|private|jsonl/);
});

function emptyObservation(overrides: Partial<NativeObservation> = {}): NativeObservation {
	return {
		available: true,
		ownerSessionId: "sess1",
		entries: [{
			ownerSessionId: "sess1",
			entryId: "entry1",
			kind: "assistant",
			modelKey: null,
			usage: { input: 0, output: 1, cacheRead: null, cacheWrite: 0, totalTokens: null, cost: 0 },
		}],
		commands: [{
			ownerSessionId: "sess1",
			entryId: "cmd1",
			startMs: 1,
			endMs: 2,
			exitCode: 0,
			status: "succeeded",
			sourceBeforeKey: null,
			sourceAfterKey: null,
		}],
		usage: { input: 0, output: 1, cacheRead: null, cacheWrite: 0, totalTokens: null, cost: 0 },
		contextWindow: null,
		toolNames: null,
		capabilityKey: null,
		commandCoverage: "complete",
		...overrides,
	};
}

function sessionView(index: number, overrides: Partial<SessionView> = {}): SessionView {
	return {
		handle: `handle-${index}`,
		role: index % 3 === 0 ? "worker" : index % 2 === 0 ? "reviewer" : "explorer",
		episode: index,
		state: "idle",
		reportComplete: index !== 1,
		result: {
			...task(index, `report-${index}`),
			observation: emptyObservation(),
		},
		candidate: {
			id: `cand-${index}`,
			episode: index,
			status: "applied",
			changedPaths: ["a.ts"],
			appliedPaths: ["a.ts"],
		},
		...overrides,
	};
}

function managed(sessions: SessionView[], extra: Partial<SessionActionResult> = {}): SessionActionResult {
	return { schemaVersion: 1, action: "inspect", status: "succeeded", sessions, ...extra };
}

test("managed model content is parseable JSON with headers for ten huge reports", () => {
	const huge = `${"界".repeat(20_000)}\"\n\u0001 quote`;
	const sessions = Array.from({ length: 10 }, (_, index) => sessionView(index, {
		result: { ...task(index, huge), observation: emptyObservation(), stopReason: "stop", error: { code: "incomplete_report", message: "x" } },
	}));
	const content = formatManagedContent(managed(sessions, { error: { code: "partial_failure" } }));
	assert.ok(Buffer.byteLength(content, "utf8") <= DEFAULT_MAX_BYTES);
	const parsed = JSON.parse(content) as SessionActionResult & {
		parentAcceptance: string;
		sessions: Array<{
			handle: string;
			result?: { report?: string; reportTruncated?: boolean; id: string; status: string; stopReason?: string; error?: { code: string } };
			candidate?: { id: string; status: string; changedCount: number; appliedCount: number };
			nativeUsage: { recorded: boolean; input: number | null };
		}>;
	};
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.action, "inspect");
	assert.equal(parsed.status, "succeeded");
	assert.equal(parsed.error?.code, "partial_failure");
	assert.equal(parsed.parentAcceptance, "unavailable");
	assert.equal(parsed.sessions.length, 10);
	for (let index = 0; index < 10; index += 1) {
		const row = parsed.sessions[index]!;
		assert.equal(row.handle, `handle-${index}`);
		assert.equal(row.result?.id, `task-${index}`);
		assert.equal(row.result?.status, index === 8 ? "failed" : "succeeded");
		assert.equal(row.result?.stopReason, "stop");
		assert.equal(row.result?.error?.code, "incomplete_report");
		assert.equal(row.candidate?.id, `cand-${index}`);
		assert.equal(row.candidate?.status, "applied");
		assert.equal(row.candidate?.changedCount, 1);
		assert.equal(row.result?.reportTruncated, true);
		assert.equal(row.nativeUsage.recorded, true);
		assert.equal(row.nativeUsage.input, 0);
	}
	assert.doesNotMatch(content, /"entries"|"commands"|"timing"/);
	const expanded = formatManagedResult(managed(sessions), true);
	assert.ok(Buffer.byteLength(expanded) <= DEFAULT_MAX_BYTES);
	assert.ok(expanded.split("\n").length <= DEFAULT_MAX_LINES);
	for (const session of sessions) { assert.ok(expanded.includes(session.handle)); assert.ok(expanded.includes(session.candidate!.id)); }
});

test("managed content preserves zero native metrics and does not infer protocol usage", () => {
	const view = sessionView(0, {
		result: {
			...task(0, "ok"),
			usage: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99, cost: 9, turns: 9 },
			observation: emptyObservation({ available: false, usage: { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null } }),
		},
	});
	const parsed = JSON.parse(formatManagedContent(managed([view]))) as { sessions: Array<{ nativeUsage: Record<string, unknown> }> };
	assert.equal(parsed.sessions[0]!.nativeUsage.recorded, false);
	assert.equal(parsed.sessions[0]!.nativeUsage.input, null);
	const zero = sessionView(1, {
		result: { ...task(1, "ok"), observation: emptyObservation({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } }) },
	});
	const zeroParsed = JSON.parse(formatManagedContent(managed([zero]))) as { sessions: Array<{ nativeUsage: { recorded: boolean; input: number } }> };
	assert.equal(zeroParsed.sessions[0]!.nativeUsage.recorded, true);
	assert.equal(zeroParsed.sessions[0]!.nativeUsage.input, 0);
});

test("managed TUI separates request, stored state, episode outcome, and never infers acceptance", () => {
	const stale = sessionView(0, {
		state: "idle",
		requestError: { code: "stale_request" },
		result: { ...task(0, "committed-output"), status: "succeeded" },
		candidate: { id: "cand-0", episode: 0, status: "applied", changedPaths: ["a.ts"], appliedPaths: ["a.ts"] },
	});
	const text = formatManagedResult(managed([stale], { status: "failed", error: { code: "stale_request" } }), false);
	assert.match(text, /Managed session inspect: failed/);
	assert.match(text, /request error=stale_request/);
	assert.match(text, /idle \(no running process\)/);
	assert.match(text, /episode-outcome=succeeded/);
	assert.match(text, /requestError=stale_request/);
	assert.match(text, /candidate=cand-0 apply=applied/);
	assert.match(text, /parent acceptance unavailable/);
	assert.doesNotMatch(text, /committed-output|background agent|bash |sourceBefore|environment/);
	assert.doesNotMatch(formatManagedResult(managed([stale]), false), /--- \[handle-0\] report ---/);
	const expanded = formatManagedResult(managed([stale]), true);
	assert.match(expanded, /committed-output/);
});

test("managed TUI does not leak command rows and keeps candidate ids under bounds", () => {
	const view = sessionView(2, {
		handle: `h-${"x".repeat(400)}`,
		candidate: { id: `c-${"y".repeat(400)}`, episode: 2, status: "not-applied", changedPaths: [], appliedPaths: [] },
		result: { ...task(2, "ok"), observation: emptyObservation() },
	});
	const text = formatManagedResult(managed([view]));
	assert.match(text, /candidate=c-y+/);
	assert.doesNotMatch(text, /cmd1|sourceBeforeKey|environmentAfterKey|assistant turns/);
	const content = formatManagedContent(managed([view]));
	const parsed = JSON.parse(content) as { sessions: Array<{ handle: string; candidate: { id: string } }> };
	assert.ok(parsed.sessions[0]!.handle.startsWith("h-x"));
	assert.ok(parsed.sessions[0]!.candidate.id.startsWith("c-y"));
});
