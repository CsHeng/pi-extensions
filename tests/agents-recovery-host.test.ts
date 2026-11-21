import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRecoveryDiscovery } from "../extensions/agents/recovery-discovery.ts";
import { createHostHarness, waitForTrace } from "./fixtures/host-fixture.ts";

const hint = "agents.recovery-discovery";

for (const mode of ["tui", "rpc"] as const) test(`resumed ${mode} host persists one recovery hint only on human continuation`, async t => {
	let lookups = 0;
	const extension = (pi: ExtensionAPI) => {
		registerRecoveryDiscovery(pi, {
			resolveRecoveryHandles: async (_ctx, handles) => { assert.deepEqual(handles, ["fixture"]); lookups++; return [{ handle: "fixture", label: "fixture-agent", state: "interrupted", role: "worker", episode: 2, reportComplete: false }]; },
			liveObserverTasks: () => [],
		});
		pi.registerTool({ name: "list_agents", label: "Agent fixture", description: "Ordinary fixture tool", parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "ordinary receipt" }], details: { schemaVersion: 5, sessions: [{ handle: "fixture", episode: 2 }] } }; } });
		pi.registerCommand("wake", { description: "Extension-origin wake", handler: async () => { pi.sendUserMessage("extension wake"); } });
	};
	const original = await createHostHarness({ mode, realSessionFile: true, extensions: [extension] });
	t.after(() => original.dispose());
	original.faux.setResponses([fauxAssistantMessage(fauxToolCall("list_agents", {})), fauxAssistantMessage("initial")]);
	await original.session.prompt("start");
	const h = await createHostHarness({ mode, extensions: [extension], sessionManager: original.session.sessionManager, sessionStartReason: "resume" });
	t.after(() => h.dispose());
	const requests: TranscriptContext[] = [];
	const capture = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => { requests.push(structuredClone(context)); return response; };
	h.faux.setResponses([
		capture(fauxAssistantMessage("wake handled")),
		capture(fauxAssistantMessage(fauxToolCall("list_agents", {}))),
		capture(fauxAssistantMessage("continued")),
		capture(fauxAssistantMessage("next turn")),
	]);
	await h.session.prompt("/wake");
	await waitForTrace(h.trace, () => h.faux.state.callCount === 1);
	await h.session.waitForIdle();
	assert.equal(lookups, 0, "extension-origin wake must not consume recovery");
	assert.equal(h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === hint).length, 0);
	await h.session.prompt("continue the work");
	await h.session.prompt("next user turn");
	assert.equal(requests.length, 4);
	assert.equal(lookups, 1);
	const entries = h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === hint);
	assert.equal(entries.length, 1, "hint is a single persisted native entry");
	assert.match(JSON.stringify(entries[0]), /fixture-agent \(worker\): interrupted or aborted; confirm it stopped with stop_agent/);
	assert.doesNotMatch(JSON.stringify(requests[0]), /Agents from this session are available/);
	for (const request of requests.slice(1)) assert.equal(JSON.stringify(request.messages).split("Agents from this session are available").length - 1, 1);
	for (let i = 1; i < requests.length; i++) {
		const { messages: previous, ...previousRest } = requests[i - 1]!;
		const { messages: current, ...currentRest } = requests[i]!;
		assert.deepEqual(currentRest, previousRest, "system prompt and tool declarations remain identical");
		assert.deepEqual(current.slice(0, previous.length), previous, "the complete previous message input remains a prefix");
	}
	assert.deepEqual(h.errors, []);
});
