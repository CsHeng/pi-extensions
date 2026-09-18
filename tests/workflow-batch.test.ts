import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { WORKFLOW_ENTRY_TYPE, WORKFLOW_LIMITS, type BatchOperation, type BatchStep, type RecordOperation } from "../extensions/workflow/contracts.ts";
import { createWorkflowStore, type SessionEntryLike } from "../extensions/workflow/store.ts";
import { registerWorkflowTool } from "../extensions/workflow/tool.ts";
import { executeBatch } from "../extensions/workflow/batch.ts";
import { createObservationIndex } from "../extensions/workflow/observation.ts";

const clock = { now: "2026-09-19T00:00:00.000Z", cwd: process.cwd(), sessionId: "batch-fixture" };
function fixture() {
	let definition: ToolDefinition | undefined;
	let failAppend = false;
	let unrecorded = false;
	const entries: SessionEntryLike[] = [];
	const store = createWorkflowStore({ append(customType, data) {
		if (failAppend) throw new Error("append failed");
		entries.push({ type: "custom", customType, data: structuredClone(data) });
	} });
	const observations = createObservationIndex();
	registerWorkflowTool({ registerTool(tool: ToolDefinition) { definition = tool; }, on() {} } as unknown as ExtensionAPI, store, observations, () => false, () => unrecorded);
	let calls = 0;
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => clock.sessionId } } as ExtensionContext;
	const execute = async (args: Record<string, unknown>, id = `host-${++calls}`, signal?: AbortSignal) => {
		const tool = definition!;
		const params = validateToolArguments(tool, { type: "toolCall", id, name: tool.name, arguments: args });
		return tool.execute(id, params, signal, undefined, ctx);
	};
	return { store, entries, observations, execute, failAppend() { failAppend = true; }, unrecorded() { unrecorded = true; } };
}
async function open(f: ReturnType<typeof fixture>) {
	await f.execute({ operation: "open", expectedRevision: 0, goal: "Batch fixture", deliveryEndpoint: "fixture delivery",
		criteria: [{ key: "c", outcome: "Criterion", verification: "test" }], tasks: [{ key: "t", outcome: "Task", covers: ["c"] }] });
	await f.execute({ operation: "start", expectedRevision: 1, taskId: "T-1" });
}
const evidence = (kind: "task" | "criterion" | "workset", id: string): NonNullable<RecordOperation["evidence"]> => ({ provenance: "agent_declared", subject: { kind, id }, checkIdentity: "fixture evidence", result: "pass" });
const finishSteps = (): BatchStep[] => [
	{ operation: "record", attemptId: "AT-1", attempt: { state: "reported", outcome: "already checked" }, evidence: evidence("task", "T-1") },
	{ operation: "assess", subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["$0.evidence"], rationale: "explicit task decision" },
	{ operation: "record", evidence: evidence("criterion", "AC-1") },
	{ operation: "assess", subject: { kind: "criterion", id: "AC-1" }, verdict: "accepted", evidenceIds: ["$2.evidence"], rationale: "explicit criterion decision" },
	{ operation: "record", evidence: evidence("workset", "WS-1") },
	{ operation: "close", outcome: "completed", reason: "explicit completion", deliveryEvidenceIds: ["$4.evidence"] },
];
function details(result: Awaited<ReturnType<ReturnType<typeof fixture>["execute"]>>) { return result.details as { ok: boolean; code?: string; message?: string; revision?: number; mapping?: Record<string, string> }; }

test("one batch replaces six mechanical calls with one durable commit and observer update", async () => {
	const f = fixture(); await open(f);
	let notices = 0;
	f.store.subscribe(() => notices++, () => assert.fail("observer"));
	const before = f.entries.length;
	const args: BatchOperation = { operation: "batch", expectedRevision: 2, steps: finishSteps() };
	const result = await f.execute({ ...args }, "call_batch|fc_example");
	assert.equal(details(result).ok, true);
	assert.equal(f.entries.length, before + 1);
	assert.equal(notices, 1);
	assert.equal(f.store.current()!.revision, 8, "each staged mutation retains its logical revision");
	assert.equal(f.store.current()!.workset.closeOutcome, "completed");
	assert.equal(details(result).mapping?.["$0.evidence"], "EV-1");
	assert.deepEqual(Object.keys(f.store.current()!.appliedCalls), ["host-1", "host-2", "call_batch|fc_example"]);
	assert.equal(Object.keys(f.store.current()!.decisions).length, 2, "both decisions were explicit inputs");
	const replay = createWorkflowStore({ append() { assert.fail("no append"); } });
	replay.replay(f.entries);
	assert.equal(replay.recovery(), undefined);
	assert.deepEqual(replay.current(), f.store.current());
	const repeated = await executeBatch(args, replay, clock, "call_batch|fc_example", async () => assert.fail("dedup before preparing"));
	assert.equal(repeated.ok, true);
	assert.equal(f.entries.length, before + 1);
});

test("late failures roll back allocations, attempts, evidence, judgments and observer effects", async () => {
	for (const bad of [
		{ operation: "close", outcome: "completed", reason: "missing delivery evidence", deliveryEvidenceIds: [] },
		{ operation: "assess", subject: { kind: "criterion", id: "AC-1" }, verdict: "accepted", evidenceIds: ["$0.evidence"], rationale: "wrong subject" },
		{ operation: "assess", subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["$9.evidence"], rationale: "forward reference" },
	]) {
		const f = fixture(); await open(f);
		const before = structuredClone(f.store.current());
		let notices = 0; f.store.subscribe(() => notices++, () => {});
		const result = await f.execute({ operation: "batch", expectedRevision: 2, steps: [finishSteps()[0], bad] });
		assert.equal(details(result).ok, false);
		assert.match(details(result).message!, /step 1/);
		assert.deepEqual(f.store.current(), before);
		assert.equal(f.entries.length, 2);
		assert.equal(notices, 0);
	}
});

test("batch refuses stale input, nested/control/mixed steps, nonfinal close and size limits", async () => {
	const f = fixture(); await open(f);
	const args = { operation: "batch", expectedRevision: 1, steps: finishSteps() };
	assert.equal(details(await f.execute(args)).code, "stale_revision");
	for (const step of [
		{ operation: "inspect" }, { operation: "batch", expectedRevision: 2, steps: [] },
		{ operation: "align", inputGeneration: 1, action: "confirm" },
		{ ...finishSteps()[0], expectedRevision: 2 }, { ...finishSteps()[0], alignInputGeneration: 1 },
	]) await assert.rejects(() => f.execute({ ...args, expectedRevision: 2, steps: [step] }), /Validation failed/);
	assert.equal(details(await f.execute({ ...args, expectedRevision: 2, steps: [finishSteps().at(-1), finishSteps()[0]] })).code, "invalid_payload");
	await assert.rejects(() => f.execute({ ...args, steps: [] }), /Validation failed/);
	await assert.rejects(() => f.execute({ ...args, steps: Array(17).fill(finishSteps()[0]) }), /Validation failed/);
	const large = { operation: "record", evidence: { ...evidence("workset", "WS-1"), artifactReferences: Array(32).fill("x".repeat(500)) } };
	assert.equal(details(await f.execute({ ...args, expectedRevision: 2, steps: Array(5).fill(large) })).code, "limit_exceeded");
	assert.equal(f.entries.length, 2);
});

test("append failure and cancellation leave the original committed state intact", async () => {
	for (const cancel of [false, true]) {
		const f = fixture(); await open(f);
		const before = structuredClone(f.store.current());
		const signal = new AbortController();
		if (cancel) signal.abort(); else f.failAppend();
		const result = await f.execute({ operation: "batch", expectedRevision: 2, steps: finishSteps() }, "batch-failure", signal.signal);
		assert.equal(details(result).code, "state_unavailable");
		assert.deepEqual(f.store.current(), before);
		assert.equal(f.entries.length, 2);
	}
});

test("owner changes including same-revision replay fence a transaction after async preparation", async () => {
	for (const replay of [false, true]) {
		const f = fixture(); await open(f);
		const result = await f.store.transact(2, clock, "batch-race", async (draft) => {
			const staged = draft.apply({ operation: "record", expectedRevision: 2, attemptId: "AT-1", attempt: { state: "reported", outcome: "staged" } }, clock, "draft");
			if (replay) f.store.replay(f.entries);
			else f.store.apply({ operation: "delivered", expectedRevision: 2 }, clock, "new-input");
			return staged;
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "stale_revision");
		assert.equal(f.store.current()!.attempts["AT-1"]!.state, "running");
	}
});

test("input and abort fences are rechecked after the final await, before commit", async () => {
	for (const abort of [false, true]) {
		const f = fixture(); await open(f);
		const before = structuredClone(f.store.current());
		let safe = true;
		const controller = new AbortController();
		const result = await f.store.transact(2, clock, "late-fence", async (draft) => {
			const staged = draft.apply({ operation: "record", expectedRevision: 2, attemptId: "AT-1", attempt: { state: "reported", outcome: "staged" } }, clock, "draft");
			queueMicrotask(() => { if (abort) controller.abort(); else safe = false; });
			return staged;
		}, controller.signal, () => safe);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "state_unavailable");
		assert.deepEqual(f.store.current(), before);
		assert.equal(f.entries.length, 2);
	}
});

test("start allocations resolve only in ID fields and never automatically accept a record", async () => {
	const f = fixture(); await open(f);
	await f.execute({ operation: "record", expectedRevision: 2, attemptId: "AT-1", attempt: { state: "failed", outcome: "previous attempt" } });
	const result = await f.execute({ operation: "batch", expectedRevision: 3, steps: [
		{ operation: "start", taskId: "T-1" },
		{ operation: "record", attemptId: "$0.attempt", attempt: { state: "reported", outcome: "literal $0.attempt, not a reference here" } },
	] });
	assert.equal(details(result).ok, true);
	assert.equal(details(result).mapping?.["$0.attempt"], "AT-2", details(result).message);
	assert.equal(f.store.current()!.attempts["AT-2"]!.outcome, "literal $0.attempt, not a reference here");
	assert.equal(f.store.current()!.tasks["T-1"]!.disposition, "awaiting_acceptance");
	assert.equal(Object.keys(f.store.current()!.decisions).length, 0);
});

test("batch retains real evidence provenance and pending-input fences", async () => {
	const f = fixture(); await open(f);
	const steps = [{ ...finishSteps()[0], evidence: { ...evidence("task", "T-1"), provenance: "host_observed" } }];
	assert.equal(details(await f.execute({ operation: "batch", expectedRevision: 2, steps })).code, "invalid_payload");
	f.unrecorded();
	assert.equal(details(await f.execute({ operation: "batch", expectedRevision: 2, steps: finishSteps() })).code, "state_unavailable");
	assert.equal(f.entries.length, 2);
});

test("batch cannot turn older observations or overlapping writers into accepted evidence", async () => {
	const old = fixture(); await open(old);
	old.observations.record({ toolCallId: "old-check", toolName: "bash", at: "2000-01-01T00:00:00.000Z", sessionId: clock.sessionId, isError: false, exitCode: 0 });
	const oldResult = await old.execute({ operation: "batch", expectedRevision: 2, steps: [{ ...finishSteps()[0], evidence: {
		...evidence("task", "T-1"), provenance: "host_observed", observationId: "old-check",
	} }] });
	assert.equal(details(oldResult).code, "invalid_payload");
	assert.match(details(oldResult).message!, /before attempt/);
	assert.equal(old.entries.length, 2);

	const writer = fixture(); await open(writer);
	await writer.execute({ operation: "amend", expectedRevision: 2, reason: "second writer", intentReference: "fixture", changes: [
		{ kind: "add_task", key: "writer", outcome: "Concurrent writer", covers: ["AC-1"], writeSurface: ["."] },
	] });
	await writer.execute({ operation: "start", expectedRevision: 3, taskId: "T-2" });
	const blocked = await writer.execute({ operation: "batch", expectedRevision: 4, steps: finishSteps().slice(0, 2) });
	assert.equal(details(blocked).code, "attempt_open");
	assert.match(details(blocked).message!, /overlapping/);
	assert.equal(writer.store.current()!.attempts["AT-1"]!.state, "running");
	assert.equal(writer.entries.length, 4);
});

test("batch rechecks filesystem freshness and does not commit a staged acceptance after drift", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "workflow-batch-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "input.txt"); await writeFile(path, "before");
	const f = fixture(); await open(f);
	await f.execute({ operation: "record", expectedRevision: 2, evidence: { ...evidence("criterion", "AC-1"), scope: [path] } });
	const before = structuredClone(f.store.current());
	await writeFile(path, "after");
	const result = await f.execute({ operation: "batch", expectedRevision: 3, steps: [
		finishSteps()[0], { operation: "assess", subject: { kind: "criterion", id: "AC-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "stale" },
	] });
	assert.equal(details(result).code, "evidence_required");
	assert.match(details(result).message!, /basis changed/);
	assert.deepEqual(f.store.current(), before);
});

test("transaction refuses unavailable recovery and aggregate acceptance-check overflow", async () => {
	const broken = fixture();
	broken.store.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: {} }]);
	assert.equal(details(await broken.execute({ operation: "batch", expectedRevision: 1, steps: finishSteps() })).code, "state_unavailable");
	const f = fixture(); await open(f);
	// Duplicate references still cost rechecks. Per-step arrays remain within the 32-item limit.
	const steps = [finishSteps()[0], ...Array.from({ length: 3 }, () => ({ operation: "assess", subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: Array(32).fill("$0.evidence"), rationale: "bounded" }))];
	const result = await f.execute({ operation: "batch", expectedRevision: 2, steps });
	assert.equal(details(result).code, "evidence_required");
	assert.match(details(result).message!, new RegExp(`${WORKFLOW_LIMITS.maxCompletionChecks} total`));
	assert.equal(f.entries.length, 2);
});
