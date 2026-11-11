import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import noticesExtension from "../extensions/notices/index.ts";
import { decideDelivery, pendingNotices, type DeliveryView } from "../extensions/notices/policy.ts";
import { bindAsyncBash } from "../extensions/async-bash/index.ts";
import { validateBashCall } from "../extensions/async-bash/validate.ts";
import type { BashExecutionOwner } from "../extensions/async-bash/execution.ts";
import { NOTICE_DELIVERY_REQUEST, EXECUTION_FACTS_EVENT, NOTICE_TYPE, type NoticeDeliverySnapshot, type ProducerFacts } from "../extensions/shared/execution-facts.ts";
import { readExecutionQuiescence } from "../extensions/shared/execution-quiescence.ts";
import tasklistExtension from "../extensions/tasklist/index.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/host-fixture.ts";

function tasks(status: string, extra: Partial<ProducerFacts["tasks"]> = {}): ProducerFacts {
	return { version: 1, producer: "tasklist", availability: "ready", sessionId: "s", branchAnchor: "b", generation: "1", executions: [],
		tasks: { revision: 1, title: "Work", tasks: [{ id: "a", title: "Task", status }], ...extra } };
}
function execution(producer: "async-bash" | "agents", phase: "running" | "queued" | "preparing" | "terminal", disposition: "pending" | "returning" | "observed" = "pending", id = producer + "-1"): ProducerFacts {
	return { version: 1, producer, availability: "ready", sessionId: "s", branchAnchor: "b", generation: "1", executions: [{
		id, phase, status: phase, exitCode: phase === "terminal" ? 0 : null,
		summary: phase === "terminal" && disposition === "pending" ? producer + " " + id + " finished" : "",
		disposition,
	}] };
}
function view(partial: Partial<Record<"tasklist" | "async-bash" | "agents", ProducerFacts>>, seen = Object.keys(partial)): DeliveryView {
	return { facts: new Map(Object.entries(partial)), seen: new Set(seen), consumed: new Set(), suppressed: new Set() };
}

test("combined policy delivers actual terminals beside a running sibling, never a task-only wake", () => {
	const running = view({ tasklist: tasks("doing"), "async-bash": execution("async-bash", "running"), agents: execution("agents", "queued", "pending", "child") });
	assert.equal(decideDelivery(running).kind, "none");
	const terminal = view({ tasklist: tasks("doing"), "async-bash": execution("async-bash", "terminal"), agents: execution("agents", "running") });
	const notice = decideDelivery(terminal);
	assert.equal(notice.kind, "notices");
	assert.match(notice.text, /async-bash/);
	assert.equal(notice.notices.length, 1);
	const both = view({ tasklist: tasks("doing"), "async-bash": execution("async-bash", "terminal"), agents: execution("agents", "terminal", "pending", "child") });
	assert.equal(decideDelivery(both).notices.length, 2);
	assert.equal(decideDelivery(both).text.split("\n").length, 2);
	const returned = view({ tasklist: tasks("doing"), "async-bash": execution("async-bash", "terminal", "returning"), agents: execution("agents", "terminal", "observed", "child") });
	assert.equal(pendingNotices(returned).length, 0);
	assert.equal(decideDelivery(returned).kind, "none");
	for (const status of ["todo", "doing", "blocked", "done", "cancelled"]) {
		for (const extra of [{}, { revision: 2 }, { title: "Revised design" }]) {
			assert.equal(decideDelivery(view({ tasklist: tasks(status, extra) })).kind, "none");
		}
	}
	for (const availability of ["unknown", "unavailable", "inactive"] as const) {
		const unavailable = { ...execution("agents", "running"), availability, executions: [] };
		assert.equal(decideDelivery(view({ tasklist: tasks("doing"), agents: unavailable })).kind, "none");
		assert.equal(decideDelivery(view({ tasklist: tasks("doing"), agents: unavailable, "async-bash": execution("async-bash", "terminal") })).kind, "notices");
	}
});

test("malformed bash control calls name the correction and do not describe a started process", () => {
	const bad = validateBashCall({ command: "action=inspect", executionId: "exec_example" });
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.match(bad.message, /executionId requires an explicit control action/);
		assert.match(bad.message, /\{"action":"inspect","executionId":"exec_example"\}/);
		assert.match(bad.message, /No process was started/);
	}
	assert.equal(validateBashCall({ action: "run", executionId: "exec_example" }).ok, false);
	assert.equal(validateBashCall({ action: "inspect" }).ok, false);
	assert.equal(validateBashCall({ action: "wait", executionId: "exec_example", command: "echo hi" }).ok, false);
	assert.equal(validateBashCall({ action: "renew", executionId: "exec_example" }).ok, false);
	assert.equal(validateBashCall({ action: "wait", executionId: "exec_example", waitSeconds: 0 }).ok, false);
	assert.equal(validateBashCall({ command: "bun test" }).ok, true);
	assert.equal(validateBashCall({ action: "inspect", executionId: "exec_example" }).ok, true);
	assert.equal(validateBashCall({ action: "renew", executionId: "exec_example", deadlineSeconds: 30 }).ok, true);
});

test("registered bash rejects the observed malformed payload before start", async () => {
	let started = 0;
	const owner = { startCount: 0, start: async () => { started += 1; throw new Error("started"); }, inspect: () => undefined, list: () => [], subscribeDisplay: () => () => {}, wait: async () => { throw new Error("mutated"); }, renew: () => { throw new Error("mutated"); }, cancel: async () => { throw new Error("mutated"); }, interruptOthers: async () => {}, shutdown: async () => {} } as BashExecutionOwner;
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const pi = {
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }], getActiveTools: () => ["bash"], getSettings: () => ({}),
		events: { emit() {}, on() { return () => {}; } }, registerCommand() {}, sendUserMessage() {}, sendMessage: async () => {},
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }) => { tools.set(tool.name, tool); },
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
	};
	bindAsyncBash(pi as unknown as ExtensionAPI, owner);
	const ctx = { mode: "tui", cwd: "/tmp", sessionManager: { getSessionId: () => "s", getLeafId: () => "b", getBranch: () => [{ id: "b" }] } } as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const tool = tools.get("bash");
	assert.ok(tool);
	const rejected = await tool.execute("call", { command: "action=inspect", executionId: "exec_example" }, undefined, undefined, ctx);
	assert.equal(rejected.isError, true);
	assert.match(rejected.content[0]!.text, /action":"inspect"/);
	assert.equal(started, 0);
	const description = (tool as { description?: string }).description ?? "";
	assert.match(description, /\{"command":"bun test"\}/);
	assert.match(description, /\{"action":"inspect","executionId":"exec_example"\}/);
});

function fakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const sent: string[] = [];
	const messages: Array<{ role: "custom"; customType: string; content?: string; details?: unknown }> = [];
	let idle = true;
	const ctx = { mode: "tui", isIdle: () => idle, hasPendingMessages: () => false, isProjectTrusted: () => true, signal: undefined, sessionManager: { getSessionId: () => "s", getLeafId: () => "b", getBranch: () => [{ id: "b" }] } } as ExtensionContext;
	const pi = {
		getActiveTools: () => ["bash", "tasklist", "agent"],
		events: {
			on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {}; },
			emit: (name: string, data: unknown) => { for (const handler of listeners.get(name) ?? []) handler(data); },
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command.handler); },
		sendUserMessage: (text: string) => { sent.push(text); },
		sendMessage: async (message: { customType: string; content?: string; details?: unknown }) => { sent.push(String(message.content)); messages.push({ role: "custom", ...message }); },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands, sent, messages, ctx, setIdle: (value: boolean) => { idle = value; } };
}

function deliveryState(host: ReturnType<typeof fakePi>): NoticeDeliverySnapshot {
	let result: NoticeDeliverySnapshot | undefined;
	host.pi.events.emit(NOTICE_DELIVERY_REQUEST, { version: 1, accept: (value: NoticeDeliverySnapshot) => { result = value; } });
	assert.ok(result);
	return result;
}
async function hooks(host: ReturnType<typeof fakePi>, name: string, event: unknown = {}): Promise<void> {
	for (const handler of host.handlers.get(name) ?? []) await handler(event, host.ctx);
}

test("read-only delivery state covers pending and reserved wake without withholding a sibling result", async () => {
	const host = fakePi(); noticesExtension(host.pi);
	const shell = execution("async-bash", "running"); shell.executions[0]!.toolCallId = "current";
	const child = execution("agents", "running"); child.executions[0]!.toolCallId = "current";
	host.pi.events.on("notices.snapshot.v1", (raw: any) => { raw.accept(shell); raw.accept(child); });
	await hooks(host, "session_start");
	host.setIdle(false);
	shell.executions[0]!.phase = "terminal";
	shell.executions[0]!.summary = "fixture terminal";
	host.pi.events.emit(EXECUTION_FACTS_EVENT, shell);
	assert.equal(deliveryState(host).pending.length, 1);
	assert.equal(deliveryState(host).scheduled.length, 0);
	host.setIdle(true);
	await hooks(host, "agent_settled");
	assert.equal(host.sent.length, 1, "the running child is not a veto on actual result delivery");
	assert.equal(deliveryState(host).scheduled.length, 1);
	assert.equal(readExecutionQuiescence(host.pi, host.ctx, { toolCallIds: new Set(["current"]) }).state, "busy");
	host.setIdle(false);
	await hooks(host, "context_with_system", { messages: [] });
	assert.equal(deliveryState(host).scheduled.length, 1, "queueing alone is not preparation");
	await hooks(host, "context_with_system", { messages: host.messages });
	assert.equal(deliveryState(host).pending.length, 0);
	assert.equal(deliveryState(host).scheduled.length, 0);
	host.setIdle(true);
	await hooks(host, "agent_settled");
	assert.equal(host.sent.length, 1, "quiescence observation enables no task-only continuation");
	assert.equal(readExecutionQuiescence(host.pi, host.ctx, { toolCallIds: new Set(["current"]) }).activeExecutions, 1);
});

test("native handoff remains reserved until its immutable message is prepared, and a send failure is unavailable", async () => {
	const host = fakePi(); noticesExtension(host.pi);
	const shell = execution("async-bash", "terminal"); shell.executions[0]!.toolCallId = "current";
	host.pi.events.on("notices.snapshot.v1", (raw: any) => raw.accept(shell));
	await hooks(host, "session_start");
	host.pi.events.emit(EXECUTION_FACTS_EVENT, shell);
	assert.equal(deliveryState(host).scheduled.length, 1);
	shell.executions[0]!.disposition = "observed";
	host.setIdle(false);
	await hooks(host, "context_with_system", { messages: [] });
	assert.equal(deliveryState(host).scheduled.length, 1, "source observation cannot erase a handoff already owned by Pi");
	const original = structuredClone(host.messages);
	await hooks(host, "context_with_system", { messages: host.messages });
	assert.deepEqual(host.messages, original, "an admitted historical completion is never rewritten");
	assert.equal(deliveryState(host).scheduled.length, 0);
	host.setIdle(true);
	assert.equal(readExecutionQuiescence(host.pi, host.ctx, { toolCallIds: new Set(["current"]) }).state, "quiescent");

	const failed = fakePi(); failed.pi.sendMessage = (() => { throw new Error("offline fixture"); }) as ExtensionAPI["sendMessage"];
	noticesExtension(failed.pi);
	const pending = execution("async-bash", "terminal"); pending.executions[0]!.toolCallId = "current";
	failed.pi.events.on("notices.snapshot.v1", (raw: any) => raw.accept(pending));
	await hooks(failed, "session_start");
	failed.pi.events.emit(EXECUTION_FACTS_EVENT, pending);
	assert.equal(deliveryState(failed).blocked, true);
	assert.equal(deliveryState(failed).scheduled.length, 0);
	assert.equal(readExecutionQuiescence(failed.pi, failed.ctx, { toolCallIds: new Set(["current"]) }).state, "unavailable");
});

test("consumer co-load delivers one combined notice and does not task-renew while work remains", async () => {
	const host = fakePi();
	noticesExtension(host.pi);
	const shell: ProducerFacts = execution("async-bash", "running");
	const child: ProducerFacts = execution("agents", "running", "pending", "child");
	for (const handler of host.handlers.get("session_start") ?? []) await handler({}, host.ctx);
	host.setIdle(false);
	host.pi.events.emit(EXECUTION_FACTS_EVENT, tasks("doing"));
	host.pi.events.emit(EXECUTION_FACTS_EVENT, shell);
	host.pi.events.emit(EXECUTION_FACTS_EVENT, child);
	for (const handler of host.handlers.get("agent_start") ?? []) await handler({}, host.ctx);
	host.setIdle(true);
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "running shell and agent block task renewal");
	host.setIdle(false);
	host.pi.events.emit(EXECUTION_FACTS_EVENT, execution("async-bash", "terminal"));
	host.pi.events.emit(EXECUTION_FACTS_EVENT, execution("agents", "terminal", "pending", "child"));
	host.setIdle(true);
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 1);
	assert.match(host.sent[0]!, /async-bash/);
	assert.match(host.sent[0]!, /agents/);
	for (const handler of host.handlers.get("context_with_system") ?? []) await handler({ messages: host.messages }, host.ctx);
	for (const handler of host.handlers.get("before_provider_request") ?? []) await handler({}, host.ctx);
	host.sent.length = 0;
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "no task-only wake after both terminals were projected");
	host.sent.length = 0;
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "unchanged settlement does not loop");
});

test("consumer send failure does not retry and a later user turn can still deliver", async () => {
	const host = fakePi();
	let fail = true;
	(host.pi as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => { if (fail) throw new Error("send failed"); };
	noticesExtension(host.pi);
	for (const handler of host.handlers.get("session_start") ?? []) await handler({}, host.ctx);
	host.pi.events.emit(EXECUTION_FACTS_EVENT, execution("async-bash", "terminal"));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(host.sent.length, 0);
	host.pi.events.emit(EXECUTION_FACTS_EVENT, execution("async-bash", "terminal"));
	assert.equal(host.sent.length, 0, "failure is not an automatic retry loop");
	fail = false;
	for (const handler of host.handlers.get("input") ?? []) await handler({ source: "interactive" }, host.ctx);
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "user input invalidates the undelivered queue without acknowledging it as observed");
});

for (const consumerFirst of [true, false]) test("host " + (consumerFirst ? "consumer-first" : "producer-first") + " yields without a task wake and delivers one terminal", async (t) => {
	const trace = createTrace();
	const notices: string[] = [];
	const board: { facts: ProducerFacts; emit?: () => void } = { facts: execution("agents", "running", "pending", "child") };
	const publisher = (pi: ExtensionAPI) => {
		pi.registerTool({ name: "agent", label: "Fixture", description: "Fact publisher", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
		const publish = () => pi.events.emit(EXECUTION_FACTS_EVENT, board.facts);
		board.emit = publish;
		pi.events.on("notices.snapshot.v1", (raw: unknown) => (raw as { accept?: (facts: ProducerFacts) => void }).accept?.(board.facts));
		pi.on("session_start", () => publish());
	};
	const recorder = (pi: ExtensionAPI) => {
		pi.on("context_with_system", (event) => {
			for (const message of event.messages) if (message.role === "custom" && message.customType === NOTICE_TYPE) notices.push(String(message.content));
		});
	};
	const extensions = consumerFirst
		? [noticesExtension, tasklistExtension, publisher, recorder, createTraceObserver(trace)]
		: [tasklistExtension, publisher, noticesExtension, recorder, createTraceObserver(trace)];
	const h = await createHostHarness({ trace, extensions });
	t.after(() => h.dispose());
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("tasklist", { operation: "set", title: "Work", tasks: [{ id: "a", title: "Task", status: "doing" }] } as never)),
		fauxAssistantMessage("yield"),
		fauxAssistantMessage("saw terminal"),
		fauxAssistantMessage("must-not-run"),
	]);
	await h.session.prompt("go");
	await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length === 1);
	assert.equal(h.faux.state.callCount, 2, "running agent prevents a task-only wake");
	board.facts = execution("agents", "terminal", "pending", "child");
	board.emit?.();
	await waitForTrace(trace, () => h.faux.state.callCount >= 3);
	assert.equal(h.faux.state.callCount, 3);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /child finished/);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(h.faux.state.callCount, 3, "one completion delivery does not create a task-only wake");
	assert.deepEqual(h.errors, []);
});

test("a completion arriving inside a later settlement consumer waits for that consumer, without task renewal", async t => {
	const trace = createTrace();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let first = true;
	const producer = (pi: ExtensionAPI) => {
		pi.registerTool({ name: "agent", label: "Fixture", description: "Enroll completion", parameters: Type.Object({}), async execute() {
			pi.events.emit(EXECUTION_FACTS_EVENT, execution("agents", "running", "pending", "child"));
			return { content: [], details: undefined };
		} });
		pi.on("agent_settled", async () => {
			if (!first) return;
			first = false;
			trace.record("late:blocked");
			pi.events.emit(EXECUTION_FACTS_EVENT, execution("agents", "terminal", "pending", "child"));
			await gate;
			trace.record("late:finished");
		});
	};
	const h = await createHostHarness({ trace, extensions: [tasklistExtension, noticesExtension, producer, createTraceObserver(trace)] });
	t.after(async () => { release(); await h.dispose(); });
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("tasklist", { operation: "set", title: "Work", tasks: [{ id: "a", title: "Task", status: "doing" }] } as never)),
		fauxAssistantMessage(fauxToolCall("agent", {})),
		fauxAssistantMessage("yield"), fauxAssistantMessage("saw terminal"), fauxAssistantMessage("must-not-run"),
	]);
	const running = h.session.prompt("start the fixture");
	await waitForTrace(trace, entry => entry.event === "late:blocked");
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(h.faux.state.callCount, 3, "completion cannot race later settlement consumers");
	release();
	await running;
	await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length >= 2);
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(h.faux.state.callCount, 4, "one completion, no subsequent task-only wake");
	assert.deepEqual(h.errors, []);
});
