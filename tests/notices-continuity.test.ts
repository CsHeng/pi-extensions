import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notifications from "../extensions/notices/index.ts";
import { EXECUTION_FACTS_EVENT, NOTICE_ACK, NOTICE_TYPE, EXECUTION_FACTS_REQUEST, type ProducerFacts } from "../extensions/shared/execution-facts.ts";
import { createHostHarness, waitForTrace, type HostHarness } from "./fixtures/host-fixture.ts";

function publisher() {
	let ctx: ExtensionContext;
	let pi: ExtensionAPI;
	const facts: ProducerFacts = { version: 1, producer: "async-bash", availability: "ready", sessionId: null, branchAnchor: null, generation: "1", executions: [] };
	const acks: string[][] = [];
	const publish = () => pi.events.emit(EXECUTION_FACTS_EVENT, facts);
	const extension = (api: ExtensionAPI) => {
		pi = api;
		pi.events.on(EXECUTION_FACTS_REQUEST, (raw: any) => raw.accept(facts));
		pi.events.on(NOTICE_ACK, (raw: any) => acks.push(raw.ids));
		pi.on("session_start", (_event, context) => { ctx = context; facts.sessionId = ctx.sessionManager.getSessionId(); });
		pi.registerTool({ name: "bash", label: "Fixture", description: "Publish a completion or perform ordinary work", parameters: Type.Object({ finish: Type.Optional(Type.Boolean()) }),
			async execute(_id, input) {
				if (input.finish) {
					facts.branchAnchor = ctx.sessionManager.getLeafId();
					facts.executions = [{ id: "fixture-result", phase: "terminal", status: "exited", exitCode: 0, summary: "Fixture execution finished successfully.", disposition: "pending" }];
					publish();
				}
				return { content: [{ type: "text", text: "ordinary tool receipt" }], details: undefined };
			} });
	};
	return { extension, facts, acks, publish };
}

const ordinaryTool = () => fauxAssistantMessage(fauxToolCall("bash", {}));
const finishTool = () => fauxAssistantMessage(fauxToolCall("bash", { finish: true }));

function noticeMessages(context: TranscriptContext) {
	return context.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Fixture execution finished successfully."));
}

for (const first of [true, false]) test(`completion remains a persisted provider-input prefix across ordinary tools (consumer first: ${first})`, async t => {
	const source = publisher();
	const h = await createHostHarness({ extensions: first ? [notifications, source.extension] : [source.extension, notifications], realSessionFile: true });
	t.after(() => h.dispose());
	const requests: TranscriptContext[] = [];
	const tool = (finish = false) => fauxAssistantMessage(fauxToolCall("bash", { finish }));
	h.faux.setResponses([tool(true), tool(), tool(), fauxAssistantMessage("done")].map(response => context => { requests.push(structuredClone(context)); return response; }));
	await h.session.prompt("exercise completion delivery");
	assert.equal(requests.length, 4);
	assert.equal(noticeMessages(requests[0]!).length, 0);
	for (let i = 1; i < requests.length; i++) {
		assert.equal(noticeMessages(requests[i]!).length, 1, "the completion stays available, not just for one request");
		assert.deepEqual(requests[i]!.messages.slice(0, requests[i - 1]!.messages.length), requests[i - 1]!.messages, "complete previous provider messages remain a prefix, including system/tool declarations");
	}
	const notices = h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE);
	assert.equal(notices.length, 1, "one native history entry, not a transient request projection");
	assert.deepEqual(source.acks, [["fixture-result"]]);
	assert.deepEqual(h.errors, []);
});

for (const disposition of ["returning", "observed"] as const) test(`foreground ${disposition} result wins before native notification admission`, async t => {
	const source = publisher();
	const foreground = (pi: ExtensionAPI) => pi.on("tool_result", () => {
		if (source.facts.executions[0]) { source.facts.executions[0].disposition = disposition; source.publish(); }
	});
	const h = await createHostHarness({ extensions: [notifications, source.extension, foreground] });
	t.after(() => h.dispose());
	const requests: TranscriptContext[] = [];
	h.faux.setResponses([finishTool(), fauxAssistantMessage("done")].map(response => context => { requests.push(structuredClone(context)); return response; }));
	await h.session.prompt("observe the result in the foreground");
	assert.equal(requests.length, 2);
	assert.equal(noticeMessages(requests[1]!).length, 0);
	assert.deepEqual(source.acks, []);
	assert.equal(h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length, 0);
	assert.deepEqual(h.errors, []);
});

for (const interruption of ["input", "abort"] as const) test(`${interruption} before the tool boundary suppresses the pending completion without acknowledgment`, async t => {
	const source = publisher();
	let h: HostHarness;
	let interrupted = false;
	const interrupt = (pi: ExtensionAPI) => pi.on("tool_result", async () => {
		if (interrupted) return;
		interrupted = true;
		if (interruption === "input") await h.session.prompt("new user direction", { streamingBehavior: "steer" });
		else void h.session.abort();
	});
	h = await createHostHarness({ extensions: [notifications, source.extension, interrupt] });
	t.after(() => h.dispose());
	h.faux.setResponses([finishTool(), fauxAssistantMessage("done")]);
	await h.session.prompt("start work");
	assert.equal(h.faux.state.callCount, interruption === "abort" ? 1 : 2);
	assert.equal(h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length, 0);
	assert.deepEqual(source.acks, []);
	assert.deepEqual(h.errors, []);
});

test("provider retry retains the same native notification and does not acknowledge twice", async t => {
	const source = publisher();
	const h = await createHostHarness({ extensions: [notifications, source.extension] });
	t.after(() => h.dispose());
	const requests: TranscriptContext[] = [];
	h.faux.setResponses([finishTool(), fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: synthetic transient" }), ordinaryTool(), fauxAssistantMessage("done")]
		.map(response => context => { requests.push(structuredClone(context)); return response; }));
	await h.session.prompt("retry without rewriting completion evidence");
	assert.equal(requests.length, 4);
	for (const request of requests.slice(1)) assert.equal(noticeMessages(request).length, 1);
	assert.deepEqual(noticeMessages(requests[1]!), noticeMessages(requests[2]!));
	assert.deepEqual(source.acks, [["fixture-result"]]);
	assert.deepEqual(h.errors, []);
});

for (const retried of [true, false]) test(`a result that becomes ready during a failed request reaches the main agent ${retried ? "through the retry" : "after the final error"}`, async t => {
	const source = publisher();
	const h = await createHostHarness({ extensions: [notifications, source.extension], settings: { retry: { maxRetries: retried ? 1 : 0, baseDelayMs: 5 } } });
	t.after(() => h.dispose());
	const requests: TranscriptContext[] = [];
	const failing = (context: TranscriptContext) => {
		requests.push(structuredClone(context));
		source.facts.branchAnchor = h.session.sessionManager.getLeafId();
		source.facts.executions = [{ id: "fixture-result", phase: "terminal", status: "exited", exitCode: 0, summary: "Fixture execution finished successfully.", disposition: "pending" }];
		source.publish();
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: synthetic transient" });
	};
	const later = (retried ? [ordinaryTool(), fauxAssistantMessage("done")] : [fauxAssistantMessage("noted")])
		.map(response => (context: TranscriptContext) => { requests.push(structuredClone(context)); return response; });
	h.faux.setResponses([failing, ...later]);
	await h.session.prompt("work while a background result finishes");
	await waitForTrace(h.trace, () => h.faux.state.callCount >= (retried ? 3 : 2));
	await h.session.waitForIdle();
	assert.equal(requests.length, retried ? 3 : 2);
	assert.equal(noticeMessages(requests[0]!).length, 0);
	for (const request of requests.slice(retried ? 2 : 1)) assert.equal(noticeMessages(request).length, 1, "the main agent sees the result after the error");
	assert.equal(h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length, 1);
	assert.deepEqual(source.acks, [["fixture-result"]]);
	assert.deepEqual(h.errors, []);
});

for (const compact of [false, true]) test(`resume deduplicates persisted completions${compact ? " after compaction" : " and preserves them in subsequent requests"}`, async t => {
	const source = publisher();
	const compactor = (pi: ExtensionAPI) => pi.on("session_before_compact", (event, ctx) => ({ compaction: {
		summary: "Fixture execution finished successfully; its completion was already delivered.",
		firstKeptEntryId: ctx.sessionManager.getLeafId()!, tokensBefore: event.preparation.tokensBefore,
	} }));
	const h = await createHostHarness({ extensions: [notifications, source.extension, compactor], settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } } });
	t.after(() => h.dispose());
	h.faux.setResponses([finishTool(), fauxAssistantMessage("done")]);
	await h.session.prompt("record a completion");
	if (compact) await h.session.compact();
	const countBefore = h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length;
	const recovered = publisher();
	recovered.facts.executions = structuredClone(source.facts.executions); // A producer can still report pending after reload; history must deduplicate it.
	const next = await createHostHarness({ extensions: [notifications, recovered.extension], sessionManager: h.session.sessionManager, sessionStartReason: "resume" });
	t.after(() => next.dispose());
	assert.equal(next.faux.state.callCount, 0, "restoration does not create a completion wake");
	const requests: TranscriptContext[] = [];
	next.faux.setResponses([ordinaryTool(), fauxAssistantMessage("continued")].map(response => context => { requests.push(structuredClone(context)); return response; }));
	await next.session.prompt("continue normally");
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages);
	if (!compact) for (const request of requests) assert.equal(noticeMessages(request).length, 1);
	assert.equal(next.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length, countBefore);
	assert.deepEqual(h.errors, []);
	assert.deepEqual(next.errors, []);
});

test("an earlier native custom queue may observe the result before notification admission", async t => {
	const source = publisher();
	let queued = false;
	const earlierQueue = (pi: ExtensionAPI) => {
		pi.on("tool_result", () => {
			if (queued) { source.facts.executions[0]!.disposition = "observed"; source.publish(); return; }
			queued = true;
			pi.sendMessage({ customType: "fixture-other", content: "Inspect the result in the foreground.", display: false }, { deliverAs: "steer" });
		});
	};
	const h = await createHostHarness({ extensions: [notifications, source.extension, earlierQueue] });
	t.after(() => h.dispose());
	const requests: TranscriptContext[] = [];
	h.faux.setResponses([finishTool(), ordinaryTool(), fauxAssistantMessage("done")].map(response => context => { requests.push(structuredClone(context)); return response; }));
	await h.session.prompt("respect native custom queue ordering");
	assert.equal(requests.length, 3);
	for (const request of requests) assert.equal(noticeMessages(request).length, 0);
	assert.deepEqual(source.acks, []);
	assert.deepEqual(h.errors, []);
});

test("abort after a native boundary proposal prevents continuation, not retention of committed history", async t => {
	const source = publisher();
	let h: HostHarness;
	let once = false;
	const lateAbort = (pi: ExtensionAPI) => pi.on("turn_end", event => {
		if (!once && event.entries.some(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE)) {
			once = true;
			void h.session.abort();
		}
	});
	h = await createHostHarness({ extensions: [notifications, source.extension, lateAbort] });
	t.after(() => h.dispose());
	h.faux.setResponses([finishTool(), fauxAssistantMessage("must not automatically run")]);
	await h.session.prompt("stop at the admission boundary");
	assert.equal(h.faux.state.callCount, 1, "abort cancels automatic continuation");
	assert.deepEqual(source.acks, [], "a committed message was not yet prepared for the model");
	assert.equal(h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length, 1);
	const requests: TranscriptContext[] = [];
	h.faux.setResponses([ordinaryTool(), fauxAssistantMessage("continued by user")].map(response => context => { requests.push(structuredClone(context)); return response; }));
	await h.session.prompt("explicitly resume");
	assert.equal(requests.length, 2);
	assert.equal(noticeMessages(requests[0]!).length, 1, "committed historical evidence is not removed to implement cancellation");
	assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages);
	assert.deepEqual(source.acks, [["fixture-result"]]);
	assert.deepEqual(h.errors, []);
});

test("tree navigation neither carries a sibling notice nor resends a restored branch notice", async t => {
	const source = publisher();
	const h = await createHostHarness({ extensions: [notifications, source.extension] });
	t.after(() => h.dispose());
	h.faux.setResponses([finishTool(), fauxAssistantMessage("done")]);
	await h.session.prompt("record branch-local evidence");
	const originalLeaf = h.session.sessionManager.getLeafId()!;
	const user = h.session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
	const executions = structuredClone(source.facts.executions);
	source.facts.executions = []; // Real producers expose no off-branch executions.
	await h.session.navigateTree(user.id, { summarize: false });
	const requests: TranscriptContext[] = [];
	h.faux.setResponses([ordinaryTool(), fauxAssistantMessage("other branch")].map(response => context => { requests.push(structuredClone(context)); return response; }));
	await h.session.prompt("independent branch");
	assert.equal(requests.length, 2);
	for (const request of requests) assert.equal(noticeMessages(request).length, 0);
	assert.deepEqual(source.acks, [["fixture-result"]]);
	await h.session.navigateTree(originalLeaf, { summarize: false });
	source.facts.executions = executions;
	source.publish();
	assert.equal(h.faux.state.callCount, 4, "restoring a recorded completion does not wake the model");
	const continued: TranscriptContext[] = [];
	h.faux.setResponses([ordinaryTool(), fauxAssistantMessage("original branch")].map(response => context => { continued.push(structuredClone(context)); return response; }));
	await h.session.prompt("continue the original branch");
	for (const request of continued) assert.equal(noticeMessages(request).length, 1);
	assert.equal(h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === NOTICE_TYPE).length, 1);
	assert.deepEqual(h.errors, []);
});
