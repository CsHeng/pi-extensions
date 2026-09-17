import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerManagedContext } from "../extensions/subagents/context.ts";
import { SUBAGENT_SESSION_TOOL_NAME } from "../extensions/subagents/session-contracts.ts";
import type { SessionView } from "../extensions/subagents/session-contracts.ts";
import {
	createHostHarness,
	createTrace,
	createTraceObserver,
	waitForTrace,
	type Trace,
} from "./fixtures/workflow/host-fixture.ts";

const view: SessionView = { handle: "session_example", role: "worker", episode: 2, state: "idle", reportComplete: true };

const injections = (trace: Trace): number =>
	trace.entries.filter((entry) => entry.event === "context" && String(entry.detail?.roles ?? "").includes("custom")).length;
const requests = (trace: Trace): number => trace.entries.filter((entry) => entry.event === "context").length;

test("managed index reaches one delivered input once across a multi-request tool turn", async (t) => {
	const trace = createTrace();
	let reads = 0;
	const scenario: (pi: ExtensionAPI) => void = (pi) => {
		pi.registerTool({
			name: SUBAGENT_SESSION_TOOL_NAME,
			label: "Managed sessions",
			description: "Fixture stub so the managed context guard stays exercised.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "stub" }], details: {} };
			},
		});
		registerManagedContext(pi, async () => {
			reads += 1;
			return [view];
		});
	};
	const harness = await createHostHarness({ trace, extensions: [scenario, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.2; echo TOOL_OK" })),
		fauxAssistantMessage("after tool"),
	]);

	await harness.session.prompt("first");
	assert.equal(requests(trace), 2, "one tool turn makes two provider requests");
	assert.equal(injections(trace), 1, "the index is injected for the delivered input, not per provider request");
	assert.equal(reads, 1);
	assert.ok(trace.entries.some((entry) => entry.event === "tool_end" && entry.detail?.isError === false));

	await harness.session.prompt("second");
	assert.equal(injections(trace), 2, "a new delivered input opens a new window");
	assert.equal(reads, 2);
});

test("extension-origin messages do not open a managed index window", async (t) => {
	const trace = createTrace();
	let reads = 0;
	const scenario: (pi: ExtensionAPI) => void = (pi) => {
		pi.registerTool({
			name: SUBAGENT_SESSION_TOOL_NAME,
			label: "Managed sessions",
			description: "Fixture stub so the managed context guard stays exercised.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "stub" }], details: {} };
			},
		});
		registerManagedContext(pi, async () => {
			reads += 1;
			return [view];
		});
	};
	const harness = await createHostHarness({ trace, extensions: [scenario, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("extension-origin")]);

	await harness.session.prompt("first");
	await harness.session.sendUserMessage("EXTENSION-ORIGIN");

	assert.equal(injections(trace), 1, "only the delivered human input carries the index");
	assert.equal(reads, 1);
	assert.ok(trace.entries.some((entry) => entry.event === "input" && entry.detail?.text === "EXTENSION-ORIGIN" && entry.detail?.source === "extension"));
});

test("a failed provider request keeps the index for its retry instead of multiplying it", async (t) => {
	const trace = createTrace();
	let reads = 0;
	const scenario: (pi: ExtensionAPI) => void = (pi) => {
		pi.registerTool({
			name: SUBAGENT_SESSION_TOOL_NAME,
			label: "Managed sessions",
			description: "Fixture stub so the managed context guard stays exercised.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "stub" }], details: {} };
			},
		});
		registerManagedContext(pi, async () => {
			reads += 1;
			return [view];
		});
	};
	const harness = await createHostHarness({ trace, extensions: [scenario, createTraceObserver(trace)] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: synthetic transient" }),
		fauxAssistantMessage("recovered"),
	]);

	await harness.session.prompt("retry");
	assert.equal(injections(trace), 2, "the failed attempt and its retry each carry the index");
	assert.equal(reads, 2);
	assert.equal(trace.entries.filter((entry) => entry.event === "agent_end" && entry.detail?.stopReason === "stop").length, 1);
});

test("transformed queued model inputs receive non-authorizing reference without claiming human provenance", async (t) => {
	const trace = createTrace();
	let reads = 0;
	const scenario: (pi: ExtensionAPI) => void = (pi) => {
		pi.registerTool({
			name: SUBAGENT_SESSION_TOOL_NAME,
			label: "Managed sessions",
			description: "Fixture stub so the managed context guard stays exercised.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "stub" }], details: {} };
			},
		});
		registerManagedContext(pi, async () => {
			reads += 1;
			return [view];
		});
		// Registered after the injection, so this sees the provider's final message list.
		pi.on("context", (event) => {
			const users = event.messages
				.filter((message) => message.role === "user")
				.map((message) => {
					const content = message.content;
					if (typeof content === "string") return content;
					return Array.isArray(content)
						? content.filter((part) => (part as { type?: string }).type === "text").map((part) => (part as { text?: string }).text ?? "").join("")
						: "";
				})
				.join("|");
			trace.record("context-final", {
				users,
				hasIndex: event.messages.some((message) => message.role === "custom" && String(message.content).startsWith("Stored local-task index;")),
				deliveryUnavailable: event.messages.some((message) => message.role === "custom" && String(message.content).startsWith("Native input delivery identity is unavailable")),
			});
		});
	};
	const harness = await createHostHarness({ trace, extensions: [scenario, createTraceObserver(trace)], templates: { "wf-template": "control" } });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3; echo TOOL_OK" })),
		fauxAssistantMessage("after tool"),
		fauxAssistantMessage("extra"),
	]);

	const running = harness.session.prompt("start");
	await waitForTrace(trace, (entry) => entry.event === "tool_start");
	await harness.session.prompt("human follow-up", { streamingBehavior: "followUp" });
	await harness.session.sendUserMessage("/wf-template", { deliverAs: "steer", expandPromptTemplates: true });
	await running;

	const finals = trace.entries.filter((entry) => entry.event === "context-final");
	const steerRequest = finals.findIndex((entry) => String(entry.detail?.users ?? "").includes("control"));
	const humanRequest = finals.findIndex((entry) => String(entry.detail?.users ?? "").includes("human follow-up"));
	assert.ok(steerRequest >= 0, "the extension steer reached the provider");
	assert.ok(humanRequest > steerRequest, "the queued human follow-up reached the provider after the steer");
	assert.equal(finals[steerRequest]?.detail?.hasIndex, true, "unknown native context can receive non-authorizing metadata");
	assert.equal(finals[humanRequest]?.detail?.hasIndex, true, "actual follow-up preparation receives reference too");
	assert.equal(finals[steerRequest]?.detail?.deliveryUnavailable, false);
	assert.equal(finals[humanRequest]?.detail?.deliveryUnavailable, false);
	assert.equal(reads, 3, "initial input plus the two actual model-bound native inputs, not queue receipts");
});
