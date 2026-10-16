import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import loopNotifications from "../extensions/loop-notifications/index.ts";
import { canRemind, decideDelivery, pendingNotices, reminderSignature, type DeliveryView } from "../extensions/loop-notifications/policy.ts";
import { bindRetainedShell } from "../extensions/retained-shell/index.ts";
import { validateShellCall } from "../extensions/retained-shell/validate.ts";
import type { ShellExecutionOwner } from "../extensions/retained-shell/execution.ts";
import { LOOP_FACTS_EVENT, LOOP_NOTICE_TYPE, type LoopFacts } from "../extensions/shared/loop-facts.ts";
import workflow from "../extensions/workflow/index.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";

function tasks(status: string, extra: Partial<LoopFacts["tasks"]> = {}): LoopFacts {
	return { version: 1, producer: "workflow", availability: "ready", sessionId: "s", branchAnchor: "b", generation: "1", executions: [],
		tasks: { revision: 1, goal: "Work", paused: false, cancelled: false, tasks: [{ id: "a", title: "Task", status }], ...extra } };
}
function execution(producer: "retained-shell" | "subagents", phase: "running" | "queued" | "preparing" | "terminal", disposition: "pending" | "returning" | "observed" = "pending", id = producer + "-1"): LoopFacts {
	return { version: 1, producer, availability: "ready", sessionId: "s", branchAnchor: "b", generation: "1", executions: [{
		id, phase, status: phase, exitCode: phase === "terminal" ? 0 : null,
		summary: phase === "terminal" && disposition === "pending" ? producer + " " + id + " finished" : "",
		disposition,
	}] };
}
function view(partial: Partial<Record<"workflow" | "retained-shell" | "subagents", LoopFacts>>, seen = Object.keys(partial)): DeliveryView {
	return { facts: new Map(Object.entries(partial)), seen: new Set(seen), consumed: new Set(), suppressed: new Set(), remindedSignature: null };
}

test("combined policy delivers a terminal beside a running sibling and withholds task renewal", () => {
	const running = view({ workflow: tasks("doing"), "retained-shell": execution("retained-shell", "running"), subagents: execution("subagents", "queued", "pending", "child") });
	assert.equal(decideDelivery(running, "settle").kind, "none");
	assert.equal(canRemind(running), false);
	const terminal = view({ workflow: tasks("doing"), "retained-shell": execution("retained-shell", "terminal"), subagents: execution("subagents", "running") });
	const notice = decideDelivery(terminal, "settle");
	assert.equal(notice.kind, "notices");
	assert.match(notice.text, /retained-shell/);
	assert.equal(notice.notices.length, 1);
	const both = view({ workflow: tasks("doing"), "retained-shell": execution("retained-shell", "terminal"), subagents: execution("subagents", "terminal", "pending", "child") });
	assert.equal(decideDelivery(both, "settle").notices.length, 2);
	assert.equal(decideDelivery(both, "settle").text.split("\n").length, 2);
	const returned = view({ workflow: tasks("doing"), "retained-shell": execution("retained-shell", "terminal", "returning"), subagents: execution("subagents", "terminal", "observed", "child") });
	assert.equal(pendingNotices(returned).length, 0);
	assert.equal(decideDelivery(returned, "settle").kind, "reminder");
	const noted = tasks("doing");
	noted.tasks!.tasks[0] = { ...noted.tasks!.tasks[0]!, title: "Task" };
	const reminded = view({ workflow: tasks("doing") });
	const signature = reminderSignature(reminded.facts.get("workflow")!.tasks!);
	const consumed = { ...reminded, remindedSignature: signature };
	assert.equal(canRemind(consumed), false, "unchanged list does not renew");
	const noteOnly = tasks("doing");
	assert.equal(reminderSignature(noteOnly.tasks!), signature, "notes are outside the reminder identity");
	assert.equal(canRemind(view({ workflow: tasks("blocked") })), false);
	assert.equal(canRemind(view({ workflow: tasks("done") })), false);
	assert.equal(canRemind(view({ workflow: tasks("doing", { paused: true }) })), false);
	assert.equal(canRemind(view({ workflow: tasks("doing", { cancelled: true }) })), false);
	const unknown = view({ workflow: tasks("doing"), subagents: { ...execution("subagents", "running"), availability: "unknown", executions: [] } });
	assert.equal(canRemind(unknown), false);
	assert.equal(canRemind(view({ workflow: tasks("doing") }, ["workflow"])), true, "an absent execution producer is not unknown");
});

test("malformed bash control calls name the correction and do not describe a started process", () => {
	const bad = validateShellCall({ command: "action=inspect", executionId: "exec_example" });
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.match(bad.message, /executionId requires an explicit control action/);
		assert.match(bad.message, /\{"action":"inspect","executionId":"exec_example"\}/);
		assert.match(bad.message, /No process was started/);
	}
	assert.equal(validateShellCall({ action: "run", executionId: "exec_example" }).ok, false);
	assert.equal(validateShellCall({ action: "inspect" }).ok, false);
	assert.equal(validateShellCall({ action: "wait", executionId: "exec_example", command: "echo hi" }).ok, false);
	assert.equal(validateShellCall({ action: "renew", executionId: "exec_example" }).ok, false);
	assert.equal(validateShellCall({ action: "wait", executionId: "exec_example", waitSeconds: 0 }).ok, false);
	assert.equal(validateShellCall({ command: "bun test" }).ok, true);
	assert.equal(validateShellCall({ action: "inspect", executionId: "exec_example" }).ok, true);
	assert.equal(validateShellCall({ action: "renew", executionId: "exec_example", deadlineSeconds: 30 }).ok, true);
});

test("registered bash rejects the observed malformed payload before start", async () => {
	let started = 0;
	const owner = { startCount: 0, start: async () => { started += 1; throw new Error("started"); }, inspect: () => undefined, list: () => [], subscribeDisplay: () => () => {}, wait: async () => { throw new Error("mutated"); }, renew: () => { throw new Error("mutated"); }, cancel: async () => { throw new Error("mutated"); }, interruptOthers: async () => {}, shutdown: async () => {} } as ShellExecutionOwner;
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const pi = {
		getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }], getActiveTools: () => ["bash"], getSettings: () => ({}),
		events: { emit() {}, on() { return () => {}; } }, registerCommand() {}, sendUserMessage() {}, sendMessage: async () => {},
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }) => { tools.set(tool.name, tool); },
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
	};
	bindRetainedShell(pi as unknown as ExtensionAPI, owner);
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
	let idle = true;
	const ctx = { mode: "tui", isIdle: () => idle, hasPendingMessages: () => false, isProjectTrusted: () => true, signal: undefined, sessionManager: { getSessionId: () => "s", getLeafId: () => "b", getBranch: () => [{ id: "b" }] } } as ExtensionContext;
	const pi = {
		getActiveTools: () => ["bash", "csheng_workflow", "csheng_subagent_sessions"],
		events: {
			on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {}; },
			emit: (name: string, data: unknown) => { for (const handler of listeners.get(name) ?? []) handler(data); },
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command.handler); },
		sendUserMessage: (text: string) => { sent.push(text); },
		sendMessage: async (message: { content?: string }) => { sent.push(String(message.content)); },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands, sent, ctx, setIdle: (value: boolean) => { idle = value; } };
}

test("consumer co-load delivers one combined notice and does not task-renew while work remains", async () => {
	const host = fakePi();
	loopNotifications(host.pi);
	const shell: LoopFacts = execution("retained-shell", "running");
	const child: LoopFacts = execution("subagents", "running", "pending", "child");
	for (const handler of host.handlers.get("session_start") ?? []) await handler({}, host.ctx);
	host.setIdle(false);
	host.pi.events.emit(LOOP_FACTS_EVENT, tasks("doing"));
	host.pi.events.emit(LOOP_FACTS_EVENT, shell);
	host.pi.events.emit(LOOP_FACTS_EVENT, child);
	for (const handler of host.handlers.get("agent_start") ?? []) await handler({}, host.ctx);
	host.setIdle(true);
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "running shell and subagent block task renewal");
	host.setIdle(false);
	host.pi.events.emit(LOOP_FACTS_EVENT, execution("retained-shell", "terminal"));
	host.pi.events.emit(LOOP_FACTS_EVENT, execution("subagents", "terminal", "pending", "child"));
	host.setIdle(true);
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 1);
	assert.match(host.sent[0]!, /retained-shell/);
	assert.match(host.sent[0]!, /subagents/);
	for (const handler of host.handlers.get("context_with_system") ?? []) await handler({ messages: [] }, host.ctx);
	for (const handler of host.handlers.get("before_provider_request") ?? []) await handler({}, host.ctx);
	host.sent.length = 0;
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 1, "one reminder after both terminals were projected");
	host.sent.length = 0;
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "unchanged settlement does not loop");
});

test("consumer send failure does not retry and a later user turn can still deliver", async () => {
	const host = fakePi();
	let fail = true;
	(host.pi as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => { if (fail) throw new Error("send failed"); };
	loopNotifications(host.pi);
	for (const handler of host.handlers.get("session_start") ?? []) await handler({}, host.ctx);
	host.pi.events.emit(LOOP_FACTS_EVENT, execution("retained-shell", "terminal"));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(host.sent.length, 0);
	host.pi.events.emit(LOOP_FACTS_EVENT, execution("retained-shell", "terminal"));
	assert.equal(host.sent.length, 0, "failure is not an automatic retry loop");
	fail = false;
	for (const handler of host.handlers.get("input") ?? []) await handler({ source: "interactive" }, host.ctx);
	for (const handler of host.handlers.get("agent_settled") ?? []) await handler({}, host.ctx);
	assert.equal(host.sent.length, 0, "user input invalidates the undelivered queue without acknowledging it as observed");
});

for (const consumerFirst of [true, false]) test("host " + (consumerFirst ? "consumer-first" : "producer-first") + " yields without a task wake and delivers one terminal", async (t) => {
	const trace = createTrace();
	const notices: string[] = [];
	const board: { facts: LoopFacts; emit?: () => void } = { facts: execution("subagents", "running", "pending", "child") };
	const publisher = (pi: ExtensionAPI) => {
		pi.registerTool({ name: "csheng_subagent_sessions", label: "Fixture", description: "Fact publisher", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
		const publish = () => pi.events.emit(LOOP_FACTS_EVENT, board.facts);
		board.emit = publish;
		pi.events.on("csheng.loop-notifications.snapshot.v1", (raw: unknown) => (raw as { accept?: (facts: LoopFacts) => void }).accept?.(board.facts));
		pi.on("session_start", () => publish());
	};
	const recorder = (pi: ExtensionAPI) => {
		pi.on("context_with_system", (event) => {
			for (const message of event.messages) if (message.role === "custom" && message.customType === LOOP_NOTICE_TYPE) notices.push(String(message.content));
		});
	};
	const extensions = consumerFirst
		? [loopNotifications, workflow, publisher, recorder, createTraceObserver(trace)]
		: [workflow, publisher, loopNotifications, recorder, createTraceObserver(trace)];
	const h = await createHostHarness({ trace, extensions });
	t.after(() => h.dispose());
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "set", goal: "Work", tasks: [{ id: "a", title: "Task", status: "doing" }] } as never)),
		fauxAssistantMessage("yield"),
		fauxAssistantMessage("saw terminal"),
		fauxAssistantMessage("continued"),
		fauxAssistantMessage("must-not-run"),
	]);
	await h.session.prompt("go");
	await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length === 1);
	assert.equal(h.faux.state.callCount, 2, "running subagent prevents a task-only wake");
	board.facts = execution("subagents", "terminal", "pending", "child");
	board.emit?.();
	await waitForTrace(trace, () => h.faux.state.callCount >= 4);
	assert.equal(h.faux.state.callCount, 4);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /child finished/);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(h.faux.state.callCount, 4, "one delivery does not loop");
	assert.deepEqual(h.errors, []);
});
