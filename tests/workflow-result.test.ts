import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyOperation, buildView } from "../extensions/workflow/reducer.ts";
import { renderMutationResult } from "../extensions/workflow/result.ts";
import { registerWorkflowTool, renderWorkflowView } from "../extensions/workflow/tool.ts";
import { createWorkflowStore } from "../extensions/workflow/store.ts";
import { createObservationIndex } from "../extensions/workflow/observation.ts";
import type { WorkflowOperation, WorksetState } from "../extensions/workflow/contracts.ts";
const clock = { now: "2026-09-19T00:00:00.000Z", cwd: process.cwd(), sessionId: "result-test" };
const op = (state: WorksetState | undefined, operation: WorkflowOperation) => {
	const result = applyOperation(state, operation, clock);
	assert.equal(result.ok, true, !result.ok ? result.message : "");
	return result;
};
function opened(count = 3) {
	return op(undefined, { operation: "open", expectedRevision: 0, goal: "Long goal that should not be replayed in mutation receipts", deliveryEndpoint: "Read-only report",
		criteria: [{ key: "c", outcome: "Historical criterion outcome", verification: "test" }],
		tasks: Array.from({ length: count }, (_, i) => ({ key: `t${i}`, outcome: `Historical task outcome ${i}`, covers: ["c"] })) });
}

test("compact receipts identify allocations without repeating goals or unchanged history", () => {
	const open = opened();
	const first = renderMutationResult("open", undefined, open);
	assert.match(first, /allocated ids: c=AC-1, t0=T-1/);
	assert.doesNotMatch(first, /Long goal|Historical/);
	const start = op(open.state, { operation: "start", expectedRevision: 1, taskId: "T-1" });
	assert.match(renderMutationResult("start", open.state, start), /AT-1 running/);
	const record = op(start.state, { operation: "record", expectedRevision: 2, attemptId: "AT-1", attempt: { state: "reported", outcome: "check complete" }, evidence: {
		provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "historical evidence identity", result: "pass", fingerprint: "fixture", fingerprintState: "current",
	} });
	const receipt = renderMutationResult("record", start.state, record);
	assert.match(receipt, /EV-1 task:T-1 pass\/current/);
	assert.match(receipt, /awaiting_acceptance/);
	assert.doesNotMatch(receipt, /Historical|historical evidence|T-2|T-3/);
	const assessed = op(record.state, { operation: "assess", expectedRevision: 3, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "explicit" });
	assert.doesNotMatch(renderMutationResult("assess", record.state, assessed), /EV-1/);
});

test("mutation output has bounded overflow and savings grow with retained task history", () => {
	for (const count of [3, 32, 64]) {
		const open = opened(count);
		const start = op(open.state, { operation: "start", expectedRevision: 1, taskId: "T-1" });
		const compact = renderMutationResult("start", open.state, start);
		const full = renderWorkflowView(start.view);
		assert.ok(compact.length < full.length * 0.4, `${count} tasks: ${compact.length}/${full.length}`);
		assert.ok(compact.length < 250);
		if (count > 12) {
			const overflow = renderMutationResult("open", undefined, open);
			assert.match(overflow, /more \(inspect\)/);
			assert.ok(overflow.length < 1500);
		}
	}
});

test("changed evidence freshness and task revisions remain visible without full records", () => {
	const open = opened();
	const evidence = op(open.state, { operation: "record", expectedRevision: 1, evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "check", result: "pass", fingerprint: "old", fingerprintState: "current" } });
	const stale = op(evidence.state, { operation: "refresh", expectedRevision: 2, fingerprints: { "EV-1": "new" } });
	assert.match(renderMutationResult("refresh", evidence.state, stale), /EV-1 task:T-1 pass\/stale/);
	const amended = op(stale.state, { operation: "amend", expectedRevision: 3, reason: "changed intent", intentReference: "user", changes: [{ kind: "update_task", id: "T-1", outcome: "new scope" }] });
	assert.match(renderMutationResult("amend", stale.state, amended), /T-1 r2/);
});

test("failures show actionable errors and actual committed revision, never a speculative view", () => {
	const open = opened(64);
	const failure = { ok: false as const, code: "snapshot_limit" as const, message: "Nothing was appended.", view: { ...open.view, revision: 999 } };
	const receipt = renderMutationResult("record", open.state, failure);
	assert.match(receipt, /snapshot_limit at revision 1: Nothing was appended/);
	assert.doesNotMatch(receipt, /999|Historical|goal|T-64/);
	const recovery = renderMutationResult("inspect", undefined, { ok: false, code: "state_unavailable", message: "Continue the user's task without workflow bookkeeping; repair only if requested." });
	assert.match(recovery, /Continue the user's task/);
	assert.ok(renderMutationResult("batch", open.state, { ...failure, message: "x".repeat(10000) }).length < 2600);
});

test("registered tool keeps full inspect and host details while shrinking success and rejection content", async () => {
	const store = createWorkflowStore({ append() {} });
	let tool: ToolDefinition | undefined;
	registerWorkflowTool({ registerTool(t: ToolDefinition) { tool = t; }, on() {} } as unknown as ExtensionAPI, store, createObservationIndex());
	const open = opened(32);
	store.replay([{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 1, revision: 1, state: open.state } }]);
	const ctx = { cwd: clock.cwd, sessionManager: { getSessionId: () => clock.sessionId } } as ExtensionContext;
	const result = await tool!.execute("start", { operation: "start", expectedRevision: 1, taskId: "T-1" }, undefined, undefined, ctx);
	const content = (result.content[0] as { text: string }).text;
	assert.doesNotMatch(content, /Historical|Long goal/);
	assert.deepEqual((result.details as { workflow: unknown }).workflow, buildView(store.current()!));
	const inspect = await tool!.execute("inspect", { operation: "inspect" }, undefined, undefined, ctx);
	assert.match((inspect.content[0] as { text: string }).text, /Long goal|Historical/);
	const failure = await tool!.execute("stale", { operation: "start", expectedRevision: 1, taskId: "T-2" }, undefined, undefined, ctx);
	assert.match((failure.content[0] as { text: string }).text, /stale_revision at revision 2/);
	assert.doesNotMatch((failure.content[0] as { text: string }).text, /Historical|criterion/);
	assert.equal((failure.details as { workflow: { tasks: unknown[] } }).workflow.tasks.length, 32);
});
