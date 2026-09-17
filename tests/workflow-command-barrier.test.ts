import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";

test("public command wait armed during a run crosses every later settlement handler before ordinary re-entry", async (t) => {
	const trace = createTrace();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let first = true;
	const spike = (pi: ExtensionAPI) => {
		pi.registerCommand("wf-barrier-spike", { handler: async (_args, ctx) => {
			trace.record("wait:armed", { idle: ctx.isIdle() });
			await ctx.waitForIdle();
			trace.record("wait:resolved");
			pi.sendUserMessage("ordinary reconciliation");
		} });
		pi.on("agent_start", () => {
			if (!first) return;
			first = false;
			// Do not await this command from the event handler: it is waiting for this run to end.
			pi.sendUserMessage("/wf-barrier-spike", { expandPromptTemplates: true });
		});
	};
	const later = (pi: ExtensionAPI) => {
		let firstSettlement = true;
		pi.on("agent_settled", async (_event, ctx) => {
			if (!firstSettlement) return;
			firstSettlement = false;
			trace.record("later:blocked", { idle: ctx.isIdle() });
			await gate;
			trace.record("later:finished");
		});
	};
	const harness = await createHostHarness({ trace, extensions: [spike, createTraceObserver(trace), later] });
	t.after(async () => { release(); await harness.dispose(); });
	harness.faux.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("reconciled")]);
	const running = harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "later:blocked");
	assert.equal(trace.entries.find((entry) => entry.event === "wait:armed")?.detail?.idle, false);
	assert.equal(trace.entries.find((entry) => entry.event === "later:blocked")?.detail?.idle, true);
	assert.equal(trace.entries.some((entry) => entry.event === "wait:resolved"), false, "isIdle true cannot release the early-armed waiter");
	release();
	await running;
	await waitForTrace(trace, () => trace.entries.filter((entry) => entry.event === "native:agent_settled").length === 2);
	const at = (name: string) => trace.entries.findIndex((entry) => entry.event === name);
	assert.ok(at("later:finished") < at("native:agent_settled"));
	assert.ok(at("native:agent_settled") < at("wait:resolved"));
	const inputs = trace.entries.filter((entry) => entry.event === "input");
	assert.equal(inputs.length, 2, "the internal command itself is not persisted/delivered as model input");
	assert.equal(inputs[1]!.detail?.source, "extension");
	assert.equal(trace.entries.filter((entry) => entry.event === "before_agent_start").length, 2);
	assert.deepEqual(harness.errors, []);
});

test("a captured public run signal prevents command-wait continuation after abort", async (t) => {
	const trace = createTrace();
	let signal: AbortSignal | undefined;
	const spike = (pi: ExtensionAPI) => {
		pi.registerCommand("wf-abort-spike", { handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!signal || signal.aborted) { trace.record("wait:cancelled"); return; }
			pi.sendUserMessage("must not run");
		} });
		pi.on("agent_start", (_event, ctx) => {
			signal = ctx.signal;
			pi.sendUserMessage("/wf-abort-spike", { expandPromptTemplates: true });
		});
	};
	const harness = await createHostHarness({ trace, extensions: [spike, createTraceObserver(trace)], tokensPerSecond: 20 });
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("running ".repeat(100))]);
	const running = harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "agent_start");
	assert.ok(signal, "the active hook exposes the public abort signal");
	await harness.session.abort();
	await running;
	await waitForTrace(trace, (entry) => entry.event === "wait:cancelled");
	assert.equal(harness.faux.state.callCount, 1);
	assert.equal(trace.entries.filter((entry) => entry.event === "before_agent_start").length, 1);
	assert.deepEqual(harness.errors, []);
});
