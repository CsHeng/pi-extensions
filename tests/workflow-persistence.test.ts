import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { WORKFLOW_ENTRY_TYPE, WORKFLOW_LIMITS, type WorkflowOperation, type WorksetState } from "../extensions/workflow/contracts.ts";
import { applyOperation, validateState, type ReduceContext } from "../extensions/workflow/reducer.ts";
import { createWorkflowStore, type SessionEntryLike } from "../extensions/workflow/store.ts";
import { reconcileBranch } from "../extensions/workflow/branch.ts";
import workflowExtension from "./fixtures/workflow/legacy-extension.ts";
import {
	createHostHarness,
	createTrace,
	createTraceObserver,
	waitForTrace,
} from "./fixtures/workflow/host-fixture.ts";

const CLOCK: ReduceContext = { now: "2026-09-17T00:00:00.000Z", cwd: "/repo", sessionId: "session-1" };
const toolCalls = () => {
	let counter = 0;
	return () => `call-${++counter}`;
};
const nextCall = toolCalls();

function openOperation(overrides: Partial<Extract<WorkflowOperation, { operation: "open" }>> = {}): WorkflowOperation {
	return {
		operation: "open",
		expectedRevision: 0,
		goal: "Persist the workflow",
		deliveryEndpoint: "branch-replayed ledger",
		criteria: [{ key: "ledger", outcome: "Ledger replays", verification: "workflow-persistence tests" }],
		tasks: [{ key: "store", outcome: "Implement the store", covers: ["ledger"] }],
		...overrides,
	};
}

function appendOperation(state: WorksetState): WorkflowOperation {
	return {
		operation: "record",
		expectedRevision: state.revision,
		evidence: {
			provenance: "host_observed",
			subject: { kind: "workset", id: state.workset.id },
			fingerprint: "fp-delivery",
			fingerprintState: "current",
			checkIdentity: "delivery check",
			result: "pass",
		},
	};
}

function snapshotEntries(entries: Array<{ customType: string; data: unknown }>): SessionEntryLike[] {
	return entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data }));
}

test("committed mutations append one bounded snapshot and replay identically", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const opened = store.apply(openOperation(), CLOCK, nextCall());
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	assert.equal(written.length, 1);
	assert.equal(written[0]!.customType, WORKFLOW_ENTRY_TYPE);
	const recorded = store.apply(appendOperation(opened.state), CLOCK, nextCall());
	assert.equal(recorded.ok, true);
	if (!recorded.ok) return;
	assert.equal(written.length, 2);
	assert.equal(written[1]!.data && (written[1]!.data as { revision: number }).revision, 2);

	const replayed = createWorkflowStore({ append: () => assert.fail("replay must not append") });
	replayed.replay(snapshotEntries(written));
	assert.equal(replayed.recovery(), undefined);
	assert.deepEqual(replayed.current(), store.current());
	assert.equal(validateState(replayed.current()!), undefined);
	assert.equal(replayed.current()!.evidence["EV-1"]!.subject.kind, "workset");
});

test("opaque provider call IDs survive JSON replay and retain exact deduplication", () => {
	const ids = ["call_example|fc_example", `call_long|${"a+/=".repeat(150)}`, "__proto__", "constructor"];
	for (const id of ids) {
		const written: Array<{ customType: string; data: unknown }> = [];
		const sink = { append: (customType: string, data: unknown) => written.push({ customType, data: JSON.parse(JSON.stringify(data)) }) };
		const store = createWorkflowStore(sink);
		assert.equal(store.apply(openOperation(), CLOCK, id).ok, true);
		const replayed = createWorkflowStore(sink);
		replayed.replay(snapshotEntries(written));
		assert.equal(replayed.recovery(), undefined);
		assert.deepEqual(replayed.current(), store.current());
		assert.equal(replayed.current()!.appliedCalls[id], 1);
		const repeated = replayed.apply(openOperation(), CLOCK, id);
		assert.equal(repeated.ok, true);
		assert.equal(written.length, 1, "replay preserves deduplication without rewriting old snapshots");
		assert.equal(replayed.apply({ operation: "start", expectedRevision: 1, taskId: "T-1" }, CLOCK, `${id}:next`).ok, true);
		replayed.replay(snapshotEntries(written));
		assert.equal(replayed.recovery(), undefined);
		assert.equal(replayed.current()!.attempts["AT-1"]?.state, "running");
	}
});

test("invalid call indexes are refused before append and on replay", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const refused = store.apply(openOperation(), CLOCK, "");
	assert.equal(refused.ok, false);
	assert.equal(written.length, 0);
	assert.equal(store.current(), undefined);
	assert.equal(store.apply(openOperation(), CLOCK, "valid-call").ok, true);
	const snapshot = written[0]!.data as { state: WorksetState };
	for (const appliedCalls of [
		{ "": 1 }, { call: 0 }, { call: -1 }, { call: 2 }, { call: 1.5 },
		Object.fromEntries(Array.from({ length: WORKFLOW_LIMITS.maxAppliedCalls + 1 }, (_, i) => [`call-${i}`, 1])),
	]) {
		const replayed = createWorkflowStore({ append: () => assert.fail("no append") });
		replayed.replay([...snapshotEntries(written), { type: "custom", customType: WORKFLOW_ENTRY_TYPE,
			data: { ...snapshot, state: { ...snapshot.state, appliedCalls } } }]);
		assert.equal(replayed.current(), undefined, "never fall back to the valid snapshot");
		assert.match(replayed.recovery() ?? "", /invalid applied-call index/);
		for (const operation of [{ operation: "inspect" } as const, openOperation()]) {
			const result = replayed.apply(operation, CLOCK, "later-call");
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.code, "state_unavailable");
				assert.match(result.message, /Do not retry ledger operations/);
				assert.match(result.message, /Continue the user's task without workflow bookkeeping/);
			}
		}
	}
});

test("opaque call IDs remain bounded by the snapshot and call-index budgets", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const oversized = store.apply(openOperation(), CLOCK, "x".repeat(WORKFLOW_LIMITS.maxSnapshotBytes));
	assert.equal(oversized.ok, false);
	if (!oversized.ok) assert.equal(oversized.code, "snapshot_limit");
	assert.equal(written.length, 0);
	assert.equal(store.current(), undefined);
	assert.equal(store.apply(openOperation(), CLOCK, "call_open|fc_open").ok, true);
	for (let i = 0; i < WORKFLOW_LIMITS.maxAppliedCalls; i += 1) {
		assert.equal(store.apply({ operation: "record", expectedRevision: store.current()!.revision,
			evidence: { provenance: "agent_declared", subject: { kind: "workset", id: "WS-1" }, checkIdentity: "probe", result: "unknown" },
		}, CLOCK, `call_${i}|fc_${i}`).ok, true);
	}
	assert.equal(Object.keys(store.current()!.appliedCalls).length, WORKFLOW_LIMITS.maxAppliedCalls);
	assert.equal(Object.hasOwn(store.current()!.appliedCalls, "call_open|fc_open"), false);
	const replayed = createWorkflowStore({ append: () => assert.fail("no append") });
	replayed.replay(snapshotEntries(written));
	assert.equal(replayed.recovery(), undefined);
	assert.deepEqual(replayed.current(), store.current());
});

test("a repeated host tool call is deduplicated and never appends twice", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const first = store.apply(openOperation(), CLOCK, "same-call");
	assert.equal(first.ok, true);
	const second = store.apply(openOperation(), CLOCK, "same-call");
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.match(second.notice ?? "", /already applied/);
	assert.equal(written.length, 1);
	assert.equal(second.state.revision, 1);
});

test("an invalid latest snapshot disables mutation without falling back to an older one", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const opened = store.apply(openOperation(), CLOCK, nextCall());
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	const corrupt: SessionEntryLike[] = [
		...snapshotEntries(written),
		{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: { schemaVersion: 99, revision: 2, state: opened.state } },
	];
	const replayed = createWorkflowStore({ append: () => assert.fail("no append") });
	replayed.replay(corrupt);
	assert.equal(replayed.current(), undefined);
	assert.match(replayed.recovery() ?? "", /unsupported workflow schema 99/);
	const blocked = replayed.apply(openOperation({ goal: "Blocked" }), CLOCK, nextCall());
	assert.equal(blocked.ok, false);
	if (!blocked.ok) assert.equal(blocked.code, "state_unavailable");

	const mismatched = createWorkflowStore({ append: () => assert.fail("no append") });
	mismatched.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: { schemaVersion: 1, revision: 7, at: CLOCK.now, transition: "x", state: opened.state } }]);
	assert.equal(mismatched.current(), undefined);
	assert.match(mismatched.recovery() ?? "", /does not match state revision/);

	const brokenState = structuredClone(opened.state);
	brokenState.tasks["T-1"]!.dependsOn = ["T-404"];
	const broken = createWorkflowStore({ append: () => assert.fail("no append") });
	broken.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: { schemaVersion: 1, revision: opened.state.revision, at: CLOCK.now, transition: "x", state: brokenState } }]);
	assert.equal(broken.current(), undefined);
	assert.match(broken.recovery() ?? "", /references unknown dependency/);
});

test("a failed append leaves the previous committed state installed", () => {
	let failNext = false;
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({
		append: (customType, data) => {
			if (failNext) throw new Error("disk full");
			written.push({ customType, data });
		},
	});
	const opened = store.apply(openOperation(), CLOCK, nextCall());
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	failNext = true;
	const failed = store.apply(appendOperation(opened.state), CLOCK, nextCall());
	assert.equal(failed.ok, false);
	if (!failed.ok) assert.equal(failed.code, "state_unavailable");
	assert.equal(store.current()!.revision, 1);
	assert.equal(store.current()!.evidence["EV-1"], undefined);
});

test("an over-limit snapshot is rejected without partial state", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	let serialized = 0;
	const store = createWorkflowStore({
		append: (customType, data) => {
			written.push({ customType, data });
			serialized = Buffer.byteLength(JSON.stringify(data));
		},
	});
	let state = store.current();
	const opened = store.apply(openOperation(), CLOCK, nextCall());
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	state = opened.state;
	const artifact = "x".repeat(WORKFLOW_LIMITS.maxArtifactReference);
	for (let index = 0; index < 40; index += 1) {
		const result = store.apply({
			operation: "record",
			expectedRevision: state!.revision,
			evidence: {
				provenance: "agent_declared",
				subject: { kind: "workset", id: state!.workset.id },
				fingerprint: `fp-${index}`,
				fingerprintState: "current",
				checkIdentity: "large artifact retention",
				result: "pass",
				artifactReferences: Array.from({ length: 32 }, () => artifact),
			},
		}, CLOCK, nextCall());
		if (!result.ok) {
			assert.equal(result.code, "snapshot_limit");
			assert.equal(store.current()!.revision, state!.revision);
			assert.ok(serialized <= WORKFLOW_LIMITS.maxSnapshotBytes);
			return;
		}
		state = result.state;
	}
	assert.fail("expected the snapshot limit to reject a large evidence history");
});

test("a malformed latest snapshot disables mutation instead of falling back", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const opened = store.apply(openOperation(), CLOCK, nextCall());
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	const snapshot = written.at(-1)!.data as { state: WorksetState };
	const variants: Array<[unknown, string]> = [
		[{ ...(written.at(-1)!.data as object), state: { ...snapshot.state, tasks: undefined } }, "missing tasks"],
		[{ ...(written.at(-1)!.data as object), state: { ...snapshot.state, evidence: null } }, "null evidence"],
		[{ ...(written.at(-1)!.data as object), state: { ...snapshot.state, next: { ...snapshot.state.next, task: "x" } } }, "invalid counter"],
	];
	for (const [data, note] of variants) {
		const replayed = createWorkflowStore({ append: () => assert.fail("no append") });
		assert.doesNotThrow(() => replayed.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data }]), note);
		assert.equal(replayed.current(), undefined, note);
		assert.match(replayed.recovery() ?? "", /missing|invalid/, note);
		const refused = replayed.apply(openOperation(), CLOCK, nextCall());
		assert.equal(refused.ok, false, note);
		if (refused.ok) return;
		assert.equal(refused.code, "state_unavailable", note);
	}
});

test("branch reconciliation persists one transition for copied running attempts", () => {
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const opened = store.apply(openOperation(), CLOCK, nextCall());
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	const started = store.apply({ operation: "start", expectedRevision: opened.state.revision, taskId: "T-1" }, CLOCK, nextCall());
	assert.equal(started.ok, true);
	if (!started.ok) return;
	const before = written.length;
	const reconciled = reconcileBranch(store, { reason: "fork", align: true, now: CLOCK.now });
	assert.equal(reconciled?.ok, true);
	assert.equal(written.length, before + 1, "reconciliation commits exactly one snapshot");
	assert.equal(store.current()!.workset.alignment.state, "needs_alignment");
	assert.deepEqual(Object.values(store.current()!.attempts).map((attempt) => attempt.state), ["interrupted"]);
	assert.equal(reconcileBranch(store, { reason: "fork", align: true, now: CLOCK.now }), undefined, "a reconciled branch has nothing left to reconcile");
});

test("a forked session reconciles copied state and requires re-alignment", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)], realSessionFile: true });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", {
			operation: "open",
			expectedRevision: 0,
			goal: "Forked workflow",
			deliveryEndpoint: "reconciled branch",
			criteria: [{ key: "ledger", outcome: "Ledger persists", verification: "replay" }],
			tasks: [{ key: "store", outcome: "Persist", covers: ["ledger"], writeSurface: ["src"] }],
		} as unknown as JsonObject)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: 1, taskId: "T-1" } as unknown as JsonObject)),
		fauxAssistantMessage("running"),
	]);
	await harness.session.prompt("open and start");
	await waitForTrace(trace, (entry) => entry.event === "tool_end" && entry.detail?.toolName === "csheng_workflow" && entry.detail?.isError === false);
	const file = harness.session.sessionFile;
	assert.ok(file);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const forkedManager = SessionManager.forkFrom(file, harness.workDir, harness.sessionDir);
	const forked = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)], sessionManager: forkedManager, sessionStartReason: "fork" });
	t.after(() => forked.dispose());
	const replayed = createWorkflowStore({ append: () => assert.fail("no append") });
	replayed.replay(forkedManager.getBranch());
	assert.equal(replayed.recovery(), undefined);
	const state = replayed.current()!;
	assert.equal(state.workset.alignment.state, "needs_alignment", "a fork is historical intent, not authorization");
	assert.equal(state.workset.inputGeneration, 1);
	assert.deepEqual(Object.values(state.attempts).map((attempt) => attempt.state), ["interrupted"]);
	assert.equal(state.tasks["T-1"]!.disposition, "pending");
});

test("the real host executes the workflow tool and persists a replayable branch entry", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ mode: "print", trace, extensions: [workflowExtension, createTraceObserver(trace)], realSessionFile: true });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", {
			operation: "open",
			expectedRevision: 0,
			goal: "Host-level workflow",
			deliveryEndpoint: "tool result and branch entry",
			criteria: [{ key: "ledger", outcome: "Ledger persists", verification: "branch replay" }],
			tasks: [{ key: "store", outcome: "Persist the ledger", covers: ["ledger"] }],
		} as unknown as JsonObject)),
		fauxAssistantMessage("opened"),
	]);
	await harness.session.prompt("open the workset");
	await waitForTrace(trace, (entry) => entry.event === "tool_end" && entry.detail?.toolName === "csheng_workflow");

	const toolResult = harness.session.state.messages.find((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "csheng_workflow") as { isError?: boolean; details?: { ok?: boolean; revision?: number } } | undefined;
	assert.ok(toolResult);
	assert.equal(toolResult.isError, false);
	assert.equal(toolResult.details?.ok, true);
	assert.equal(toolResult.details?.revision, 1);

	const branch = harness.session.sessionManager.getBranch();
	const persisted = branch.filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_ENTRY_TYPE);
	const transitions = persisted.map((entry) => String((entry as { data?: { transition?: string } }).data?.transition));
	assert.equal(transitions.filter((transition) => transition.startsWith("tool:")).length, 1, "the open committed one tool transition");
	assert.equal(transitions.filter((transition) => transition.startsWith("review-blocked")).length, 1, "the headless settlement recorded one mode-unsupported review decision");
	const replayed = createWorkflowStore({ append: () => assert.fail("no append") });
	replayed.replay(branch);
	assert.equal(replayed.recovery(), undefined);
	assert.equal(replayed.current()!.workset.goal, "Host-level workflow");
	assert.equal(replayed.current()!.tasks["T-1"]!.disposition, "pending");

	// A copied fork prefix replays as historical intent, not as a new execution.
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const file = harness.session.sessionFile;
	assert.ok(file);
	const forked = SessionManager.forkFrom(file, harness.workDir, harness.sessionDir);
	const forkedStore = createWorkflowStore({ append: () => assert.fail("no append") });
	forkedStore.replay(forked.getBranch());
	assert.equal(forkedStore.recovery(), undefined);
	assert.equal(forkedStore.current()!.workset.goal, "Host-level workflow");
});

test("the real host resumes a disk session with a Responses call ID and restores its original goal", async (t) => {
	const harness = await createHostHarness({ mode: "print", extensions: [workflowExtension], realSessionFile: true });
	t.after(() => harness.dispose());
	const callId = `call_resume|fc_${"a+/=".repeat(100)}`;
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", openOperation() as unknown as JsonObject, { id: callId })),
		fauxAssistantMessage("opened"),
	]);
	await harness.session.prompt("open the workset");
	const file = harness.session.sessionFile;
	assert.ok(file);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const resumeDir = await mkdtemp(join(tmpdir(), "workflow-resume-"));
	t.after(() => rm(resumeDir, { recursive: true, force: true }));
	const resumeFile = join(resumeDir, "session.jsonl");
	await copyFile(file, resumeFile);
	await harness.dispose();
	const manager = SessionManager.open(resumeFile, resumeDir, resumeDir);
	const before = createWorkflowStore({ append: () => assert.fail("no append") });
	before.replay(manager.getBranch());
	assert.equal(before.recovery(), undefined);
	assert.equal(before.current()!.appliedCalls[callId], 1);
	const resumed = await createHostHarness({ mode: "print", extensions: [workflowExtension], sessionManager: manager, sessionStartReason: "resume" });
	t.after(() => resumed.dispose());
	resumed.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "inspect" })),
		fauxAssistantMessage("continue the original task"),
	]);
	await resumed.session.prompt("continue");
	const result = resumed.session.state.messages.findLast((message) => message.role === "toolResult"
		&& message.toolName === "csheng_workflow") as { isError?: boolean; details?: { ok?: boolean; workflow?: { workset?: { goal?: string } } } };
	assert.equal(result.isError, false);
	assert.equal(result.details?.ok, true);
	assert.equal(result.details?.workflow?.workset?.goal, "Persist the workflow");
	assert.deepEqual(harness.errors, []);
	assert.deepEqual(resumed.errors, []);
});

test("the real host reports typed workflow failures as tool errors", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "inspect" } as unknown as JsonObject)),
		fauxAssistantMessage("no workset yet"),
	]);
	await harness.session.prompt("inspect");
	await waitForTrace(trace, (entry) => entry.event === "tool_end" && entry.detail?.toolName === "csheng_workflow");
	const toolResult = harness.session.state.messages.find((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "csheng_workflow") as { isError?: boolean; details?: { ok?: boolean; code?: string } } | undefined;
	assert.ok(toolResult);
	assert.equal(toolResult.isError, true);
	assert.equal(toolResult.details?.ok, false);
	assert.equal(toolResult.details?.code, "no_workset");
});
