import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowExtension from "./fixtures/workflow/legacy-extension.ts";
import type { WorksetState } from "../extensions/workflow/contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness } from "./fixtures/workflow/host-fixture.ts";

const open = () => fauxAssistantMessage(fauxToolCall("csheng_workflow", {
	operation: "open", expectedRevision: 0, goal: "Settlement safety", deliveryEndpoint: "fixture",
	criteria: [{ key: "c", outcome: "criterion", verification: "check" }], tasks: [{ key: "t", outcome: "task", covers: ["c"] }],
} as never));
const state = (harness: HostHarness): WorksetState => {
	const snapshot = harness.session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state") as { data: { state: WorksetState } };
	return snapshot.data.state;
};

test("production reconciliation stops on no progress without closing incomplete work", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([open(), fauxAssistantMessage("premature stop"), fauxAssistantMessage("still no progress")]);
	await harness.session.prompt("go");
	await waitForTrace(trace, () => trace.entries.filter((entry) => entry.event === "native:agent_settled").length === 2);
	assert.equal(harness.faux.state.callCount, 3);
	assert.equal(state(harness).workset.review.used, 1);
	assert.match(state(harness).workset.review.pausedReason!, /no_progress/);
	assert.equal(state(harness).workset.disposition, "active");
	assert.equal(state(harness).workset.inputGeneration, 0, "extension control never refills the human allowance");
	assert.deepEqual(harness.errors, []);
});

test("real input received during a later settlement handler cancels the production review lease", async (t) => {
	const trace = createTrace();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const lateConsumer = (pi: ExtensionAPI) => {
		pi.on("agent_settled", async () => { trace.record("late:waiting"); await gate; });
		pi.on("input", (event) => { if (event.text === "intervene") return { action: "handled" }; });
	};
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace), lateConsumer] });
	t.after(async () => { release(); await harness.dispose(); });
	harness.faux.setResponses([open(), fauxAssistantMessage("premature stop")]);
	const running = harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "late:waiting");
	await harness.session.prompt("intervene");
	release();
	await running;
	await harness.session.waitForIdle();
	assert.equal(harness.faux.state.callCount, 2);
	assert.equal(state(harness).workset.review.used, 0);
	assert.equal(trace.entries.some((entry) => entry.event === "input" && entry.detail?.source === "extension"), false);
	assert.deepEqual(harness.errors, []);
});

test("production barrier never continues an aborted tool interaction", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([open(), fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3; echo fixture" }))]);
	const running = harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "tool_start" && entry.detail?.toolName === "bash");
	await harness.session.abort();
	await running;
	assert.equal(harness.faux.state.callCount, 2);
	assert.equal(state(harness).workset.review.used, 0);
	assert.equal(trace.entries.some((entry) => entry.event === "input" && entry.detail?.source === "extension"), false);
	assert.deepEqual(harness.errors, []);
});

for (const reopen of [false, true]) {
	test(`unknown prepared input before ${reopen ? "re-enrollment" : "enrollment"} permits explicit alignment but grants no review credit`, async (t) => {
		const trace = createTrace();
		const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
		t.after(() => harness.dispose());
		harness.faux.setResponses([
			...(reopen ? [open(), fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "close", expectedRevision: 1, outcome: "cancelled", reason: "old work cancelled" } as never))] : []),
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.15; echo fixture" })),
			open(),
			fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: reopen ? 3 : 1, taskId: reopen ? "T-2" : "T-1", alignInputGeneration: 0 } as never)),
			fauxAssistantMessage("aligned existing work without new authority"),
		]);
		const running = harness.session.prompt("go");
		await waitForTrace(trace, (entry) => entry.event === "tool_start" && entry.detail?.toolName === "bash");
		await harness.session.prompt("queued intent", { streamingBehavior: "steer" });
		await running;
		assert.equal(state(harness).workset.alignment.deliveryUnavailable, undefined);
		assert.equal(state(harness).workset.alignment.state, "aligned");
		assert.equal(Object.values(state(harness).attempts).length, 1, "explicit inline alignment permits already authorized work");
		assert.equal(state(harness).workset.review.used, 1, "unknown enrollment has no fresh automatic allowance");
		assert.deepEqual(state(harness).workset.authorityReferences, []);
		const result = harness.session.state.messages.findLast((message) => message.role === "toolResult" && message.toolName === "csheng_workflow") as { details: { ok: boolean; code: string } };
		assert.equal(result.details.ok, true);
		assert.deepEqual(harness.errors, []);
	});
}

test("reload after a post-close unknown input cannot replenish automatic credit from history", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		open(), fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "close", expectedRevision: 1, outcome: "cancelled", reason: "cancelled" } as never)),
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.15; echo fixture" })), fauxAssistantMessage("closed"),
	]);
	const running = harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "tool_start" && entry.detail?.toolName === "bash");
	await harness.session.prompt("unknown queued intent", { streamingBehavior: "steer" });
	await running;
	assert.equal(state(harness).workset.disposition, "closed");
	assert.equal(state(harness).workset.alignment.deliveryUnavailable, undefined, "closed history is not rewritten by later delivery");
	await harness.session.reload();
	harness.faux.setResponses([
		open(), fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "start", expectedRevision: 3, taskId: "T-2", alignInputGeneration: 0 } as never)),
		fauxAssistantMessage("existing authority confirmed, no new credit"),
	]);
	await harness.session.sendUserMessage("extension-origin resume");
	assert.equal(state(harness).workset.alignment.state, "aligned");
	assert.equal(Object.values(state(harness).attempts).length, 1);
	assert.equal(state(harness).workset.review.used, 1);
	assert.deepEqual(state(harness).workset.authorityReferences, []);
	assert.deepEqual(harness.errors, []);
});

for (const mode of ["print", "json"] as const) {
	test(`production ${mode} mode keeps the ledger but does not start an automatic turn`, async (t) => {
		const harness = await createHostHarness({ mode, extensions: [workflowExtension] });
		t.after(() => harness.dispose());
		harness.faux.setResponses([open(), fauxAssistantMessage("premature stop")]);
		await harness.session.prompt("go");
		assert.equal(harness.faux.state.callCount, 2);
		assert.equal(state(harness).workset.review.used, 0);
		assert.match(state(harness).workset.review.pausedReason!, /mode_unsupported/);
		assert.deepEqual(harness.errors, []);
	});
}
