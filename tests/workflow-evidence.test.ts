
import { before as ensureScopeBefore } from "node:test";
import { mkdir as ensureScopeMkdir } from "node:fs/promises";
ensureScopeBefore(async () => { await ensureScopeMkdir("/tmp/scope", { recursive: true }); await ensureScopeMkdir("/tmp/src", { recursive: true }); });
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_TOOL_NAME, OBSERVATION_LIMITS, summarizeHostObservation } from "../extensions/workflow/observation.ts";
import { createGoalStore } from "../extensions/workflow/goal-store.ts";
import { accepted } from "../extensions/workflow/goal-state.ts";

test("broad source declarations never read contents on capture, report, inspect, close or replay", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "workflow-provenance-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 await mkdir(join(cwd, ".venv")); await writeFile(join(cwd, ".venv", "large"), ""); await truncate(join(cwd, ".venv", "large"), 32 * 1024 * 1024);
 const reads: string[] = [];
 for (const name of ["readFile", "readdir"] as const) t.mock.method(fs, name, () => { reads.push(name); throw new Error("content traversal forbidden"); });
 const entries: any[] = []; const store = createGoalStore((customType, data) => entries.push({ type: "custom", customType, data }));
 const ctx = { cwd, now: "2026-09-28T00:00:00.000Z", sessionId: "fixture" }; let serial = 0;
 const run = async (op: any) => { const result = await store.mutate(op, ctx, `call-${++serial}`); assert.equal(result.ok, true, result.message); return result; };
 await run({ operation: "enroll", goal: "fixture", delivery: "source", authority: "fixture", requirements: [{ key: "r", outcome: "fixture", verification: "check" }], tasks: [{ key: "t", title: "Fixture", covers: ["r"] }] });
 await run({ operation: "start", task: "t", scope: ["/tmp/scope"], writes: ["source"] });
 const capture = await store.capture(cwd);
 const observationId = store.observe({ ...capture, host: { toolCallId: "check", toolName: "bash", sessionId: ctx.sessionId, at: ctx.now, isError: false } });
 await writeFile(join(cwd, "source"), "edited source");
 await run({ operation: "report", summary: "explicit relevance judgment", facts: [{ id: "f", kind: "host", check: "fixture check", observationId, result: "pass" }], judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ target: subject === "delivery" ? { kind: "delivery" } : { kind: subject.split(":")[0], id: subject.split(":")[1] }, facts: ["f"], accepted: true, rationale: "actual check remains relevant" })) });
 await writeFile(join(cwd, "unrelated"), "unrelated drift");
 await run({ operation: "inspect" }); await store.settle(ctx, () => {});
 assert.equal(accepted(store.current()!, "task:t"), true);
 await run({ operation: "close", outcome: "completed", reason: "all required judgments supplied" });
 const replay = createGoalStore(() => {}); replay.replay(entries); replay.recover("restart");
 assert.equal(replay.current()!.fulfillment, "complete");
 assert.deepEqual(reads, []);
 assert.equal("basis" in store.current()!.facts[0]!, false);
});

test("unsupported managed envelopes are excluded before their payload is read", () => {
	const session = { handle: "sess_x", role: "worker", episode: 1, state: "idle", reportComplete: true,
		candidate: { id: "cand_1", status: "applied", changedPaths: ["private/path"], appliedPaths: ["private/path"] }, result: { output: "private report" } };
	for (const schemaVersion of [1, 2, 3]) {
		const legacy = summarizeHostObservation({ toolCallId: `legacy-${schemaVersion}`, toolName: MANAGED_SESSION_TOOL_NAME, isError: false,
			result: { details: { schemaVersion, action: "create", status: "succeeded", sessions: [session] } } });
		assert.equal(legacy.managed, undefined, `schemaVersion ${schemaVersion} must not be interpreted`);
		assert.equal(legacy.exitCode, undefined);
		assert.doesNotMatch(JSON.stringify(legacy), /private|sess_x|cand_1/);
	}
});

test("host observations retain bounded public facts without raw reports or file paths", () => {
	const session = {
		handle: "sess_x", role: "worker", episode: 1, state: "idle", reportComplete: true,
		candidate: { id: "cand_1", status: "not-applied", changedPaths: ["private/path"], appliedPaths: [] },
		result: { output: "private report" },
	};
	const observation = summarizeHostObservation({
		toolCallId: "call-create", toolName: MANAGED_SESSION_TOOL_NAME, isError: false,
		result: { details: { schemaVersion: 4, action: "create", status: "succeeded", sessions: [session] } },
	});
	assert.deepEqual(observation.managed, {
		schemaVersion: 4, action: "create", status: "succeeded", sessions: [{
			handle: "sess_x", role: "worker", episode: 1, state: "idle", reportComplete: true,
			candidate: { id: "cand_1", status: "not-applied", changedPaths: 1, appliedPaths: 0 },
		}],
	});
	assert.doesNotMatch(JSON.stringify(observation), /private/);
	const oversized = summarizeHostObservation({
		toolCallId: "x".repeat(500), toolName: MANAGED_SESSION_TOOL_NAME, isError: false,
		result: { details: { action: "create", status: "x".repeat(500), sessions: Array.from({ length: 20 }, () => session) } },
	});
	assert.equal(oversized.toolCallId, "x".repeat(500));
	assert.equal(oversized.managed, undefined);
	const bash = summarizeHostObservation({ toolCallId: "call-bash", toolName: "bash", isError: false, result: { details: { exitCode: 1 } } });
	assert.equal(bash.exitCode, 1);
	assert.equal(bash.managed, undefined);
	const unparsed = summarizeHostObservation({ toolCallId: "call-write", toolName: "write", isError: true, result: { details: { path: "/tmp/x", bytes: 10 } } });
	assert.equal(unparsed.managed, undefined);
	assert.equal(unparsed.exitCode, undefined);
});
