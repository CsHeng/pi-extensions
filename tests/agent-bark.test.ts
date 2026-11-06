import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import agentBark from "../extensions/agent-bark.ts";
import {
	LOOP_DELIVERY_REQUEST, LOOP_FACTS_EVENT, LOOP_SNAPSHOT_REQUEST,
	type LoopDeliverySnapshot, type LoopFacts,
} from "../extensions/shared/loop-facts.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

const USER_START = { messageType: "user" } as const;
// Pi 1.2 fires before_agent_start for an idle `pi.sendMessage(..., { triggerTurn: true })`
// run too, and reports it as a custom message rather than a user prompt.
const CUSTOM_START = { messageType: "custom" } as const;
const SETTLED = { aborted: false } as const;

class FakeEvents {
	readonly listeners = new Map<string, Array<(data: unknown) => void>>();
	on(name: string, listener: (data: unknown) => void): () => void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
		return () => this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener));
	}
	emit(name: string, data: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(data);
	}
}

async function fixture(t: TestContext, childMarker?: string, installHook = true, mode: ExtensionContext["mode"] = "json") {
	const home = await mkdtemp(join(tmpdir(), "pi-agent-bark-test-"));
	const previousHome = process.env.HOME;
	const previousMarker = process.env.CSHENG_SUBAGENT_CHILD;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousMarker === undefined) delete process.env.CSHENG_SUBAGENT_CHILD;
		else process.env.CSHENG_SUBAGENT_CHILD = previousMarker;
		await rm(home, { recursive: true, force: true });
	});
	process.env.HOME = home;
	if (childMarker === undefined) delete process.env.CSHENG_SUBAGENT_CHILD;
	else process.env.CSHENG_SUBAGENT_CHILD = childMarker;

	if (installHook) {
		const hookDirectory = join(home, ".local", "bin");
		await mkdir(hookDirectory, { recursive: true });
		await writeFile(join(hookDirectory, "agent-bark-hook"), `#!/bin/sh
set -eu
[ "$1" = pi ]
cat >> "$HOME/events.jsonl"
printf '\\n' >> "$HOME/events.jsonl"
`, { mode: 0o700 });
	}

	const handlers = new Map<string, Handler>();
	const events = new FakeEvents();
	agentBark({ events, on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
	const entries: unknown[] = [];
	const ctx = {
		mode,
		cwd: "/fixture/project",
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "main-session",
			getLeafId: () => null,
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
	const start = (event: unknown = USER_START) => handlers.get("before_agent_start")!(event, ctx);
	const settle = (event: unknown = SETTLED) => handlers.get("agent_settled")!(event, ctx);
	return {
		home, handlers, bus: events, entries, ctx, start, settle,
		async hookEvents(): Promise<Array<Record<string, string>>> {
			try {
				const content = (await readFile(join(home, "events.jsonl"), "utf8")).trim();
				return content === "" ? [] : content.split("\n").map(line => JSON.parse(line));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		},
	};
}

test("subagents register no Bark handlers and never start the notification hook", async t => {
	const state = await fixture(t, "1");
	assert.equal(state.handlers.size, 0);
	assert.deepEqual(await state.hookEvents(), []);
});

for (const childMarker of [undefined, "0"]) {
	test(`main-agent user start and settled events still reach the hook (marker ${childMarker ?? "unset"})`, async t => {
		const state = await fixture(t, childMarker);
		assert.deepEqual([...state.handlers.keys()].sort(), [
			"agent_settled", "before_agent_start", "input", "session_shutdown", "session_start", "session_tree",
			"tool_execution_end", "tool_execution_start", "turn_end", "ui_prompt_end", "ui_prompt_start",
		]);
		await state.start();
		const message = "Complete\n" + "x".repeat(350);
		state.entries.push({ type: "message", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text: message }],
		} });
		await state.settle();
		const events = await state.hookEvents();
		assert.deepEqual(events.map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
		assert.equal(typeof events[1]?.duration_ms, "number");
		const settled = events[1];
		assert.ok(settled);
		assert.equal(settled.last_assistant_message, message.replace(/\n/g, " ").slice(0, 300));
		assert.equal(settled.session_id, "main-session");
		assert.equal(settled.cwd, "/fixture/project");
	});
}

test("Pi 1.2 custom-triggered runs stay silent at start and settlement", async t => {
	const state = await fixture(t);
	await state.start(CUSTOM_START);
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "internal wake reply" }],
	} });
	await state.settle();
	assert.deepEqual(await state.hookEvents(), []);
});

test("a custom run's failure does not leak a StopFailure", async t => {
	const state = await fixture(t);
	await state.start(CUSTOM_START);
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "error", content: [{ type: "text", text: "internal failure" }],
	} });
	await state.settle();
	assert.deepEqual(await state.hookEvents(), []);
});

test("a completed user run does not leak eligibility into the next custom run", async t => {
	const state = await fixture(t);
	await state.start();
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "user reply" }],
	} });
	await state.settle();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);

	// The next run is internal. Its start must reclassify the run, so neither its start
	// nor its settlement may reuse the previous user run's eligibility.
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "subagent wake" }],
	} });
	await state.start(CUSTOM_START);
	await state.settle();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
});

test("an unsettled user run does not leak its eligibility into a later custom run", async t => {
	const state = await fixture(t);
	await state.start();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);

	// The user run never settles (for example the session was interrupted). The next run is
	// internal, and its start must reclassify before its settlement is considered.
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "subagent wake" }],
	} });
	await state.start(CUSTOM_START);
	await state.settle();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);
});

test("a silent custom run does not suppress the next user run", async t => {
	const state = await fixture(t);
	await state.start(CUSTOM_START);
	await state.settle();
	assert.deepEqual(await state.hookEvents(), []);

	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "user reply" }],
	} });
	await state.start();
	await state.settle();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
});

test("main-agent failure preserves the shared hook's StopFailure event", async t => {
	const state = await fixture(t);
	await state.start();
	state.entries.push({ type: "message", message: {
		role: "assistant", stopReason: "error", content: [{ type: "text", text: "Failed" }],
	} });
	await state.settle();
	const [failure] = (await state.hookEvents()).slice(1);
	assert.ok(failure);
	assert.equal(failure.hook_event_name, "StopFailure");
});

test("a session change drops a pending user-run settlement", async t => {
	const state = await fixture(t);
	await state.start();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);
	state.handlers.get("session_start")!({}, state.ctx);
	await state.settle();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);
});

test("an absent user-owned notification hook does not fail the main agent", async t => {
	const state = await fixture(t, undefined, false);
	await state.start();
	await state.settle();
});

// Interactive hosts: one notification per external interaction, at the same boundary that
// ends work timing, never at an intermediate main-run settlement.
interface Producer { facts: LoopFacts[]; delivery: LoopDeliverySnapshot }
function installProducer(bus: FakeEvents, producer: Producer): Producer {
	bus.on(LOOP_SNAPSHOT_REQUEST, raw => { for (const facts of producer.facts) (raw as { accept: (facts: LoopFacts) => void }).accept(facts); });
	bus.on(LOOP_DELIVERY_REQUEST, raw => (raw as { accept: (value: LoopDeliverySnapshot) => void }).accept(producer.delivery));
	return producer;
}
function shell(phase: "running" | "terminal", availability: LoopFacts["availability"] = "ready"): LoopFacts {
	return { version: 1, producer: "retained-shell", availability, sessionId: "main-session", branchAnchor: null, generation: phase,
		executions: [{ id: "exec-1", toolCallId: "call-bash", phase, status: phase === "terminal" ? "exited" : "running", exitCode: phase === "terminal" ? 0 : null, summary: phase === "terminal" ? "done" : "", disposition: "pending" }] };
}
const delivery = (pending: LoopDeliverySnapshot["pending"] = []): LoopDeliverySnapshot =>
	({ version: 1, sessionId: "main-session", branchAnchor: null, pending, scheduled: [], blocked: false });
function reply(entries: unknown[], text: string, stopReason = "stop"): void {
	entries.push({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
}
async function userInteractionWithJob(state: Awaited<ReturnType<typeof fixture>>): Promise<void> {
	await state.handlers.get("input")!({ source: "interactive", text: "go" }, state.ctx);
	await state.start();
	await state.handlers.get("tool_execution_start")!({ toolCallId: "call-bash", toolName: "bash" }, state.ctx);
	await state.handlers.get("tool_execution_end")!({ toolCallId: "call-bash", toolName: "bash", result: { details: {} } }, state.ctx);
}
async function drain(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve));
}

for (const mode of ["tui", "rpc"] as const) {
	test(`${mode}: an intermediate settlement with owned work running stays silent; the final one notifies once`, async t => {
		const state = await fixture(t, undefined, true, mode);
		const producer = installProducer(state.bus, { facts: [], delivery: delivery() });
		await userInteractionWithJob(state);
		producer.facts = [shell("running")];
		reply(state.entries, "Worker and review are still running.");
		await state.settle();
		assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);

		// The job ends; its result is pending delivery, so the interaction is still open.
		producer.facts = [shell("terminal")];
		producer.delivery = delivery([{ producer: "retained-shell", id: "exec-1", toolCallId: "call-bash" }]);
		state.bus.emit(LOOP_FACTS_EVENT, {});
		await drain();
		assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);

		// The result wake is a custom run inside the same interaction.
		await state.start(CUSTOM_START);
		producer.delivery = delivery();
		reply(state.entries, "All work finished.");
		await state.settle();
		const events = await state.hookEvents();
		assert.deepEqual(events.map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
		assert.equal(events[1]?.last_assistant_message, "All work finished.");
		assert.equal(typeof events[1]?.duration_ms, "number");
	});
}

test("tui: a main-run failure notifies at once even while owned work still runs", async t => {
	const state = await fixture(t, undefined, true, "tui");
	const producer = installProducer(state.bus, { facts: [], delivery: delivery() });
	await userInteractionWithJob(state);
	producer.facts = [shell("running")];
	reply(state.entries, "Provider failed", "error");
	await state.settle();
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit", "StopFailure"]);
});

test("tui: unverifiable execution state is reported as a failure, not success", async t => {
	const state = await fixture(t, undefined, true, "tui");
	installProducer(state.bus, { facts: [shell("running", "unknown")], delivery: delivery() });
	await state.handlers.get("input")!({ source: "interactive", text: "go" }, state.ctx);
	await state.start();
	reply(state.entries, "Done");
	await state.settle();
	const events = await state.hookEvents();
	assert.deepEqual(events.map(event => event.hook_event_name), ["UserPromptSubmit", "StopFailure"]);
	assert.equal(events[1]?.last_assistant_message, "State unavailable: Done");
});

test("tui: an aborted or newly cut interaction stays silent because the person is present", async t => {
	const state = await fixture(t, undefined, true, "tui");
	const producer = installProducer(state.bus, { facts: [], delivery: delivery() });
	await state.handlers.get("input")!({ source: "interactive", text: "go" }, state.ctx);
	await state.start();
	await state.settle({ aborted: true });
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit"]);

	await userInteractionWithJob(state);
	producer.facts = [shell("running")];
	await state.settle();
	await state.handlers.get("input")!({ source: "interactive", text: "next" }, state.ctx);
	assert.deepEqual((await state.hookEvents()).map(event => event.hook_event_name), ["UserPromptSubmit", "UserPromptSubmit"]);
});

test("tui: an extension-started run without external input never notifies", async t => {
	const state = await fixture(t, undefined, true, "tui");
	installProducer(state.bus, { facts: [], delivery: delivery() });
	await state.start(CUSTOM_START);
	reply(state.entries, "internal wake reply");
	await state.settle();
	assert.deepEqual(await state.hookEvents(), []);
});
