import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ALIGNMENT_CONTEXT_TYPE, createAlignmentRuntime, rearmAlignment, registerAlignmentHooks } from "../extensions/workflow/alignment.ts";
import type { WorkflowOperation, WorksetState } from "../extensions/workflow/contracts.ts";
import { applyOperation, markInputDelivered, type ReduceContext } from "../extensions/workflow/reducer.ts";
import { REVIEW_PROMPT_MARKER, hasActionableDeficit, progressFingerprint, registerReviewPolicy } from "../extensions/workflow/review.ts";
import { createWorkflowStore, type SessionEntryLike } from "../extensions/workflow/store.ts";
import workflowExtension from "./fixtures/workflow/legacy-extension.ts";
import { prepareOperation } from "../extensions/workflow/tool.ts";
import { createObservationIndex } from "../extensions/workflow/observation.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";

const CLOCK: ReduceContext = { now: "2026-09-17T00:00:00.000Z", cwd: "/repo", sessionId: "session-1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakePi {
	handlers: Map<string, Array<(event: any, ctx?: any) => any>>;
	sent: string[];
	entries: Array<{ customType: string; data: unknown }>;
	on(name: string, handler: (event: any, ctx?: any) => any): void;
	sendUserMessage(text: string): void;
	appendEntry(customType: string, data: unknown): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
	return {
		handlers,
		sent: [],
		entries: [],
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		sendUserMessage(text) {
			this.sent.push(text);
		},
		appendEntry(customType, data) {
			this.entries.push({ customType, data });
		},
	};
}

async function emit(pi: FakePi, name: string, event: Record<string, unknown> = {}): Promise<any[]> {
	const results: any[] = [];
	for (const handler of pi.handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, { mode: "tui", isIdle: () => true, hasPendingMessages: () => false }));
	return results;
}

function openOperation(): WorkflowOperation {
	return {
		operation: "open",
		expectedRevision: 0,
		goal: "Alignment and reconciliation",
		deliveryEndpoint: "reviewed source",
		criteria: [{ key: "c", outcome: "Criterion", verification: "check" }],
		tasks: [{ key: "t", outcome: "Task", covers: ["c"] }],
	};
}

function harnessFixture() {
	const pi = fakePi();
	const store = createWorkflowStore({ append: (customType, data) => pi.appendEntry(customType, data) });
	const alignmentRuntime = createAlignmentRuntime();
	const review = registerReviewPolicy(pi as unknown as ExtensionAPI, store, { pendingHumanInput: () => alignmentRuntime.unrecordedInput });
	const alignment = registerAlignmentHooks(pi as unknown as ExtensionAPI, store, { runtime: alignmentRuntime });
	const opened = store.apply(openOperation(), CLOCK, "call-open");
	assert.equal(opened.ok, true);
	if (!opened.ok) throw new Error("open failed");
	return { pi, store, review, alignment, state: () => store.current()! };
}

test("ordinary input commits only in model context, once across turns and retries", async () => {
	const { pi, store, alignment } = harnessFixture();
	const user = { role: "user", content: [{ type: "text", text: "expanded intent" }], timestamp: 1 };
	await emit(pi, "input", { source: "interactive", text: "/template" });
	await emit(pi, "before_agent_start", { prompt: "expanded intent" });
	await emit(pi, "message_start", { message: user });
	assert.equal(store.current()!.workset.inputGeneration, 0, "neither receipt nor native start is model preparation");
	assert.equal(alignment.projection.projected, false);
	await emit(pi, "context", { messages: [] });
	assert.equal(store.current()!.workset.inputGeneration, 0, "a missing native occurrence cannot be counted");
	const projected = (await emit(pi, "context", { messages: [structuredClone(user)] })).at(-1).messages;
	assert.equal(store.current()!.workset.inputGeneration, 1);
	assert.equal(store.current()!.workset.alignment.state, "needs_alignment");
	const reminder = projected.find((message: any) => message.customType === ALIGNMENT_CONTEXT_TYPE);
	assert.match(reminder.content, /Current goal: Alignment and reconciliation/);
	const again = (await emit(pi, "context", { messages: projected })).at(-1).messages;
	assert.equal(again.filter((message: any) => message.customType === ALIGNMENT_CONTEXT_TYPE).length, 1);
	assert.equal(store.current()!.workset.inputGeneration, 1);
});

test("only a newer prepared occurrence replaces a reminder; queued edits leave it intact", async () => {
	const { pi, store } = harnessFixture();
	const first = { role: "user", content: "first", timestamp: 1 };
	await emit(pi, "input", { source: "interactive", text: "first" });
	await emit(pi, "before_agent_start");
	await emit(pi, "message_start", { message: first });
	const projected = (await emit(pi, "context", { messages: [first] })).at(-1).messages;
	await emit(pi, "input", { source: "interactive", text: "discarded draft", streamingBehavior: "followUp" });
	assert.equal(store.current()!.workset.inputGeneration, 1);
	const intact = (await emit(pi, "context", { messages: projected })).at(-1).messages;
	assert.deepEqual(intact, projected);
	const second = { role: "user", content: "actually sent replacement", timestamp: 2 };
	await emit(pi, "message_start", { message: second });
	const replaced = (await emit(pi, "context", { messages: [...projected, second] })).at(-1).messages;
	assert.equal(store.current()!.workset.inputGeneration, 2);
	assert.equal(replaced.filter((message: any) => message.customType === ALIGNMENT_CONTEXT_TYPE).length, 1);
	assert.match(replaced.find((message: any) => message.customType === ALIGNMENT_CONTEXT_TYPE).content, /generation 2/);
});

test("recovery boundaries rearm the alignment reminder from durable state", async () => {
	const rearmedPi = fakePi();
	const store2 = createWorkflowStore({ append: (customType, data) => rearmedPi.appendEntry(customType, data) });
	const runtime2 = createAlignmentRuntime();
	registerAlignmentHooks(rearmedPi as unknown as ExtensionAPI, store2, { runtime: runtime2 });
	const opened = store2.apply(openOperation(), CLOCK, "open");
	assert.equal(opened.ok, true);
	if (!opened.ok) return;
	const delivered = store2.apply({ operation: "delivered", expectedRevision: opened.state.revision }, CLOCK, "delivered");
	assert.equal(delivered.ok, true);
	if (!delivered.ok) return;
	rearmAlignment(runtime2, store2.current());
	const projected = (await emit(rearmedPi, "context", { messages: [] })).at(-1).messages;
	assert.equal(projected.filter((message: any) => message.customType === ALIGNMENT_CONTEXT_TYPE).length, 1, "a reloaded unaligned workset re-projects its reminder");
	// Compaction loses the projected message; the next context restores it.
	await emit(rearmedPi, "session_compact", { status: "success" });
	const restored = (await emit(rearmedPi, "context", { messages: [] })).at(-1).messages;
	assert.equal(restored.filter((message: any) => message.customType === ALIGNMENT_CONTEXT_TYPE).length, 1, "compaction rearms the reminder");
});

test("known extension control is excluded; queued receipts alone have no effect", async () => {
	const { pi, store } = harnessFixture();
	const control = { role: "user", content: "control", timestamp: 1 };
	await emit(pi, "input", { source: "extension", text: "control" });
	await emit(pi, "before_agent_start");
	await emit(pi, "message_start", { message: control });
	await emit(pi, "context", { messages: [control] });
	await emit(pi, "input", { source: "rpc", text: "withdrawn", streamingBehavior: "steer" });
	await emit(pi, "context", { messages: [control] });
	assert.equal(store.current()!.workset.inputGeneration, 0);
	assert.equal(store.current()!.workset.alignment.state, "aligned");
});

test("alignment projection stays at its input boundary rather than becoming a repeated tool-result tail", async () => {
	const { pi, store } = harnessFixture();
	await emit(pi, "input", { source: "interactive", text: "new intent", streamingBehavior: "steer" });
	const user = { role: "user", content: "new intent" };
	await emit(pi, "message_start", { message: user });
	const first = (await emit(pi, "context", { messages: [user] })).at(-1).messages;
	const assistant = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] };
	const result = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "read-only result" }] };
	const preserved = (await emit(pi, "context", { messages: [...first, assistant, result] })).at(-1).messages;
	assert.equal(preserved[1].customType, ALIGNMENT_CONTEXT_TYPE);
	assert.equal(preserved.at(-1), result);
	assert.equal(preserved.at(-2), assistant, "no marker is inserted between a tool call and its result");
	const ephemeral = (await emit(pi, "context", { messages: [user, assistant, result] })).at(-1).messages;
	assert.deepEqual(ephemeral, [user, assistant, result], "ordinary read-only turns do not rearm the same reminder");
	assert.equal(store.current()!.workset.alignment.state, "needs_alignment", "projection consumption never substitutes for alignment");
	await emit(pi, "message_end", { message: { role: "assistant", stopReason: "error" } });
	const retry = (await emit(pi, "context", { messages: [user, assistant, result] })).at(-1).messages;
	assert.equal(retry[1].customType, ALIGNMENT_CONTEXT_TYPE, "a failed provider request rearms the reminder");
	assert.equal(retry.at(-1), result);
});

for (const sources of [["interactive", "extension"], ["extension", "interactive"]]) {
	test(`mixed queues ${sources.join("/")}: actual context aligns, unknown origin never refills`, async () => {
		const { pi, store } = harnessFixture();
		store.apply({ operation: "review", expectedRevision: store.current()!.revision, action: "dispatched", fingerprint: "spent-allowance" }, CLOCK, "spend");
		const original = structuredClone(store.current()!.workset);
		for (const source of sources) await emit(pi, "input", { source, text: "identical", streamingBehavior: "followUp" });
		const messages: any[] = [];
		for (let i = 0; i < 2; i++) {
			const user = { role: "user", content: "identical", timestamp: 1 };
			messages.push(user);
			await emit(pi, "message_start", { message: user });
			assert.equal(store.current()!.workset.inputGeneration, i);
			await emit(pi, "context", { messages: structuredClone(messages) });
			assert.equal(store.current()!.workset.inputGeneration, i + 1);
			assert.equal(store.current()!.workset.alignment.deliveryUnavailable, true);
			assert.equal(store.current()!.workset.review.used, 1);
			assert.equal(store.current()!.workset.review.lastFingerprint, "spent-allowance");
			const aligned = store.apply({ operation: "align", expectedRevision: store.current()!.revision, inputGeneration: i + 1, action: "confirm" }, CLOCK, `confirm-${i}`);
			assert.equal(aligned.ok, true, "unknown origin does not prevent confirming existing obligations");
		}
		assert.equal(store.current()!.workset.goal, original.goal);
		assert.equal(store.current()!.workset.goalRevision, original.goalRevision);
		assert.deepEqual(store.current()!.workset.authorityReferences, original.authorityReferences);
		assert.equal(store.current()!.workset.deliveryEndpoint, original.deliveryEndpoint);
		assert.equal(store.apply({ operation: "review", expectedRevision: store.current()!.revision, action: "dispatched", fingerprint: "new" }, CLOCK, "over-cap").ok, false);
		const replay = createWorkflowStore({ append() {} });
		replay.replay(pi.entries.map((entry) => ({ type: "custom", ...entry })));
		assert.equal(replay.current()!.workset.review.used, 1);
	});
}

test("only a newly prepared identified human replenishes credit after transformed controls", async () => {
	const { pi, store } = harnessFixture();
	store.apply({ operation: "review", expectedRevision: store.current()!.revision, action: "dispatched", fingerprint: "spent" }, CLOCK, "spend");
	await emit(pi, "input", { source: "interactive", text: "human", streamingBehavior: "followUp" });
	await emit(pi, "input", { source: "extension", text: "/template", streamingBehavior: "steer" });
	const control = { role: "user", content: "expanded control", timestamp: 1 };
	await emit(pi, "message_start", { message: control });
	await emit(pi, "context", { messages: [control] });
	assert.equal(store.current()!.workset.review.used, 1);
	await emit(pi, "agent_settled");
	const human = { role: "user", content: "fresh idle intent", timestamp: 2 };
	await emit(pi, "input", { source: "interactive", text: "fresh idle intent" });
	await emit(pi, "before_agent_start");
	await emit(pi, "message_start", { message: human });
	assert.equal(store.current()!.workset.review.used, 1);
	await emit(pi, "context", { messages: [control, human] });
	assert.equal(store.current()!.workset.inputGeneration, 2);
	assert.equal(store.current()!.workset.review.used, 0);
	assert.equal(store.current()!.workset.alignment.deliveryUnavailable, undefined);
});

test("failed input snapshot does not consume the occurrence or permit stale task starts", async () => {
	const pi = fakePi();
	let fail = false;
	const store = createWorkflowStore({ append() { if (fail) throw new Error("fixture append failure"); } });
	const runtime = createAlignmentRuntime();
	registerAlignmentHooks(pi as unknown as ExtensionAPI, store, { runtime });
	store.apply(openOperation(), CLOCK, "open");
	const user = { role: "user", content: "actual input", timestamp: 1 };
	await emit(pi, "input", { source: "interactive", text: "actual input" });
	await emit(pi, "before_agent_start");
	await emit(pi, "message_start", { message: user });
	fail = true;
	await assert.rejects(emit(pi, "context", { messages: [user] }), /append failure/);
	assert.equal(store.current()!.workset.inputGeneration, 0);
	assert.equal(runtime.unrecordedInput, true);
	const result = await prepareOperation({ operation: "start", expectedRevision: store.current()!.revision, taskId: "T-1" }, { store, observations: createObservationIndex(), ...CLOCK, unrecordedInput: runtime.unrecordedInput });
	assert.equal(result.ok, false);
	fail = false;
	await emit(pi, "context", { messages: [user] });
	assert.equal(store.current()!.workset.inputGeneration, 1);
	assert.equal(runtime.unrecordedInput, false);
	await emit(pi, "context", { messages: [user] });
	assert.equal(store.current()!.workset.inputGeneration, 1);
});

test("a closed workset ignores new input while the extension stays dormant", async () => {
	const { pi, store } = harnessFixture();
	const state = store.current()!;
	const closed = applyOperation(state, { operation: "close", expectedRevision: state.revision, outcome: "cancelled", reason: "done" }, CLOCK);
	assert.equal(closed.ok, true);
	if (!closed.ok) return;
	const next = createWorkflowStore({ append: () => {} });
	next.replay([{ type: "custom", customType: "csheng-workflow-state", data: { schemaVersion: 1, revision: closed.state.revision, transition: "x", at: CLOCK.now, state: closed.state } }]);
	const closedPi = fakePi();
	registerAlignmentHooks(closedPi as unknown as ExtensionAPI, next, { runtime: createAlignmentRuntime() });
	await emit(closedPi, "input", { source: "interactive", text: "ignored" });
	await emit(closedPi, "before_agent_start", { prompt: "ignored" });
	assert.equal(next.current()!.workset.inputGeneration, 0);
});

test("the review policy dispatches once for a real deficit and records every suppression", async () => {
	const cases: Array<{ name: string; prepare: (fixture: ReturnType<typeof harnessFixture>) => Promise<void> | void; event?: Record<string, unknown>; expectedReason?: string }> = [
		{ name: "no workset", prepare: (fixture) => { fixture.store.replay([]); } },
		{ name: "paused workset", prepare: (fixture) => { const state = fixture.store.current()!; fixture.store.apply({ operation: "pause", expectedRevision: state.revision, reason: "waiting" }, CLOCK, "pause"); } },
		{ name: "unaligned", prepare: (fixture) => { const state = fixture.store.current()!; fixture.store.apply({ operation: "delivered", expectedRevision: state.revision }, CLOCK, "delivered"); } },
		{ name: "provider error", prepare: (fixture) => { fixture.review.runtime.lastRunStop = "error"; } },
		{ name: "aborted run", prepare: (fixture) => { fixture.review.runtime.lastRunStop = "aborted"; } },
		{ name: "failed compaction", prepare: (fixture) => { fixture.review.runtime.lastRunStop = "stop"; fixture.review.runtime.compactFailed = true; } },
		{ name: "active UI prompt", prepare: (fixture) => { fixture.review.runtime.lastRunStop = "stop"; fixture.review.runtime.uiPromptDepth = 1; } },
		{ name: "pending human input", prepare: () => {} },
		{ name: "unrecorded model input", prepare: (fixture) => { fixture.alignment.unrecordedInput = true; } },
	];
	for (const scenario of cases) {
		const fixture = harnessFixture();
		fixture.review.runtime.lastRunStop = "stop";
		await scenario.prepare(fixture);
		if (scenario.name === "pending human input") {
			const handler = fixture.pi.handlers.get("agent_settled")![0]!;
			await handler({ type: "agent_settled" }, { mode: "tui", isIdle: () => true, hasPendingMessages: () => true });
		} else {
			await emit(fixture.pi, "agent_settled");
		}
		await sleep(15);
		assert.equal(fixture.pi.sent.length, 0, `${scenario.name} must not dispatch`);
	}

	// A normal settlement with an actionable deficit records the missing host contract and sends nothing.
	const fixture = harnessFixture();
	fixture.review.runtime.lastRunStop = "stop";
	await emit(fixture.pi, "agent_settled");
	await sleep(15);
	assert.equal(fixture.pi.sent.length, 0, "automatic dispatch is disabled on this host");
	assert.match(fixture.store.current()!.workset.review.pausedReason ?? "", /host_contract_unavailable/);
	assert.equal(fixture.store.current()!.workset.review.used, 0, "a blocked decision consumes no allowance");

	// The same fingerprint at the next settlement records a visible pause instead of repeating.
	fixture.review.runtime.lastRunStop = "stop";
	await emit(fixture.pi, "agent_settled");
	await sleep(15);
	assert.equal(fixture.pi.sent.length, 0);
	assert.match(fixture.store.current()!.workset.review.pausedReason ?? "", /no_progress/);
});

test("print/json hosts record a typed incompatibility instead of dispatching", async () => {
	const fixture = harnessFixture();
	fixture.review.runtime.lastRunStop = "stop";
	const handler = fixture.pi.handlers.get("agent_settled")![0]!;
	await handler({ type: "agent_settled" }, { mode: "print", isIdle: () => true, hasPendingMessages: () => false });
	await sleep(15);
	assert.equal(fixture.pi.sent.length, 0);
	assert.match(fixture.store.current()!.workset.review.pausedReason ?? "", /mode_unsupported/);
});

test("progress fingerprints ignore cosmetic and pending/running churn but track real obligations", () => {
	let state = applyOperation(undefined, openOperation(), CLOCK) as { ok: true; state: WorksetState };
	const first = progressFingerprint(state.state);
	const bumped = { ...structuredClone(state.state), revision: state.state.revision + 7, next: { ...state.state.next, task: 99 } };
	assert.equal(progressFingerprint(bumped), first, "revision and id counters are cosmetic");
	const running = structuredClone(state.state);
	running.tasks["T-1"]!.disposition = "running";
	assert.equal(progressFingerprint(running), first, "pending/running toggles are cosmetic");
	const evidence = structuredClone(state.state);
	evidence.evidence["EV-1"] = { id: "EV-1", worksetId: "WS-1", provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, revisions: { taskRevision: 1 }, basis: { scope: [], fingerprint: "fp", fingerprintState: "current" }, check: { identity: "check", result: "pass" }, freshness: "current", artifactReferences: [], recordedAt: CLOCK.now };
	assert.notEqual(progressFingerprint(evidence), first, "new evidence is progress");
	const duplicate = structuredClone(evidence);
	duplicate.evidence["EV-2"] = { ...structuredClone(evidence.evidence["EV-1"]!), id: "EV-2" };
	assert.equal(progressFingerprint(duplicate), progressFingerprint(evidence), "re-recording the same fact under a new id is not progress");
	const accepted = structuredClone(state.state);
	accepted.tasks["T-1"]!.disposition = "accepted";
	assert.notEqual(progressFingerprint(accepted), first, "acceptance is progress");

	state = { ok: true, state: accepted };
	const deficits = [
		{ code: "unaccepted_tasks" as const, ids: ["T-1"], message: "T-1" },
	];
	assert.equal(hasActionableDeficit(state.state, deficits), true, "accepted tasks still leave the required criterion unaccepted");
	const waiting = structuredClone(state.state);
	waiting.tasks["T-1"]!.disposition = "blocked";
	waiting.tasks["T-1"]!.nextUnblockCondition = "user decision";
	assert.equal(hasActionableDeficit(waiting, deficits), false, "a blocked task with a condition is an explicit waiting disposition");
	const deliveryOnly = [{ code: "missing_delivery_evidence" as const, ids: ["WS-1"], message: "delivery" }];
	assert.equal(hasActionableDeficit(waiting, deliveryOnly), false, "waiting on user authority cannot advance the delivery endpoint");
	const acceptedWithDelivery = structuredClone(state.state);
	acceptedWithDelivery.tasks["T-1"]!.disposition = "accepted";
	assert.equal(hasActionableDeficit(acceptedWithDelivery, deliveryOnly), true, "an accepted contract can still record delivery evidence");
});

test("real host: a prepared steer requests alignment without inventing review credit", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "open", expectedRevision: 0, goal: "Alignment host", deliveryEndpoint: "checks", criteria: [{ key: "c", outcome: "Criterion", verification: "check" }], tasks: [{ key: "t", outcome: "Task", covers: ["c"] }] } as never)),
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.25; echo ok" } as never)),
		fauxAssistantMessage("after tool"),
		fauxAssistantMessage("settled"),
	]);
	const running = harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "tool_start" && entry.detail?.toolName === "bash");
	await harness.session.prompt("new intent while running", { streamingBehavior: "steer" });
	await running;
	await sleep(50);

	const latest = [...harness.session.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state");
	const state = (latest as { data?: { state: WorksetState } } | undefined)!.data!.state;
	assert.equal(state.workset.inputGeneration, 1, "the actual prepared occurrence, not its receipt, requires alignment");
	assert.equal(state.workset.alignment.deliveryUnavailable, true);
	assert.equal(state.workset.alignment.state, "needs_alignment");
	assert.equal(state.workset.review.used, 0, "unaligned settlement must not consume the review allowance");
	assert.equal(harness.faux.state.callCount, 3, "no reconciliation request was dispatched");
	assert.ok(trace.entries.some((entry) => entry.event === "context" && String(entry.detail?.roles).includes("custom")), "the one-shot alignment reminder reached the model context");
});

test("unbound SDK host: premature settlement cannot use a no-op command waiter", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, commandWait: false, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "open", expectedRevision: 0, goal: "Reconciliation host", deliveryEndpoint: "checks", criteria: [{ key: "c", outcome: "Criterion", verification: "check" }], tasks: [{ key: "t", outcome: "Task", covers: ["c"] }] } as never)),
		fauxAssistantMessage("all done"),
		fauxAssistantMessage("still done"),
	]);
	await harness.session.prompt("go");
	await sleep(60);

	const latest = [...harness.session.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state");
	const state = (latest as { data?: { state: WorksetState } } | undefined)!.data!.state;
	assert.equal(state.workset.disposition, "active", "unfinished work is never marked complete");
	assert.equal(state.workset.review.used, 0, "no automatic review was dispatched");
	assert.match(state.workset.review.pausedReason ?? "", /host_contract_unavailable/);
	assert.equal(harness.faux.state.callCount, 2, "open and the premature stop, with no reconciliation turn");
	assert.ok(!trace.entries.some((entry) => entry.event === "input" && entry.detail?.source === "extension" && String(entry.detail?.text).startsWith(REVIEW_PROMPT_MARKER)));
});
