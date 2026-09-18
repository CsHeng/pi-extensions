import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MANAGED_SESSION_TOOL_NAME, createObservationIndex, summarizeHostObservation } from "../extensions/workflow/observation.ts";
import { FINGERPRINT_LIMITS, fingerprintScope } from "../extensions/workflow/fingerprints.ts";
import { createWorkflowStore } from "../extensions/workflow/store.ts";
import { prepareOperation } from "../extensions/workflow/tool.ts";
import workflowExtension from "./fixtures/workflow/legacy-extension.ts";
import {
	createHostHarness,
	createTrace,
	createTraceObserver,
	waitForTrace,
} from "./fixtures/workflow/host-fixture.ts";

const envelope = (action: "create" | "inspect" | "apply", candidateStatus: string) => ({
	schemaVersion: 2,
	action,
	status: "succeeded",
	sessions: [{
		handle: "sess_x",
		role: "worker",
		episode: 1,
		state: "idle",
		reportComplete: true,
		candidate: { id: "cand_1", episode: 1, status: candidateStatus, changedPaths: ["src/a.ts"], appliedPaths: candidateStatus === "applied" ? ["src/a.ts"] : [] },
	}],
});

function workspaceScenario(): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: MANAGED_SESSION_TOOL_NAME,
			label: "Managed sessions",
			description: "Fixture stub returning public managed result envelopes.",
			parameters: Type.Object({ action: Type.String() }, { additionalProperties: true }),
			async execute(_toolCallId, params) {
				if (params.action === "apply") return { content: [{ type: "text" as const, text: "applied" }], details: envelope("apply", "applied") };
				if (params.action === "inspect") return { content: [{ type: "text" as const, text: "inspected" }], details: envelope("inspect", "not-applied") };
				return { content: [{ type: "text" as const, text: "created" }], details: envelope("create", "not-applied") };
			},
		});
	};
}

/** Rewrites a tracked file after a chosen csheng_workflow tool call, inside one model turn. */
function driftWriter(file: () => string, afterCall: number): ExtensionFactory {
	return (pi) => {
		let seen = 0;
		pi.on("tool_execution_end", async (event) => {
			if (event.toolName !== "csheng_workflow") return;
			seen += 1;
			if (seen === afterCall) await writeFile(file(), "export const a = 2;\n");
		});
	};
}

const workflowResult = (harness: { session: { state: { messages: Array<{ role: string; toolName?: string }> } } }, toolCallId: string) =>
	harness.session.state.messages.find((message) => message.role === "toolResult" && (message as { toolCallId?: string }).toolCallId === toolCallId) as
		| { isError?: boolean; details?: { ok?: boolean; revision?: number; code?: string; workflow?: { revision: number; workset: { id: string; disposition: string; closeOutcome?: string }; evidence: Array<{ id: string; provenance: string; freshness: string; result: string; identity: string }>; tasks: Array<{ id: string; disposition: string }> } } }
		| undefined;

test("fingerprints bind a scope to content and refuse incomplete scans", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-fingerprint-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
	await writeFile(join(root, "package-lock.json"), "{}\n");

	const first = await fingerprintScope(["src", "package-lock.json"], root);
	assert.equal(first.state, "current");
	assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
	const same = await fingerprintScope(["src", "package-lock.json"], root);
	assert.equal(same.fingerprint, first.fingerprint);
	const reverse = await fingerprintScope(["package-lock.json", "src"], root);
	assert.equal(reverse.fingerprint, first.fingerprint, "declared order does not change the digest");

	await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
	const changed = await fingerprintScope(["src"], root);
	assert.notEqual(changed.fingerprint, first.fingerprint);
	await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
	assert.notEqual((await fingerprintScope(["src"], root)).fingerprint, changed.fingerprint);

	const missing = await fingerprintScope(["does/not/exist.ts"], root);
	assert.equal(missing.state, "current", "a declared missing input is part of the basis");
	assert.notEqual(missing.fingerprint, first.fingerprint);

	const empty = await fingerprintScope([], root);
	assert.equal(empty.scope[0], ".");
	assert.match(empty.fingerprint, /^[0-9a-f]{64}$/);

	await mkdir(join(root, ".git"), { recursive: true });
	await writeFile(join(root, ".git", "index"), "vcs internals\n");
	await mkdir(join(root, "node_modules"), { recursive: true });
	await writeFile(join(root, "node_modules", "dep.js"), "dependency\n");
	const withInternals = await fingerprintScope(["src"], root);
	assert.equal(withInternals.fingerprint, (await fingerprintScope(["src"], root)).fingerprint);
	assert.equal((await fingerprintScope(["."], root)).state, "current");

	let nested = root;
	for (let depth = 0; depth < FINGERPRINT_LIMITS.maxDepth + 2; depth += 1) nested = join(nested, "d");
	await mkdir(nested, { recursive: true });
	const deep = await fingerprintScope(["."], root);
	assert.equal(deep.state, "unavailable");
	assert.match(deep.note ?? "", /depth limit/);
});

test("the observation index keeps bounded public transport facts only", () => {
	const index = createObservationIndex();
	const observation = summarizeHostObservation({
		toolCallId: "call-create",
		toolName: MANAGED_SESSION_TOOL_NAME,
		isError: false,
		result: { details: envelope("create", "not-applied") },
	});
	index.record(observation);
	assert.equal(index.get("call-create")?.managed?.action, "create");
	assert.equal(index.get("call-create")?.managed?.sessions[0]?.candidate?.changedPaths, 1);
	assert.equal(index.findManaged({ handle: "sess_x", episode: 1 })?.session.candidate?.id, "cand_1");
	assert.equal(index.findManaged({ handle: "sess_x", episode: 1, candidateId: "cand_other" }), undefined);
	assert.equal(index.findManaged({ handle: "ghost", episode: 1 }), undefined);

	const bash = summarizeHostObservation({ toolCallId: "call-bash", toolName: "bash", isError: false, result: { details: { exitCode: 1 } } });
	assert.equal(bash.exitCode, 1);
	assert.equal(bash.managed, undefined);
	const unparsed = summarizeHostObservation({ toolCallId: "call-write", toolName: "write", isError: true, result: { details: { path: "/tmp/x", bytes: 10 } } });
	assert.equal(unparsed.managed, undefined);
	assert.equal(unparsed.exitCode, undefined);

	for (let step = 0; step < 300; step += 1) index.record(summarizeHostObservation({ toolCallId: `call-${step}`, toolName: "read", isError: false, result: { details: {} } }));
	assert.equal(index.size(), 256);
	assert.equal(index.get("call-0"), undefined);
	assert.ok(index.get("call-299"));
});

test("managed binding, apply status and basis changes drive evidence freshness", async (t) => {
	const calls: string[] = [];
	const scenario = (pi: ExtensionAPI) => {
		workspaceScenario()(pi);
	};
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, scenario, createTraceObserver(trace)], realSessionFile: true });
	t.after(() => harness.dispose());
	await mkdir(join(harness.workDir, "src"), { recursive: true });
	await writeFile(join(harness.workDir, "src", "a.ts"), "export const a = 1;\n");

	const scripted = (id: string, name: string, args: Record<string, unknown>, text: string) => fauxAssistantMessage(fauxToolCall(name, args as never, { id }));
	harness.faux.setResponses([
		scripted("call-open", "csheng_workflow", { operation: "open", expectedRevision: 0, goal: "Managed evidence", deliveryEndpoint: "released source", criteria: [{ key: "c", outcome: "Criterion met", verification: "check" }], tasks: [{ key: "t", outcome: "Do the work", covers: ["c"], writeSurface: ["src"] }] }, "opened"),
		scripted("call-start", "csheng_workflow", { operation: "start", expectedRevision: 1, taskId: "T-1", basis: { scope: ["src"] } }, "started"),
		scripted("call-create", MANAGED_SESSION_TOOL_NAME, { action: "create" }, "created"),
		scripted("call-report", "csheng_workflow", { operation: "record", expectedRevision: 2, attemptId: "AT-1", transport: "managed:sess_x:1", attempt: { state: "reported", outcome: "child reported" } }, "reported"),
		scripted("call-task-evidence", "csheng_workflow", { operation: "record", expectedRevision: 3, evidence: { provenance: "host_observed", subject: { kind: "task", id: "T-1" }, checkIdentity: "claimed", result: "pass", observationId: "call-create" } }, "recorded"),
		scripted("call-assess-task", "csheng_workflow", { operation: "assess", expectedRevision: 4, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "observed create and report" }, "accepted"),
		scripted("call-inspect", MANAGED_SESSION_TOOL_NAME, { action: "inspect" }, "inspected"),
		scripted("call-criterion-evidence", "csheng_workflow", { operation: "record", expectedRevision: 5, evidence: { provenance: "agent_declared", attemptId: "AT-1", subject: { kind: "criterion", id: "AC-1" }, checkIdentity: "claimed", result: "unknown", observationId: "call-inspect" } }, "recorded"),
		scripted("call-assess-criterion", "csheng_workflow", { operation: "assess", expectedRevision: 6, subject: { kind: "criterion", id: "AC-1" }, verdict: "accepted", evidenceIds: ["EV-2"], rationale: "managed inspect observed" }, "accepted"),
		scripted("call-apply", MANAGED_SESSION_TOOL_NAME, { action: "apply" }, "applied"),
		scripted("call-delivery-evidence", "csheng_workflow", { operation: "record", expectedRevision: 7, evidence: { provenance: "agent_declared", attemptId: "AT-1", subject: { kind: "workset", id: "WS-1" }, checkIdentity: "claimed", result: "pass", observationId: "call-apply" } }, "recorded"),
		scripted("call-close", "csheng_workflow", { operation: "close", expectedRevision: 8, outcome: "completed", reason: "released", deliveryEvidenceIds: ["EV-3"] }, "closed"),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("run the managed sequence");
	await waitForTrace(trace, () => harness.session.state.messages.some((message) => message.role === "toolResult" && (message as { toolCallId?: string }).toolCallId === "call-close"));
	for (const message of harness.session.state.messages) if (message.role === "toolResult") calls.push((message as { toolCallId?: string }).toolCallId ?? "?");

	const taskEvidence = workflowResult(harness, "call-task-evidence")?.details?.workflow?.evidence.find((record) => record.id === "EV-1");
	assert.equal(taskEvidence?.provenance, "host_observed", "the claimed provenance is replaced by the observed one");
	assert.equal(taskEvidence?.identity, `${MANAGED_SESSION_TOOL_NAME}:call-create:create:succeeded`);
	assert.equal(taskEvidence?.result, "pass");
	const delivery = workflowResult(harness, "call-delivery-evidence")?.details?.workflow?.evidence.find((record) => record.id === "EV-3");
	assert.equal(delivery?.result, "pass", "an applied candidate is an integration fact");
	assert.equal(workflowResult(harness, "call-assess-task")?.details?.workflow?.tasks.find((task) => task.id === "T-1")?.disposition, "accepted");
	assert.equal(workflowResult(harness, "call-report")?.details?.workflow !== undefined, true);

	const closed = workflowResult(harness, "call-close")?.details;
	assert.equal(closed?.ok, true);
	assert.equal(closed?.workflow?.workset.disposition, "closed");
	assert.equal(closed?.workflow?.workset.closeOutcome, "completed");
	assert.equal(closed?.revision, 9);
	assert.ok(calls.includes("call-apply"));
});

test("unobserved handles, unknown observations and changed bases fail visibly", async (t) => {
	const trace = createTrace();
	let workDir = "";
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, workspaceScenario(), driftWriter(() => join(workDir, "src", "a.ts"), 6), createTraceObserver(trace)] });
	workDir = harness.workDir;
	t.after(() => harness.dispose());
	await mkdir(join(harness.workDir, "src"), { recursive: true });
	await writeFile(join(harness.workDir, "src", "a.ts"), "export const a = 1;\n");

	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "open", expectedRevision: 0, goal: "Negative evidence", deliveryEndpoint: "checks", criteria: [{ key: "c", outcome: "Criterion", verification: "check" }], tasks: [{ key: "t", outcome: "Task", covers: ["c"], writeSurface: ["src"] }] } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: 1, taskId: "T-1", transport: "managed:ghost:9" } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: 1, taskId: "T-1", basis: { scope: ["src"] } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "record", expectedRevision: 2, evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "claimed", result: "pass", observationId: "call-never-ran" } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "record", expectedRevision: 2, evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "unit check", result: "pass", scope: ["src"] } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "record", expectedRevision: 3, attemptId: "AT-1", attempt: { state: "reported", outcome: "done" } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "assess", expectedRevision: 4, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "looks done" } as never)),
		fauxAssistantMessage("waiting"),
	]);
	await harness.session.prompt("prepare evidence");
	const results = harness.session.state.messages.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "csheng_workflow") as Array<{ details?: { ok?: boolean; code?: string; revision?: number; workflow?: { evidence: Array<{ id: string; freshness: string }> } } }>;
	assert.equal(results[1]?.details?.code, "unknown_reference", "an unobserved managed transport is refused");
	assert.match(JSON.stringify(results[1]?.details), /not observed|No observed/);
	assert.equal(results[2]?.details?.ok, true, "the same start succeeds without the managed transport");
	assert.equal(results[3]?.details?.code, "unknown_reference", "a fabricated observation id is refused");
	assert.equal(results[4]?.details?.ok, true);

	// The basis changed inside the same turn, after the evidence was bound: the assess must refresh and refuse.
	const refusal = results.at(-1)!;
	assert.equal(refusal.details?.ok, false);
	assert.equal(refusal.details?.code, "evidence_required");
	assert.match(JSON.stringify(refusal.details), /basis changed/);
	assert.equal(refusal.details?.workflow?.evidence.find((record) => record.id === "EV-1")?.freshness, "stale", "the refresh persisted the stale binding");
});

test("a running overlapping attempt blocks assessment until it is recorded", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "open", expectedRevision: 0, goal: "Concurrent writers", deliveryEndpoint: "checks", criteria: [{ key: "c", outcome: "Criterion", verification: "check" }], tasks: [{ key: "a", outcome: "A", covers: ["c"], writeSurface: ["src"] }, { key: "b", outcome: "B", covers: ["c"], writeSurface: ["src"] }] } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: 1, taskId: "T-1", basis: { scope: ["src"] } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: 2, taskId: "T-2", basis: { scope: ["src"] } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "record", expectedRevision: 3, evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "unit check", result: "pass", scope: ["src"] } } as never)),
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "assess", expectedRevision: 4, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "looks done" } as never)),
		fauxAssistantMessage("blocked"),
	]);
	await harness.session.prompt("attempt conflict");
	await waitForTrace(trace, () => harness.session.state.messages.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "csheng_workflow").length >= 5);
	const results = harness.session.state.messages.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "csheng_workflow") as Array<{ details?: { ok?: boolean; code?: string; message?: string } }>;
	// T-2 is an independent ready task whose write surface overlaps T-1's evidence scope.
	assert.equal(results[2]?.details?.ok, true);
	assert.equal(results[4]?.details?.ok, false);
	assert.equal(results[4]?.details?.code, "attempt_open");
	assert.match(results[4]?.details?.message ?? "", /still running/);
});

const PREPARE_CLOCK = "2026-09-17T00:00:00.000Z";

function prepareWorkset(): { store: ReturnType<typeof createWorkflowStore>; root?: never } {
	const store = createWorkflowStore({ append: () => {} });
	const opened = store.apply({
		operation: "open",
		expectedRevision: 0,
		goal: "Prepare operations",
		deliveryEndpoint: "typed preparation",
		criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
		tasks: [{ key: "a", outcome: "A", covers: ["c"], writeSurface: ["src"] }, { key: "b", outcome: "B", covers: ["c"] }],
	}, { now: PREPARE_CLOCK, cwd: "/repo", sessionId: "session-1" }, "open-1");
	assert.equal(opened.ok, true);
	return { store };
}

test("record refuses a claimed host observation that no host result backs", async () => {
	const { store } = prepareWorkset();
	const deps = { store, observations: createObservationIndex(), cwd: "/repo", now: PREPARE_CLOCK, sessionId: "session-1" };
	const fabricated = await prepareOperation({
		operation: "record",
		expectedRevision: store.current()!.revision,
		evidence: { provenance: "host_observed", subject: { kind: "task", id: "T-1" }, checkIdentity: "claimed", result: "pass", scope: ["src"] },
	}, deps);
	assert.equal(fabricated.ok, false);
	if (fabricated.ok) return;
	assert.equal(fabricated.code, "invalid_payload");
	assert.match(fabricated.message, /observationId or managed reference/);
	const honest = await prepareOperation({
		operation: "record",
		expectedRevision: store.current()!.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, checkIdentity: "read the output", result: "pass", scope: ["src"] },
	}, deps);
	assert.equal(honest.ok, true, "an honest reading remains recordable");
});

test("equivalent path spellings cannot hide an overlapping writer", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-overlap-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
	const store = createWorkflowStore({ append: () => {} });
	const ctx = { now: PREPARE_CLOCK, cwd: root, sessionId: "session-1" };
	const opened = store.apply({
		operation: "open",
		expectedRevision: 0,
		goal: "Overlap",
		deliveryEndpoint: "gate",
		criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
		tasks: [{ key: "a", outcome: "A", covers: ["c"], writeSurface: ["src"] }, { key: "b", outcome: "B", covers: ["c"] }],
	}, ctx, "open-1");
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	const started = store.apply({ operation: "start", expectedRevision: opened.state.revision, taskId: "T-1" }, ctx, "start-1");
	assert.equal(started.ok, true);
	if (!started.ok) return;
	const basis = await fingerprintScope(["./src"], root);
	const recorded = store.apply({
		operation: "record",
		expectedRevision: started.state.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-2" }, scope: ["./src"], fingerprint: basis.fingerprint, fingerprintState: basis.state, checkIdentity: "check", result: "pass" },
	}, ctx, "record-1");
	assert.equal(recorded.ok, true);
	if (!recorded.ok) return;
	const prepared = await prepareOperation({
		operation: "assess",
		expectedRevision: recorded.state.revision,
		subject: { kind: "task", id: "T-2" },
		verdict: "accepted",
		evidenceIds: ["EV-1"],
		rationale: "done",
	}, { store, observations: createObservationIndex(), cwd: root, now: PREPARE_CLOCK, sessionId: "session-1" });
	assert.equal(prepared.ok, false);
	if (prepared.ok) return;
	assert.equal(prepared.code, "attempt_open", "src and ./src are the same write surface");
});

test("preparation never mutates on a stale revision and every refresh transition is distinct", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-prepare-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
	const written: Array<{ customType: string; data: unknown }> = [];
	const store = createWorkflowStore({ append: (customType, data) => written.push({ customType, data }) });
	const ctx = { now: PREPARE_CLOCK, cwd: root, sessionId: "session-1" };
	const deps = { store, observations: createObservationIndex(), cwd: root, now: PREPARE_CLOCK, sessionId: "session-1" };
	const opened = store.apply({
		operation: "open",
		expectedRevision: 0,
		goal: "Prepare drift",
		deliveryEndpoint: "current bindings",
		criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
		tasks: [{ key: "a", outcome: "A", covers: ["c"] }],
	}, ctx, "open-1");
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	const basis = await fingerprintScope(["src"], root);
	const recorded = store.apply({
		operation: "record",
		expectedRevision: opened.state.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, scope: ["src"], fingerprint: basis.fingerprint, fingerprintState: basis.state, checkIdentity: "check", result: "pass" },
	}, ctx, "record-1");
	assert.equal(recorded.ok, true);
	if (!recorded.ok) return;

	// A stale caller cannot even persist an invalidation via preparation.
	const stale = await prepareOperation({ operation: "assess", expectedRevision: recorded.state.revision - 1, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "done" }, deps);
	assert.equal(stale.ok, false);
	if (stale.ok) return;
	assert.equal(stale.code, "stale_revision");
	assert.equal(store.current()!.revision, recorded.state.revision);
	assert.equal(store.current()!.evidence["EV-1"]!.freshness, "current");

	// Drift: the first refresh marks the binding stale and refuses the assessment.
	await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
	const drift = await prepareOperation({ operation: "assess", expectedRevision: store.current()!.revision, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "done" }, deps);
	assert.equal(drift.ok, false);
	if (drift.ok) return;
	assert.equal(drift.code, "evidence_required");
	assert.equal(store.current()!.evidence["EV-1"]!.freshness, "stale");

	// A later, independent drift must refresh again instead of deduplicating on a fixed transition id.
	const second = await fingerprintScope(["src"], root);
	const refreshed = store.apply({
		operation: "record",
		expectedRevision: store.current()!.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, scope: ["src"], fingerprint: second.fingerprint, fingerprintState: second.state, checkIdentity: "check", result: "pass" },
	}, ctx, "record-2");
	assert.equal(refreshed.ok, true);
	if (!refreshed.ok) return;
	await writeFile(join(root, "src", "a.ts"), "export const a = 3;\n");
	const secondDrift = await prepareOperation({ operation: "assess", expectedRevision: refreshed.state.revision, subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-2"], rationale: "done" }, deps);
	assert.equal(secondDrift.ok, false);
	if (secondDrift.ok) return;
	assert.equal(secondDrift.code, "evidence_required");
	assert.equal(store.current()!.evidence["EV-2"]!.freshness, "stale", "the second refresh really applied");
});

test("fingerprints follow a declared symlink target and refuse links outside the workspace", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-link-"));
	const outside = await mkdtemp(join(tmpdir(), "workflow-link-outside-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	await writeFile(join(root, "target-a"), "A\n");
	await writeFile(join(root, "target-b"), "B\n");
	await writeFile(join(outside, "target"), "OUTSIDE\n");
	await symlink("target-a", join(root, "link"));
	const first = await fingerprintScope(["link"], root);
	await rm(join(root, "link"));
	await symlink("target-b", join(root, "link"));
	const second = await fingerprintScope(["link"], root);
	assert.equal(first.state, "current");
	assert.equal(second.state, "current");
	assert.notEqual(first.fingerprint, second.fingerprint, "retargeting a declared link changes the basis");
	await rm(join(root, "link"));
	await symlink(join(outside, "target"), join(root, "link"));
	const escaping = await fingerprintScope(["link"], root);
	assert.equal(escaping.state, "unavailable", "a link outside the workspace cannot certify content");
	assert.match(escaping.note ?? "", /symlink outside/);
});

test("an observation from another session or branch cannot be bound", async () => {
	const { store } = prepareWorkset();
	const observations = createObservationIndex();
	observations.record(summarizeHostObservation({ toolCallId: "other-session", toolName: "bash", isError: false, sessionId: "session-2", result: { details: { exitCode: 0 } } }));
	const prepared = await prepareOperation({
		operation: "record",
		expectedRevision: store.current()!.revision,
		evidence: { provenance: "host_observed", subject: { kind: "task", id: "T-1" }, checkIdentity: "check", result: "pass", observationId: "other-session" },
	}, { store, observations, cwd: "/repo", now: PREPARE_CLOCK, sessionId: "session-1" });
	assert.equal(prepared.ok, false);
	if (prepared.ok) return;
	assert.equal(prepared.code, "unknown_reference");
	assert.match(prepared.message, /not the current session/);
	observations.reset();
	assert.equal(observations.get("other-session"), undefined, "tree navigation drops abandoned-branch observations");
});

test("completion checks every acceptance binding and refuses when the bounded budget is exceeded", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-coverage-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = createWorkflowStore({ append: () => {} });
	const ctx = { now: PREPARE_CLOCK, cwd: root, sessionId: "session-1" };
	const deps = { store, observations: createObservationIndex(), cwd: root, now: PREPARE_CLOCK, sessionId: "session-1" };
	const open = (count: number) => {
		const opened = store.apply({
			operation: "open",
			expectedRevision: 0,
			goal: "Coverage",
			deliveryEndpoint: "checks",
			criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
			tasks: Array.from({ length: count }, (_, index) => ({ key: `t${index + 1}`, outcome: `Task ${index + 1}`, covers: ["c"] })),
		}, ctx, `open-${count}`);
		assert.equal(opened.ok, true);
	};
	open(32);
	for (let index = 1; index <= 32; index += 1) {
		await writeFile(join(root, `task-${index}`), "before\n");
		const basis = await fingerprintScope([`task-${index}`], root);
		const recorded = store.apply({
			operation: "record",
			expectedRevision: store.current()!.revision,
			evidence: { provenance: "agent_declared", subject: { kind: "task", id: `T-${index}` }, scope: [`task-${index}`], fingerprint: basis.fingerprint, fingerprintState: basis.state, checkIdentity: "check", result: "pass" },
		}, ctx, `record-${index}`);
		assert.equal(recorded.ok, true);
		const accepted = store.apply({ operation: "assess", expectedRevision: store.current()!.revision, subject: { kind: "task", id: `T-${index}` }, verdict: "accepted", evidenceIds: [`EV-${index}`], rationale: "check passed" }, ctx, `accept-${index}`);
		assert.equal(accepted.ok, true);
	}
	const criterionBasis = await fingerprintScope(["task-1"], root);
	const criterionEvidence = store.apply({
		operation: "record",
		expectedRevision: store.current()!.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "criterion", id: "AC-1" }, scope: ["task-1"], fingerprint: criterionBasis.fingerprint, fingerprintState: criterionBasis.state, checkIdentity: "criterion check", result: "pass" },
	}, ctx, "record-criterion");
	assert.equal(criterionEvidence.ok, true);
	const criterionAccepted = store.apply({ operation: "assess", expectedRevision: store.current()!.revision, subject: { kind: "criterion", id: "AC-1" }, verdict: "accepted", evidenceIds: ["EV-33"], rationale: "check passed" }, ctx, "accept-criterion");
	assert.equal(criterionAccepted.ok, true);
	const delivery = store.apply({
		operation: "record",
		expectedRevision: store.current()!.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "workset", id: "WS-1" }, scope: ["task-1"], fingerprint: criterionBasis.fingerprint, fingerprintState: criterionBasis.state, checkIdentity: "delivery check", result: "pass" },
	}, ctx, "record-delivery");
	assert.equal(delivery.ok, true);
	// The lexically last binding is not skipped: changing it blocks completion.
	await writeFile(join(root, "task-8"), "after\n");
	const drifted = await prepareOperation({ operation: "close", expectedRevision: store.current()!.revision, outcome: "completed", reason: "done", deliveryEvidenceIds: ["EV-34"] }, deps);
	assert.equal(drifted.ok, false);
	if (drifted.ok) return;
	assert.equal(drifted.code, "evidence_required");
	assert.match(drifted.message, /EV-8/);
	assert.equal(store.current()!.evidence["EV-8"]!.freshness, "stale");

	// A larger workset exceeds the bounded completion check budget and refuses instead of truncating.
	const big = createWorkflowStore({ append: () => {} });
	const bigDeps = { ...deps, store: big };
	const bigOpened = big.apply({
		operation: "open",
		expectedRevision: 0,
		goal: "Budget",
		deliveryEndpoint: "checks",
		criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
		tasks: Array.from({ length: 64 }, (_, index) => ({ key: `t${index + 1}`, outcome: `Task ${index + 1}`, covers: ["c"] })),
	}, ctx, "open-big");
	assert.equal(bigOpened.ok, true);
	const sharedBasis = await fingerprintScope(["task-1"], root);
	for (let index = 1; index <= 64; index += 1) {
		const recorded = big.apply({
			operation: "record",
			expectedRevision: big.current()!.revision,
			evidence: { provenance: "agent_declared", subject: { kind: "task", id: `T-${index}` }, scope: ["task-1"], fingerprint: sharedBasis.fingerprint, fingerprintState: sharedBasis.state, checkIdentity: "check", result: "pass" },
		}, ctx, `big-record-${index}`);
		assert.equal(recorded.ok, true);
		const accepted = big.apply({ operation: "assess", expectedRevision: big.current()!.revision, subject: { kind: "task", id: `T-${index}` }, verdict: "accepted", evidenceIds: [`EV-${index}`], rationale: "check passed" }, ctx, `big-accept-${index}`);
		assert.equal(accepted.ok, true);
	}
	const bigCriterion = big.apply({
		operation: "record",
		expectedRevision: big.current()!.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "criterion", id: "AC-1" }, scope: ["task-1"], fingerprint: sharedBasis.fingerprint, fingerprintState: sharedBasis.state, checkIdentity: "criterion check", result: "pass" },
	}, ctx, "big-criterion");
	assert.equal(bigCriterion.ok, true);
	const bigAccepted = big.apply({ operation: "assess", expectedRevision: big.current()!.revision, subject: { kind: "criterion", id: "AC-1" }, verdict: "accepted", evidenceIds: ["EV-65"], rationale: "check passed" }, ctx, "big-accept-criterion");
	assert.equal(bigAccepted.ok, true);
	const bigDelivery = big.apply({
		operation: "record",
		expectedRevision: big.current()!.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "workset", id: "WS-1" }, scope: ["task-1"], fingerprint: sharedBasis.fingerprint, fingerprintState: sharedBasis.state, checkIdentity: "delivery check", result: "pass" },
	}, ctx, "big-delivery");
	assert.equal(bigDelivery.ok, true);
	const budget = await prepareOperation({ operation: "close", expectedRevision: big.current()!.revision, outcome: "completed", reason: "done", deliveryEvidenceIds: ["EV-66"] }, bigDeps);
	assert.equal(budget.ok, false);
	if (budget.ok) return;
	assert.equal(budget.code, "evidence_required");
	assert.match(budget.message, /budget of 64/);
});
