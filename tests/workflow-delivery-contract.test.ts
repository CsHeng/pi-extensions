import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";

/** Characterization of an UNSATISFIED contract, not evidence that AC-04 is implemented. */
test("Pi 0.86.0 loses source/receipt identity between mixed queued input and transformed native delivery", async (t) => {
	const trace = createTrace();
	const inputs: Array<{ source: string; text: string }> = [];
	const deliveries: Array<{ keys: string[]; content: unknown }> = [];
	const observer = (pi: ExtensionAPI) => {
		pi.on("input", (event) => { inputs.push({ source: event.source, text: event.text }); });
		pi.on("message_start", (event) => {
			if (event.message.role !== "user") return;
			assert.deepEqual(Object.keys(event).sort(), ["message", "type"]);
			deliveries.push({ keys: Object.keys(event.message).sort(), content: event.message.content });
		});
	};
	const harness = await createHostHarness({ trace, templates: { "wf-control": "identical delivered text" }, extensions: [observer, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.15; echo fixture" })),
		fauxAssistantMessage("after steer"), fauxAssistantMessage("after follow-up"),
	]);
	const running = harness.session.prompt("initial");
	await waitForTrace(trace, (entry) => entry.event === "tool_start");
	await harness.session.prompt("identical delivered text", { streamingBehavior: "followUp" });
	await harness.session.sendUserMessage("/wf-control", { deliverAs: "steer", expandPromptTemplates: true });
	await running;
	assert.deepEqual(inputs.slice(1), [
		{ source: "interactive", text: "identical delivered text" }, { source: "extension", text: "/wf-control" },
	]);
	assert.equal(deliveries.length, 3);
	assert.deepEqual(deliveries[1]!.content, deliveries[2]!.content, "opposite origins may yield identical expanded payloads");
	for (const delivery of deliveries) assert.deepEqual(delivery.keys, ["content", "role", "timestamp"], "native delivery supplies no source or stable input receipt identity");
	assert.deepEqual(harness.errors, []);
});
