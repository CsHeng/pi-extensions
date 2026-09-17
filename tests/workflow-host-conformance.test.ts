import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isUserInputSource } from "../extensions/workflow/host-adapter.ts";
import { createPreparedInputTracker } from "../extensions/shared/prepared-input.ts";
import {
	createHostHarness,
	createTrace,
	createTraceObserver,
	waitForTrace,
	type Trace,
} from "./fixtures/workflow/host-fixture.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test-local characterization of the unsafe continuation shape: a macrotask scheduled from a
 * settlement handler after an idle re-check. It exists only to prove why the workflow extension
 * does not use it; production code has no such capability.
 */
function macrotask(host: { isIdle(): boolean; hasPendingMessages(): boolean }, action: () => void): () => void {
	const timer = setTimeout(() => {
		try {
			if (!host.isIdle() || host.hasPendingMessages()) return;
		} catch {
			return;
		}
		action();
	}, 0);
	return () => clearTimeout(timer);
}
const indexOf = (trace: Trace, event: string, occurrence = 0): number => {
	let seen = 0;
	for (let index = 0; index < trace.entries.length; index += 1) {
		if (trace.entries[index]?.event !== event) continue;
		if (seen === occurrence) return index;
		seen += 1;
	}
	return -1;
};
const countOf = (trace: Trace, event: string): number => trace.entries.filter((entry) => entry.event === event).length;
const detailOf = (trace: Trace, event: string, occurrence = 0): Record<string, unknown> | undefined =>
	trace.entries.filter((entry) => entry.event === event)[occurrence]?.detail;

test("idle extension-origin re-entry runs the ordinary prompt path after settlement", async (t) => {
	const trace = createTrace();
	let dispatched = false;
	const workflow: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("agent_settled", (_event, ctx) => {
			trace.record("wf:settled", { idle: ctx.isIdle() });
			if (dispatched) return;
			dispatched = true;
			macrotask(ctx, () => {
				trace.record("wf:dispatch");
				pi.sendUserMessage("WORKFLOW-REVIEW");
			});
		});
	};
	const harness = await createHostHarness({ trace, extensions: [createTraceObserver(trace), workflow] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("reviewed")]);

	await harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "native:agent_settled" && countOf(trace, "native:agent_settled") >= 2);

	assert.equal(countOf(trace, "native:agent_start"), 2, "review dispatch starts exactly one new run");
	assert.equal(harness.faux.state.callCount, 2);
	assert.ok(indexOf(trace, "native:agent_settled", 0) < indexOf(trace, "wf:dispatch"), "first settlement finishes before dispatch");
	assert.ok(indexOf(trace, "wf:dispatch") < indexOf(trace, "input", 1), "dispatch precedes its own input event");
	assert.deepEqual(detailOf(trace, "input", 1), { source: "extension", text: "WORKFLOW-REVIEW", imageCount: 0 });
	assert.deepEqual(detailOf(trace, "before_agent_start", 1), { prompt: "WORKFLOW-REVIEW" });
	const reviewMessage = trace.entries.filter((entry) => entry.event === "message_start" && entry.detail?.role === "user")[1];
	assert.equal(reviewMessage?.detail?.preview, "WORKFLOW-REVIEW");
	assert.deepEqual(harness.errors, []);
});

test("macrotask settlement dispatch follows the native notification; a microtask does not", async (t) => {
	const trace = createTrace();
	const consumer: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("agent_settled", async () => {
			trace.record("consumer:start");
			await sleep(40);
			trace.record("consumer:end");
		});
	};
	const workflow: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("agent_settled", (_event, ctx) => {
			queueMicrotask(() => trace.record("wf:microtask", { nativeSettled: countOf(trace, "native:agent_settled"), idle: ctx.isIdle() }));
			macrotask(ctx, () => trace.record("wf:macrotask", { nativeSettled: countOf(trace, "native:agent_settled") }));
		});
	};
	const harness = await createHostHarness({ trace, extensions: [createTraceObserver(trace), consumer, workflow] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("done")]);

	await harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "wf:macrotask");

	assert.ok(indexOf(trace, "consumer:start") < indexOf(trace, "consumer:end"));
	assert.ok(indexOf(trace, "consumer:end") < indexOf(trace, "wf:microtask"), "an earlier handler must finish before the next runs");
	assert.ok(indexOf(trace, "wf:microtask") < indexOf(trace, "native:agent_settled"), "a microtask is not a settlement barrier");
	assert.ok(indexOf(trace, "native:agent_settled") < indexOf(trace, "wf:macrotask"), "a macrotask from the last handler follows the native notification");
	assert.equal(detailOf(trace, "wf:microtask")?.nativeSettled, 0);
	assert.equal(detailOf(trace, "wf:macrotask")?.nativeSettled, 1);
});

test("characterization: a settlement consumer registered after the workflow handler races an idle continuation", async (t) => {
	const trace = createTrace();
	let dispatched = false;
	const workflow: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("agent_settled", (_event, ctx) => {
			if (dispatched) return;
			dispatched = true;
			macrotask(ctx, () => {
				trace.record("wf:dispatch");
				pi.sendUserMessage("WORKFLOW-REVIEW");
			});
		});
	};
	const lateConsumer: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("agent_settled", async () => {
			trace.record("late:start");
			await sleep(40);
			trace.record("late:end");
		});
	};
	const harness = await createHostHarness({ trace, extensions: [createTraceObserver(trace), workflow, lateConsumer] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("reviewed")]);

	await harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "late:end" && countOf(trace, "late:end") >= 2);

	// This ordering is exactly why automatic dispatch is disabled in production.
	assert.ok(indexOf(trace, "wf:dispatch") < indexOf(trace, "late:end", 0), "dispatch raced the later async consumer");
	assert.ok(indexOf(trace, "native:agent_settled", 0) > indexOf(trace, "wf:dispatch"), "later consumer delayed the native settlement notification");
	assert.equal(countOf(trace, "native:agent_settled"), 2);
});

test("settlement dispatch is skipped when another run is already active", async (t) => {
	const trace = createTrace();
	let scheduled = false;
	const interferingConsumer: (pi: ExtensionAPI) => void = (pi) => {
		let interfered = false;
		pi.on("agent_settled", () => {
			if (interfered) return;
			interfered = true;
			pi.sendUserMessage("INTERFERING-RUN");
		});
	};
	const workflow: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("agent_settled", (_event, ctx) => {
			if (scheduled) return;
			scheduled = true;
			macrotask(ctx, () => trace.record("wf:dispatch"));
		});
	};
	const harness = await createHostHarness({ trace, extensions: [createTraceObserver(trace), interferingConsumer, workflow] });
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage("first"),
		async () => {
			await sleep(300);
			return fauxAssistantMessage("interfered");
		},
	]);

	await harness.session.prompt("go");
	await waitForTrace(trace, (entry) => entry.event === "native:agent_settled" && countOf(trace, "native:agent_settled") >= 2);

	assert.equal(indexOf(trace, "wf:dispatch"), -1, "workflow dispatch must skip while the interfering run is active");
	assert.ok(trace.entries.some((entry) => entry.event === "input" && entry.detail?.text === "INTERFERING-RUN"));
	assert.equal(harness.faux.state.callCount, 2);
	assert.deepEqual(harness.errors, []);
});

test("real host commits prepared ordinary and queued occurrences without inventing queued origin", async (t) => {
	const trace = createTrace();
	const tracker = createPreparedInputTracker();
	const scenario: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("input", (event) => {
			tracker.received(event);
		});
		pi.on("before_agent_start", () => { tracker.prepare(); });
		pi.on("message_start", (event) => { tracker.observe(event.message); });
		pi.on("context", (event) => {
			for (const input of tracker.peek(event.messages)) {
				if (input.provenance !== "extension") trace.record("delivered", { ...input });
				tracker.commit([input.id]);
			}
		});
		pi.on("agent_settled", (_event, ctx) => { if (!ctx.hasPendingMessages()) tracker.reset(); });
	};
	const harness = await createHostHarness({
		trace,
		extensions: [createTraceObserver(trace), scenario],
		templates: { "wf-template": "EXPANDED-TEMPLATE-BODY" },
	});
	t.after(() => harness.dispose());
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.25; echo TOOL_OK" })),
		fauxAssistantMessage("after tool"),
		fauxAssistantMessage("plain answer"),
		fauxAssistantMessage("plain answer"),
		fauxAssistantMessage("image answer"),
		fauxAssistantMessage("template answer"),
	]);

	const first = harness.session.prompt("tool-turn");
	await waitForTrace(trace, (entry) => entry.event === "tool_start");
	await harness.session.prompt("steer-1", { streamingBehavior: "steer" });
	await harness.session.prompt("follow-1", { streamingBehavior: "followUp" });
	await first;
	await harness.session.prompt("plain-1");
	await harness.session.prompt("plain-1");
	await harness.session.sendUserMessage("EXT-ORIGIN");
	await harness.session.prompt("", { images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
	await harness.session.prompt("/wf-template");
	await waitForTrace(trace, () => countOf(trace, "delivered") >= 7);

	assert.deepEqual(
		trace.entries.filter((entry) => entry.event === "delivered").map((entry) => entry.detail?.provenance),
		["human", "unknown", "unknown", "human", "human", "human", "human"],
	);
	assert.deepEqual(tracker.peek([]), [], "settlement does not retain consumed observations or stale receipts");
	assert.deepEqual(detailOf(trace, "input", 1), { source: "interactive", text: "steer-1", imageCount: 0, streamingBehavior: "steer" });
	assert.deepEqual(detailOf(trace, "input", 2), { source: "interactive", text: "follow-1", imageCount: 0, streamingBehavior: "followUp" });
	assert.equal(trace.entries.filter((entry) => entry.event === "before_agent_start").length, 6, "queued deliveries bypass before_agent_start");
	assert.ok(isUserInputSource("interactive") && isUserInputSource("rpc") && !isUserInputSource("extension"));
});

test("input sees raw text and before_agent_start sees the expanded prompt", async (t) => {
	const trace = createTrace();
	const harness = await createHostHarness({
		trace,
		extensions: [createTraceObserver(trace)],
		templates: { "wf-template": "EXPANDED-TEMPLATE-BODY" },
	});
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("expanded")]);

	await harness.session.prompt("/wf-template");

	assert.deepEqual(detailOf(trace, "input"), { source: "interactive", text: "/wf-template", imageCount: 0 });
	assert.deepEqual(detailOf(trace, "before_agent_start"), { prompt: "EXPANDED-TEMPLATE-BODY" });
});

test("retry settles once after the chain; abort settles without retry", async (t) => {
	const retryTrace = createTrace();
	const retryHarness = await createHostHarness({ trace: retryTrace, extensions: [createTraceObserver(retryTrace)] });
	t.after(() => retryHarness.dispose());
	retryHarness.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: synthetic transient" }),
		fauxAssistantMessage("recovered"),
	]);
	await retryHarness.session.prompt("retry-me");

	assert.equal(countOf(retryTrace, "agent_end"), 2);
	assert.equal(countOf(retryTrace, "agent_settled"), 1);
	assert.equal(detailOf(retryTrace, "agent_end", 0)?.stopReason, "error");
	assert.equal(detailOf(retryTrace, "agent_end", 1)?.stopReason, "stop");
	assert.equal(retryHarness.faux.state.callCount, 2);
	assert.ok(indexOf(retryTrace, "agent_end", 1) < indexOf(retryTrace, "agent_settled"), "settlement follows the retry chain");

	const abortTrace = createTrace();
	const abortHarness = await createHostHarness({ trace: abortTrace, extensions: [createTraceObserver(abortTrace)], tokensPerSecond: 20 });
	t.after(() => abortHarness.dispose());
	abortHarness.faux.setResponses([fauxAssistantMessage("a long streaming answer that is aborted mid flight")]);
	const running = abortHarness.session.prompt("abort-me");
	await sleep(80);
	await abortHarness.session.abort();
	await running;

	assert.equal(abortHarness.faux.state.callCount, 1);
	assert.equal(countOf(abortTrace, "agent_end"), 1);
	assert.equal(detailOf(abortTrace, "agent_end")?.stopReason, "aborted");
	assert.equal(countOf(abortTrace, "agent_settled"), 1);
});

test("custom entries live on the active branch, replay on reload, and stay out of model context", async (t) => {
	const trace = createTrace();
	let appended = 0;
	const scenario: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("before_agent_start", (event) => {
			if (!event.prompt.startsWith("append")) return;
			appended += 1;
			pi.appendEntry("wf-probe", { value: appended });
		});
	};
	const harness = await createHostHarness({ trace, extensions: [createTraceObserver(trace), scenario], realSessionFile: true });
	t.after(() => harness.dispose());
	harness.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

	await harness.session.prompt("append-1");
	await harness.session.prompt("append-2");
	await sleep(50);

	const branch = harness.session.sessionManager.getBranch();
	assert.deepEqual(
		branch.filter((entry) => entry.type === "custom").map((entry) => entry.customType),
		["wf-probe", "wf-probe"],
	);
	assert.ok(!trace.entries.some((entry) => entry.event === "context" && String(entry.detail?.roles).includes("custom")), "custom entries never enter model context");

	const file = harness.session.sessionFile;
	assert.ok(file);
	const reopened = SessionManager.open(file, harness.sessionDir, harness.workDir);
	assert.deepEqual(
		reopened.getBranch().filter((entry) => entry.type === "custom").map((entry) => entry.customType),
		["wf-probe", "wf-probe"],
	);
	const forked = SessionManager.forkFrom(file, harness.workDir, harness.sessionDir);
	assert.deepEqual(
		forked.getBranch().filter((entry) => entry.type === "custom").map((entry) => entry.customType),
		["wf-probe", "wf-probe"],
	);
});
