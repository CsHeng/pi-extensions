import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_CONTEXT_TYPE, managedContextIndex, registerManagedContext } from "../extensions/subagents/context.ts";
import type { SessionView } from "../extensions/subagents/session-contracts.ts";

const view: SessionView = { handle: "session_example", role: "worker", episode: 2, state: "idle", reportComplete: true };

interface Captured {
	handlers: Map<string, (event: any, ctx?: any) => any>;
	tools: string[];
	reads: number;
	register: () => void;
	emit: (name: string, event?: any) => Promise<any>;
	deliver: (source: "interactive" | "rpc" | "extension", text: string) => Promise<void>;
	context: (messages?: any[]) => Promise<any>;
}

function capture(views: () => readonly SessionView[] | Promise<readonly SessionView[]>): Captured {
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	const captured: Captured = {
		handlers,
		tools: ["csheng_subagent_sessions"],
		reads: 0,
		register() {
			const pi = {
				on(name: string, handler: (event: any, ctx?: any) => any) { handlers.set(name, handler); },
				getActiveTools: () => captured.tools,
			};
			registerManagedContext(pi as any, async () => {
				captured.reads += 1;
				return views();
			});
		},
		async emit(name, event = {}) {
			const handler = handlers.get(name);
			assert.ok(handler, `handler ${name} registered`);
			return await handler(event, { isProjectTrusted: () => true, hasPendingMessages: () => false });
		},
		async deliver(source, text) {
			await captured.emit("input", { source, text });
			await captured.emit("before_agent_start", { prompt: text });
			await captured.emit("message_start", { message: { role: "user", content: text, timestamp: 1 } });
		},
		async context(messages = []) {
			const handler = handlers.get("context");
			assert.ok(handler);
			return await handler({ messages }, { isProjectTrusted: () => true });
		},
	};
	captured.register();
	return captured;
}

const injectedCount = (result: { messages: any[] }) => result.messages.filter((message) => message.customType === MANAGED_CONTEXT_TYPE).length;

test("managed context contains bounded state, not reports, file paths or acceptance claims", () => {
	const text = managedContextIndex([{ ...view, result: { output: "private-prose /private/source" } as any }]);
	assert.match(text!, /session_example.*episode=2.*stored=idle/);
	assert.doesNotMatch(text!, /private-prose|\/private\/source/);
	assert.match(text!, /idle means no running process/);
	assert.doesNotMatch(text!, /acceptance/);
	assert.equal(managedContextIndex([{ ...view, state: "closed" }]), undefined);
	assert.throws(() => managedContextIndex(Array.from({ length: 11 }, () => view)), /limit/);
});

test("the index is injected for one delivered real input, not before every provider request", async () => {
	const harness = capture(() => [view]);
	const original = [{ role: "user", content: "work", timestamp: 1 }];

	// Before any delivered input or recovery there is no index.
	assert.equal(injectedCount(await harness.context(original)), 0);
	assert.equal(harness.reads, 0);

	await harness.deliver("interactive", "work");
	const first = await harness.context(original);
	assert.equal(original.length, 1, "the host message list is not mutated");
	assert.equal(injectedCount(first), 1);
	assert.equal(first.messages.at(-1).content, managedContextIndex([view]));
	assert.equal(first.messages.at(-1).display, false);
	assert.equal(harness.reads, 1);

	// A duplicate context call while the delivery window is still open replaces, never multiplies.
	const second = await harness.context(first.messages);
	assert.equal(injectedCount(second), 1);
	assert.equal(harness.reads, 2);

	// The first successful assistant response ends the window; later requests in the same run stay clean.
	await harness.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
	const third = await harness.context(second.messages);
	assert.equal(injectedCount(third), 0);
	assert.equal(harness.reads, 2);

	// A new delivered real input opens exactly one new window.
	await harness.deliver("rpc", "next");
	assert.equal(injectedCount(await harness.context([...original, { role: "user", content: "next", timestamp: 1 }])), 1);
	assert.equal(harness.reads, 3);
});

test("extension-origin messages, dropped queues and settlement never open a window", async () => {
	const harness = capture(() => [view]);
	const original = [{ role: "user", content: "work", timestamp: 1 }];
	await harness.emit("input", { source: "extension", text: "control" });
	await harness.emit("before_agent_start", { prompt: "control" });
	await harness.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "control" }] } });
	assert.equal(injectedCount(await harness.context(original)), 0);
	assert.equal(harness.reads, 0);

	// A real input queued but never delivered before settlement leaves nothing behind.
	await harness.emit("input", { source: "interactive", text: "queued" });
	await harness.emit("agent_settled");
	assert.equal(injectedCount(await harness.context(original)), 0);
	assert.equal(harness.reads, 0);
});

test("a failed provider request keeps the window open so its retry carries the index", async () => {
	const harness = capture(() => [view]);
	const original = [{ role: "user", content: "work", timestamp: 1 }];
	await harness.deliver("interactive", "work");
	assert.equal(injectedCount(await harness.context(original)), 1);
	await harness.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
	assert.equal(injectedCount(await harness.context(original)), 1, "the retry re-injects instead of losing the notice");
	await harness.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	assert.equal(injectedCount(await harness.context(original)), 0);
	assert.equal(harness.reads, 2);
});

test("session start, tree navigation and successful compaction open one recovery window", async () => {
	const harness = capture(() => [view]);
	const original = [{ role: "user", content: "work", timestamp: 1 }];
	for (const event of ["session_start", "session_tree", "session_compact"] as const) {
		await harness.emit("agent_settled");
		await harness.emit(event, { reason: "reload" });
		assert.equal(injectedCount(await harness.context(original)), 1, `${event} opens one window`);
		await harness.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		assert.equal(injectedCount(await harness.context(original)), 0, `${event} window closes after a successful response`);
	}
});

test("no active stored sessions and unavailable registries stay bounded and inert", async () => {
	const empty = capture(() => []);
	await empty.deliver("interactive", "work");
	assert.equal(injectedCount(await empty.context([{ role: "user", content: "work", timestamp: 1 }])), 0);
	assert.equal(empty.reads, 1);

	const failing = capture(() => {
		throw new Error("private failure path");
	});
	await failing.deliver("interactive", "work");
	const result = await failing.context([{ role: "user", content: "work", timestamp: 1 }]);
	assert.equal(injectedCount(result), 1);
	assert.match(result.messages.at(-1).content, /index is unavailable/);
	assert.doesNotMatch(result.messages.at(-1).content, /private failure path|stored=idle/);
});

test("trust and tool disable still suppress the index without registry reads", async () => {
	const harness = capture(() => [view]);
	await harness.deliver("interactive", "work");
	harness.tools = [];
	const disabled = await harness.context([{ role: "user", content: "work", timestamp: 1 }]);
	assert.equal(injectedCount(disabled), 0);
	assert.equal(harness.reads, 0);
});
