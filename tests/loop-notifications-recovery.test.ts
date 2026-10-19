import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import loopNotifications from "../extensions/loop-notifications/index.ts";
import { LOOP_FACTS_EVENT, type LoopFacts } from "../extensions/shared/loop-facts.ts";

function harness() {
	const hooks = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const diagnostics: unknown[] = [];
	let idle = true;
	let sends = 0;
	let sender: () => void | Promise<void> = () => {};
	const ctx = {
		mode: "rpc", isIdle: () => idle, hasPendingMessages: () => false, isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "s", getLeafId: () => "b", getBranch: () => [{ id: "b" }] },
	} as ExtensionContext;
	const pi = {
		on: (name: string, hook: (event: any, ctx: ExtensionContext) => unknown) => { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
		events: {
			on: (name: string, listener: (event: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; },
			emit: (name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); },
		},
		registerCommand() {},
		getActiveTools: () => ["bash", "csheng_workflow"],
		appendEntry: (_type: string, data: unknown) => { diagnostics.push(data); },
		sendUserMessage: () => { sends += 1; return sender(); },
		sendMessage: () => { sends += 1; return sender(); },
	} as unknown as ExtensionAPI;
	loopNotifications(pi);
	return {
		async emit(name: string, event: unknown = {}) { for (const hook of hooks.get(name) ?? []) await hook(event, ctx); },
		publish(facts: LoopFacts) { pi.events.emit(LOOP_FACTS_EVENT, facts); },
		setIdle(value: boolean) { idle = value; },
		setSender(value: () => void | Promise<void>) { sender = value; },
		get sends() { return sends; }, diagnostics,
	};
}

const terminal = (id: string): LoopFacts => ({
	version: 1, producer: "retained-shell", generation: "g", sessionId: "s", branchAnchor: "b", availability: "ready",
	executions: [{ id, phase: "terminal", status: "exited", exitCode: 0, disposition: "pending", summary: `${id} finished` }],
});

test("failed completion delivery is inspectable and retries only after a legitimate new agent run", async () => {
	const h = harness();
	h.setSender(() => { throw new Error("send failed"); });
	await h.emit("session_start");
	h.publish(terminal("result"));
	assert.equal(h.sends, 1);
	assert.deepEqual(h.diagnostics, [{ reason: "send-failed" }]);
	h.publish(terminal("result"));
	await h.emit("agent_settled");
	assert.equal(h.sends, 1, "facts and settlement must not retry a failed attempt");
	h.setSender(() => {});
	h.setIdle(false);
	await h.emit("agent_start");
	h.setIdle(true);
	await h.emit("agent_settled");
	assert.equal(h.sends, 2, "native recovery without new real input must not inherit a sticky send failure");
});

test("late send failure cannot poison a replacement session binding", async () => {
	const h = harness();
	let rejectOld!: (error: Error) => void;
	h.setSender(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
	await h.emit("session_start");
	h.publish(terminal("old"));
	assert.equal(h.sends, 1);
	await h.emit("session_tree");
	h.setSender(() => {});
	h.publish(terminal("new"));
	assert.equal(h.sends, 2);
	rejectOld(new Error("late rejection"));
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(h.diagnostics, [], "the abandoned attempt must not mark the new binding failed");
	await h.emit("context_with_system", { messages: [] });
	await h.emit("before_provider_request");
	h.publish(terminal("later"));
	assert.equal(h.sends, 3);
});
