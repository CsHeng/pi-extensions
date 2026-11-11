import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateExecutionQuiescence, executionKey, observeExecutionQuiescence, readExecutionQuiescence } from "../extensions/shared/execution-quiescence.ts";
import { emptyProducerFacts, NOTICE_DELIVERY_CHANGED, NOTICE_DELIVERY_REQUEST, EXECUTION_FACTS_EVENT, EXECUTION_FACTS_REQUEST, type NoticeDeliverySnapshot, type ProducerFacts, type ExecutionFactPhase } from "../extensions/shared/execution-facts.ts";

const scope = { toolCallIds: new Set(["current"]) };
const base = { mainIdle: true, hasPendingMessages: false, facts: [] as ProducerFacts[] };
const fact = (phase: ExecutionFactPhase, toolCallId?: string): ProducerFacts => ({
	...emptyProducerFacts("async-bash", "ready", "session", "anchor"),
	executions: [{ id: "job", phase, status: phase, exitCode: null, summary: phase === "terminal" ? "done" : "", disposition: "pending", ...(toolCallId ? { toolCallId } : {}) }],
});
const delivery = (extra: Partial<NoticeDeliverySnapshot> = {}): NoticeDeliverySnapshot => ({ version: 1, sessionId: "session", branchAnchor: "anchor", pending: [], scheduled: [], blocked: false, ...extra });

test("quiescence is passive and task data cannot trigger or prolong work", () => {
	const tasks = { ...emptyProducerFacts("tasklist", "unavailable"), tasks: { revision: 1, title: "work", tasks: [{ id: "a", title: "a", status: "doing" }] } };
	assert.equal(evaluateExecutionQuiescence(base).state, "quiescent");
	assert.equal(evaluateExecutionQuiescence({ ...base, facts: [tasks] }).state, "quiescent");
	assert.equal(evaluateExecutionQuiescence({ ...base, mainIdle: false }).state, "busy");
	assert.equal(evaluateExecutionQuiescence({ ...base, hasPendingMessages: true }).state, "busy");
	assert.equal(evaluateExecutionQuiescence({ ...base, aborted: true }).state, "unavailable");
});

test("queued, preparing and running executions survive native main settlement", () => {
	for (const phase of ["queued", "preparing", "running"] as const) {
		const state = evaluateExecutionQuiescence({ ...base, scope, facts: [fact(phase, "current")] });
		assert.equal(state.state, "busy"); assert.equal(state.activeExecutions, 1);
	}
	// No notification consumer means no promise of an automatic result run.
	assert.equal(evaluateExecutionQuiescence({ ...base, scope, facts: [fact("terminal", "current")] }).state, "quiescent");
});

test("the last terminal is not final while its result is pending or a wake is reserved", () => {
	const ref = { producer: "async-bash" as const, id: "job", toolCallId: "current" };
	for (const key of ["pending", "scheduled"] as const) {
		const state = evaluateExecutionQuiescence({ ...base, scope, facts: [fact("terminal", "current")], delivery: delivery({ [key]: [ref] }) });
		assert.equal(state.state, "busy"); assert.equal(state[key === "pending" ? "pendingDeliveries" : "scheduledDeliveries"], 1);
	}
	assert.equal(evaluateExecutionQuiescence({ ...base, scope, delivery: delivery({ pending: [ref], blocked: true }) }).state, "unavailable");
});

test("old executions do not latch a new interaction, but explicit controls can adopt them", () => {
	const old = fact("running", "old");
	assert.equal(evaluateExecutionQuiescence({ ...base, scope, facts: [old] }).state, "quiescent");
	const excluded = new Set([executionKey("async-bash", "job")]);
	assert.equal(evaluateExecutionQuiescence({ ...base, scope: { ...scope, excludedExecutions: excluded }, facts: [fact("running")] }).state, "quiescent");
	assert.equal(evaluateExecutionQuiescence({ ...base, scope: { ...scope, executionKeys: excluded, excludedExecutions: excluded }, facts: [old] }).state, "busy");
	const agent = { ...emptyProducerFacts("agents", "ready"), executions: [{ ...old.executions[0]!, id: "run:child", runId: "run" }] };
	assert.equal(evaluateExecutionQuiescence({ ...base, scope: { ...scope, runIds: new Set(["run"]) }, facts: [agent] }).state, "busy");
});

test("unknown inventory or new unattributed work is not an empty successful inventory", () => {
	for (const availability of ["unknown", "unavailable"] as const) assert.equal(evaluateExecutionQuiescence({ ...base, facts: [emptyProducerFacts("agents", availability)] }).state, "unavailable");
	assert.equal(evaluateExecutionQuiescence({ ...base, scope, facts: [fact("running")] }).state, "unavailable");
	assert.equal(evaluateExecutionQuiescence({ ...base, facts: [emptyProducerFacts("agents", "inactive")] }).state, "quiescent");
});

function readerFixture() {
	const bus = new EventEmitter();
	const pi = { events: { emit: (name: string, value: unknown) => { bus.emit(name, value); }, on: (name: string, callback: (...args: any[]) => void) => { bus.on(name, callback); return () => bus.off(name, callback); } } } as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => "session", getLeafId: () => "anchor", getBranch: () => [{ id: "anchor" }] }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
	return { pi, ctx, bus };
}

test("the snapshot reader sees current delivery before a later wake handler runs", () => {
	const { pi, ctx, bus } = readerFixture();
	bus.on(EXECUTION_FACTS_REQUEST, request => request.accept(fact("terminal", "current")));
	bus.on(NOTICE_DELIVERY_REQUEST, request => request.accept(delivery({ pending: [{ producer: "async-bash", id: "job", toolCallId: "current" }] })));
	assert.equal(readExecutionQuiescence(pi, ctx, scope).state, "busy");
});

test("a foreign loaded snapshot is unavailable, not an absent producer; passive foreign tasks are irrelevant", () => {
	const { pi, ctx, bus } = readerFixture();
	bus.on(EXECUTION_FACTS_REQUEST, request => request.accept({ ...fact("running", "current"), sessionId: "other" }));
	assert.equal(readExecutionQuiescence(pi, ctx, scope).state, "unavailable");
	bus.removeAllListeners(EXECUTION_FACTS_REQUEST);
	bus.on(EXECUTION_FACTS_REQUEST, request => request.accept(emptyProducerFacts("tasklist", "ready", "other")));
	assert.equal(readExecutionQuiescence(pi, ctx, scope).state, "quiescent");
});

test("observation only coalesces event invalidation and disposes without a model turn or timer", async () => {
	const { pi, bus } = readerFixture(); let calls = 0;
	const stop = observeExecutionQuiescence(pi, () => { calls++; });
	bus.emit(EXECUTION_FACTS_EVENT, fact("running", "current")); bus.emit(NOTICE_DELIVERY_CHANGED, {});
	assert.equal(calls, 0); await Promise.resolve(); assert.equal(calls, 1);
	bus.emit(NOTICE_DELIVERY_CHANGED, {}); stop(); await Promise.resolve(); assert.equal(calls, 1);
	assert.equal(bus.listenerCount(EXECUTION_FACTS_EVENT), 0); assert.equal(bus.listenerCount(NOTICE_DELIVERY_CHANGED), 0);
});
