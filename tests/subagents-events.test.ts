import assert from "node:assert/strict";
import test from "node:test";
import {
	CANCEL_RECEIPT_EVENT,
	CANCEL_REQUEST_EVENT,
	EVENT_PROTOCOL_VERSION,
	SNAPSHOT_EVENT,
	parseCancelReceipt,
	parseCancelRequest,
	parseSnapshot,
	type SnapshotV1,
} from "../extensions/subagents/events.ts";

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: EVENT_PROTOCOL_VERSION,
		runId: "run-1",
		phase: "running",
		requestedTasks: 2,
		admittedTasks: 2,
		launchedChildren: 1,
		activeChildren: 1,
		settledTasks: 0,
		aggregateAssistantTurns: 3,
		elapsedMs: 1500,
		peakConcurrency: 1,
		cancellationRequested: false,
		tasks: [{
			id: "scan",
			ordinal: 1,
			role: "explorer",
			status: "running",
			executionPhase: "child-execution",
			assistantTurns: 3,
			elapsedMs: 1400,
			inactiveForMs: 20,
			activeTools: ["read"],
			errorCount: 0,
			cancellationRequested: false,
		}],
		...overrides,
	};
}

test("event names and protocol version are exact", () => {
	assert.equal(SNAPSHOT_EVENT, "csheng.subagents.snapshot.v1");
	assert.equal(CANCEL_REQUEST_EVENT, "csheng.subagents.cancel.request.v1");
	assert.equal(CANCEL_RECEIPT_EVENT, "csheng.subagents.cancel.receipt.v1");
	assert.equal(EVENT_PROTOCOL_VERSION, 1);
});

test("snapshots accept bounded activity and reject unsafe or impossible shapes", () => {
	const parsed = parseSnapshot(snapshot());
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const value: SnapshotV1 = parsed.value;
	assert.equal(value.tasks[0]?.id, "scan");
	assert.equal(value.tasks[0]?.activeTools[0], "read");
	assert.equal(parseSnapshot(snapshot({ version: 2 })).ok, false);
	assert.equal(parseSnapshot(snapshot({ prompt: "SECRET" })).ok, false);
	assert.equal(parseSnapshot(snapshot({ objective: "SECRET" })).ok, false);
	assert.equal(parseSnapshot(snapshot({ admittedTasks: 3 })).ok, false);
	assert.equal(parseSnapshot(snapshot({ elapsedMs: Number.NaN })).ok, false);
	assert.equal(parseSnapshot(snapshot({ elapsedMs: -1 })).ok, false);
	assert.equal(parseSnapshot(snapshot({
		tasks: Array.from({ length: 11 }, (_, index) => ({
			id: `t${index}`,
			ordinal: index + 1,
			role: "explorer",
			status: "pending",
			executionPhase: "queued",
			assistantTurns: 0,
			elapsedMs: 0,
			inactiveForMs: 0,
			activeTools: [],
			errorCount: 0,
			cancellationRequested: false,
		})),
		requestedTasks: 11,
		admittedTasks: 11,
	})).ok, false);
	assert.equal(parseSnapshot(snapshot({
		tasks: [{
			id: "scan",
			ordinal: 1,
			role: "explorer",
			status: "running",
			executionPhase: "child-execution",
			assistantTurns: 1,
			elapsedMs: 1,
			inactiveForMs: 0,
			activeTools: ["bash"],
			errorCount: 0,
			cancellationRequested: false,
		}],
	})).ok, false);
	assert.equal(parseSnapshot(snapshot({
		tasks: [{
			id: "../escape",
			ordinal: 1,
			role: "explorer",
			status: "pending",
			executionPhase: "queued",
			assistantTurns: 0,
			elapsedMs: 0,
			inactiveForMs: 0,
			activeTools: [],
			errorCount: 0,
			cancellationRequested: false,
		}],
	})).ok, false);
});

test("cancel requests and receipts stay closed and id-bounded", () => {
	assert.deepEqual(parseCancelRequest({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "run",
	}), { ok: true, value: { version: 1, requestId: "req-1", runId: "run-1", target: "run" } });
	assert.equal(parseCancelRequest({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "task",
		taskId: "scan",
	}).ok, true);
	assert.equal(parseCancelRequest({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "run",
		taskId: "scan",
	}).ok, false);
	assert.equal(parseCancelRequest({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "task",
	}).ok, false);
	assert.equal(parseCancelRequest({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "run",
		message: "steer",
	}).ok, false);
	assert.equal(parseCancelReceipt({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "task",
		taskId: "scan",
		outcome: "too-late",
	}).ok, true);
	assert.equal(parseCancelReceipt({
		version: 1,
		requestId: "req-1",
		runId: "run-1",
		target: "run",
		outcome: "settled",
	}).ok, false);
});
