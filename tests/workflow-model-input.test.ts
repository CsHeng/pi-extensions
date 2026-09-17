import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowExtension from "../extensions/workflow/index.ts";
import type { WorksetState } from "../extensions/workflow/contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness } from "./fixtures/workflow/host-fixture.ts";
const open = () => fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "open", expectedRevision: 0, goal: "Authorized original goal", deliveryEndpoint: "source", criteria: [{ key: "c", outcome: "criterion", verification: "check" }], tasks: [{ key: "t", outcome: "task", covers: ["c"] }] } as never));
const state = (harness: HostHarness): WorksetState => (harness.session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state") as { data: { state: WorksetState } }).data.state;

for (const handledSource of ["interactive", "extension"] as const) {
	test(`real host: handled ${handledSource} receipt leaves mixed provenance conservative, not a task lock`, async (t) => {
		const trace = createTrace();
		const handler = (pi: ExtensionAPI) => {
			pi.on("input", (event) => event.text === "handled without inference" ? { action: "handled" } : undefined);
		};
		const harness = await createHostHarness({ trace, extensions: [workflowExtension, handler, createTraceObserver(trace)] });
		t.after(() => harness.dispose());
		harness.faux.setResponses([
			open(), fauxAssistantMessage("premature stop"),
			fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "pause", expectedRevision: 2, reason: "fixture" } as never)),
			fauxAssistantMessage("paused"),
		]);
		await harness.session.prompt("go");
		await waitForTrace(trace, () => trace.entries.filter((entry) => entry.event === "native:agent_settled").length === 2);
		const before = structuredClone(state(harness));
		assert.equal(before.workset.review.used, 1);
		await harness.session.prompt("handled without inference", { source: handledSource });
		assert.deepEqual(state(harness), before, "handled receipt never mutates alignment or credit");
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("csheng_workflow", {
				operation: "align", expectedRevision: before.revision + 1,
				inputGeneration: before.workset.inputGeneration + 1, action: "confirm",
			} as never)), fauxAssistantMessage("aligned existing authority"),
		]);
		await harness.session.prompt("actual prepared input", { source: handledSource === "interactive" ? "extension" : "interactive" });
		const after = state(harness);
		assert.equal(after.workset.inputGeneration, before.workset.inputGeneration + 1);
		const delivered = harness.session.sessionManager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state" && (entry.data as { state: WorksetState }).state.revision === before.revision + 1) as { data: { state: WorksetState } };
		assert.equal(delivered.data.state.workset.alignment.deliveryUnavailable, true);
		assert.equal(after.workset.alignment.state, "aligned");
		assert.deepEqual(after.workset.authorityReferences, before.workset.authorityReferences);
		assert.equal(after.workset.goal, before.workset.goal);
		assert.equal(after.workset.review.used, 1, "ambiguous origin never grants fresh credit");
		assert.deepEqual(harness.errors, []);
	});
}

for (const replace of [false, true]) {
	test(`real host: queued draft ${replace ? "edited before delivery" : "withdrawn"} does not become effective intent`, async (t) => {
		const trace = createTrace();
		const prepared: string[][] = [];
		const observe = (pi: ExtensionAPI) => {
			pi.on("context", (event) => { prepared.push(event.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""))); });
		};
		const harness = await createHostHarness({ trace, extensions: [workflowExtension, createTraceObserver(trace), observe] });
		t.after(() => harness.dispose());
		harness.faux.setResponses([
			open(), fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3; echo fixture" } as never)),
			...(replace ? [fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "align", expectedRevision: 2, inputGeneration: 1, action: "confirm" } as never)), fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "pause", expectedRevision: 3, reason: "fixture done" } as never))]
				: [fauxAssistantMessage("premature stop"), fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "pause", expectedRevision: 2, reason: "bounded continuation proved" } as never))]),
			fauxAssistantMessage("paused"),
		]);
		const running = harness.session.prompt("go");
		await waitForTrace(trace, (entry) => entry.event === "tool_start" && entry.detail?.toolName === "bash");
		const before = structuredClone(state(harness));
		await harness.session.prompt("discarded queued draft", { streamingBehavior: "followUp" });
		assert.deepEqual(state(harness), before, "receipt cannot dirty alignment, reset credit or change obligations");
		assert.deepEqual(harness.session.clearQueue().followUp, ["discarded queued draft"]);
		if (replace) await harness.session.prompt("actually sent replacement", { streamingBehavior: "steer" });
		assert.deepEqual(state(harness), before, "replacement is still just queued at this point");
		await running;
		if (!replace) await waitForTrace(trace, () => trace.entries.filter((entry) => entry.event === "native:agent_settled").length === 2);
		assert.equal(prepared.some((messages) => messages.includes("discarded queued draft")), false);
		assert.equal(prepared.some((messages) => messages.includes("actually sent replacement")), replace);
		assert.equal(state(harness).workset.inputGeneration, replace ? 1 : 0);
		assert.equal(state(harness).workset.goal, "Authorized original goal");
		assert.equal(state(harness).workset.disposition, "paused");
		assert.equal(state(harness).workset.review.used, replace ? 0 : 1, "discarded receipts are not lasting review vetoes; unknown participation is not a refill");
		assert.deepEqual(harness.errors, []);
	});
}
