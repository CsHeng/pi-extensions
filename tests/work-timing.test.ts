import assert from "node:assert/strict";
import test from "node:test";

import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	compactStatusLabel,
	createWorkTimingExtension as createExtension,
	foldStatusLine,
	formatDuration,
	REQUEST_TIMING_ENTRY_TYPE,
	WORK_TIMING_ENTRY_TYPE,
	type WorkTimingEntryData,
} from "../extensions/work-timing/index.ts";
import {
	LOOP_DELIVERY_CHANGED,
	LOOP_DELIVERY_REQUEST,
	LOOP_FACTS_EVENT,
	LOOP_SNAPSHOT_REQUEST,
	type LoopExecutionReference,
	type LoopDeliverySnapshot,
	type LoopExecution,
	type LoopFacts,
} from "../extensions/shared/loop-facts.ts";

/** Unit instances never attach real stdout resize listeners or read its width; width cases inject their own. */
const createWorkTimingExtension = (dependencies: Parameters<typeof createExtension>[0] = {}) =>
	createExtension({ onResize: () => () => {}, columns: () => 240, ...dependencies });

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;

/** Notification facts are pulled through the host event bus; nothing reads another producer's module. */
class FakeEvents {
	private readonly listeners = new Map<string, Array<(data: unknown) => void>>();

	on(name: string, listener: (data: unknown) => void): () => void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
		return () => this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
	}

	emit(name: string, data?: unknown): void {
		for (const listener of [...(this.listeners.get(name) ?? [])]) listener(data);
	}

	count(name: string): number {
		return this.listeners.get(name)?.length ?? 0;
	}
}

/** Entries of the most recently created fake session; contexts read the session they were created for. */
let activeSession: unknown[] = [];

class FakePi {
	/** Completion entries only; request timing entries are kept separately. */
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly timings: unknown[] = [];
	/** Every persisted session entry, in append order, as `sessionManager.getEntries()` reports it. */
	readonly session: unknown[] = [];

	constructor() {
		activeSession = this.session;
	}
	readonly handlers = new Map<string, Handler[]>();
	readonly renderers = new Map<string, EntryRenderer>();
	readonly events = new FakeEvents();

	appendEntry(customType: string, data: unknown): void {
		this.session.push({ type: "custom", customType, data });
		if (customType === REQUEST_TIMING_ENTRY_TYPE) this.timings.push(data);
		else this.entries.push({ customType, data });
	}

	on(name: string, handler: Handler): void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
	}

	registerEntryRenderer(customType: string, renderer: EntryRenderer): void {
		this.renderers.set(customType, renderer);
	}
}

class FakeScheduler {
	callback: (() => void) | undefined;
	intervalMs: number | undefined;
	clearCount = 0;

	setInterval(callback: () => void, intervalMs: number): object {
		this.callback = callback;
		this.intervalMs = intervalMs;
		return this;
	}

	clearInterval(handle: unknown): void {
		assert.equal(handle, this);
		this.callback = undefined;
		this.clearCount += 1;
	}
}

interface FakeContext extends ExtensionContext {
	idle: boolean;
	pending: boolean;
}

const SESSION_ID = "session-a";
const LEAF_ID = "leaf-a";

function context(
	workingMessages: Array<string | undefined>,
	mode: ExtensionContext["mode"] = "tui",
): FakeContext {
	const session = activeSession;
	return {
		mode,
		idle: true,
		pending: false,
		signal: undefined,
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
		isIdle(this: FakeContext) {
			return this.idle;
		},
		hasPendingMessages(this: FakeContext) {
			return this.pending;
		},
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getEntries: () => session,
			getSessionId: () => SESSION_ID,
			getLeafId: () => LEAF_ID,
			getBranch: () => [{ id: LEAF_ID }],
		},
	} as unknown as FakeContext;
}

async function invoke(
	pi: FakePi,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<unknown> {
	const handlers = pi.handlers.get(eventName);
	if (!handlers?.length) throw new Error(`missing handler ${eventName}`);
	let result: unknown;
	for (const handler of handlers) result = await handler(event, ctx);
	return result;
}

/** Real host order: the external input event precedes the native run it starts. */
async function beginInteraction(pi: FakePi, ctx: ExtensionContext, text = "go"): Promise<void> {
	await invoke(pi, "input", { type: "input", text, source: "interactive" }, ctx);
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: text }, ctx);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function shellFacts(
	executions: Array<Partial<LoopExecution> & { id: string }>,
	availability: LoopFacts["availability"] = "ready",
): LoopFacts {
	return {
		version: 1,
		producer: "retained-shell",
		availability,
		sessionId: SESSION_ID,
		branchAnchor: LEAF_ID,
		generation: `gen-${executions.map((item) => `${item.id}:${item.phase ?? ""}`).join(",")}`,
		executions: executions.map((item) => ({
			phase: "running",
			status: "running",
			exitCode: null,
			summary: "",
			disposition: "returning",
			...item,
		})),
	};
}

function deliveryFacts(
	pending: LoopExecutionReference[] = [],
	scheduled: LoopExecutionReference[] = [],
): LoopDeliverySnapshot {
	return { version: 1, sessionId: SESSION_ID, branchAnchor: LEAF_ID, pending, scheduled, blocked: false };
}

interface ProducerState {
	facts: LoopFacts[];
	delivery: LoopDeliverySnapshot;
}

/** Answers the neutral pull queries; it never starts work or a model turn. */
function installProducer(pi: FakePi, state: ProducerState): ProducerState {
	pi.events.on(LOOP_SNAPSHOT_REQUEST, (raw) => {
		const request = raw as { accept: (facts: LoopFacts) => void };
		for (const facts of state.facts) request.accept(facts);
	});
	pi.events.on(LOOP_DELIVERY_REQUEST, (raw) => {
		const request = raw as { accept: (value: LoopDeliverySnapshot) => void };
		request.accept(state.delivery);
	});
	return state;
}

function publish(pi: FakePi): void {
	pi.events.emit(LOOP_FACTS_EVENT, {});
	pi.events.emit(LOOP_DELIVERY_CHANGED, {});
}

function entryData(pi: FakePi, index = 0): WorkTimingEntryData {
	const entry = pi.entries[index];
	if (!entry) throw new Error(`missing entry ${index}`);
	return entry.data as WorkTimingEntryData;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderEntry(pi: FakePi, data: unknown, width = 120): string {
	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	const component = renderer({ data } as never, { expanded: false }, theme);
	assert.ok(component);
	return component.render(width)[0]?.trim() ?? "";
}

test("formats elapsed time with compact second, minute, and hour carry", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(60_000), "1m0s");
	assert.equal(formatDuration(3_661_999), "1h1m1s");
});

interface RequestScript {
	start: number;
	/** First output: a thinking start when `thinkingEnd` is given, otherwise a text delta. */
	firstOutputAt?: number;
	thinkingEnd?: number;
	end: number;
	timestamp: number;
	usage?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: Record<string, number> }>;
	stopReason?: string;
	/** Pi persists the assistant message after `message_end`; false keeps it unpersisted. */
	persist?: boolean;
}

function assistantMessage(script: RequestScript) {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...script.usage };
	return {
		role: "assistant", provider: "p", model: "m", timestamp: script.timestamp,
		stopReason: script.stopReason ?? "stop", durationMs: script.end - script.start,
		content: [],
		usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...script.usage?.cost } },
	};
}

/** Real host order for one provider request inside a turn; the clock is the test's injected clock. */
async function runRequest(pi: FakePi, ctx: ExtensionContext, setNow: (at: number) => void, script: RequestScript): Promise<void> {
	setNow(script.start);
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	if (script.firstOutputAt !== undefined) {
		setNow(script.firstOutputAt);
		if (script.thinkingEnd !== undefined) {
			await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
			setNow(script.thinkingEnd);
			await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, ctx);
		} else {
			await invoke(pi, "message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, ctx);
		}
	}
	await endRequest(pi, ctx, setNow, script);
	await invoke(pi, "turn_end", {}, ctx);
}

async function endRequest(pi: FakePi, ctx: ExtensionContext, setNow: (at: number) => void, script: RequestScript): Promise<void> {
	setNow(script.end);
	const message = assistantMessage(script);
	await invoke(pi, "message_end", { type: "message_end", message }, ctx);
	if (script.persist !== false) pi.session.push({ type: "message", message });
}

test("the request lane counts TTFT live, shows in-flight estimates, then settles at message_end", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	// An earlier cached request: this request's miss re-bills against it.
	pi.session.push({ type: "message", message: assistantMessage({ start: 0, end: 1, timestamp: 1, usage: { input: 1_000, output: 10, cacheRead: 70_000 } }) });
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await beginInteraction(pi, ctx);
	assert.equal(workingMessages.at(-1), "Working... 0s");
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	assert.equal(await invoke(pi, "before_provider_request", { type: "before_provider_request", payload: { model: "m" } }, ctx), undefined);
	now = 3_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 3s • TTFT 2.0s…");

	now = 4_200;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 4s • TTFT 3.2s", "the first output fixes the counter");
	now = 6_200;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, ctx);
	now = 7_000;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(1_680) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x".repeat(1_680) },
	}, ctx);
	scheduler.callback?.();
	// Output estimated from characters; live tok/s divides by the time since the request start.
	assert.equal(workingMessages.at(-1), "Working... 7s • ↓420 • ✻ 2s • TTFT 3.2s • 70 tok/s");

	const script: RequestScript = {
		start: 1_000, end: 14_400, timestamp: 77, stopReason: "toolUse",
		usage: { input: 74_700, output: 241, cost: { input: 0.747, total: 0.759 } },
	};
	await endRequest(pi, ctx, (at) => { now = at; }, script);
	assert.deepEqual(pi.timings, [{ version: 1, messageTimestamp: 77, ttftMs: 3_200, thinkingMs: 2_000 }]);
	assert.equal(
		workingMessages.at(-1),
		"Working... 14s • ↑75k ↓241 CH0.0% $0.759 RB1 71k $0.710 • ✻ 2s • TTFT 3.2s • 18 tok/s",
		"settled request values replace the estimates",
	);
	// The timing entry lands before Pi persists the assistant message.
	const types = pi.session.slice(-2).map((entry) => (entry as { type: string }).type);
	assert.deepEqual(types, ["custom", "message"]);

	now = 15_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-1", toolName: "bash" }, ctx);
	now = 17_000;
	scheduler.callback?.();
	assert.equal(
		workingMessages.at(-1),
		"Working... 17s • ⚙ 2s • ↑75k ↓241 CH0.0% $0.759 RB1 71k $0.710 • ✻ 2s • TTFT 3.2s • 18 tok/s",
		"the settled request stays visible while its tools run",
	);
	await invoke(pi, "tool_execution_end", { toolCallId: "call-1", toolName: "bash" }, ctx);
	await invoke(pi, "turn_end", {}, ctx);
	now = 18_000;
	await invoke(pi, "turn_start", {}, ctx);
	// Pi may process queued messages and prepare the next request after turn_start.
	now = 20_000;
	scheduler.callback?.();
	assert.equal(
		workingMessages.at(-1),
		"Working... 20s • ↑75k ↓241 CH0.0% $0.759 RB1 71k $0.710 • ✻ 2s • TTFT 3.2s • 18 tok/s",
		"the settled values stay until the next request starts",
	);
	await invoke(pi, "before_provider_request", {}, ctx);
	assert.equal(workingMessages.at(-1), "Working... 20s • TTFT 0.0s…", "the next request start replaces them");
});

test("without a provider-request stage the stream start replaces the settled values and no live counter runs", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const setNow = (at: number) => { now = at; };

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 1_500;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(40) } }, ctx);
	await endRequest(pi, ctx, setNow, { start: 1_000, end: 3_000, timestamp: 1, usage: { input: 100, output: 40 } });
	assert.equal(workingMessages.at(-1), "Working... 3s • ↑100 ↓40 CH0.0% • TTFT 0.5s • 20 tok/s", "settled TTFT and tok/s come from durationMs");
	await invoke(pi, "turn_end", {}, ctx);
	now = 4_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 6_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 6s • ↑100 ↓40 CH0.0% • TTFT 0.5s • 20 tok/s");
	await invoke(pi, "message_start", { message: { role: "user" } }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 6s • ↑100 ↓40 CH0.0% • TTFT 0.5s • 20 tok/s", "only an assistant stream starts the request");
	await invoke(pi, "message_start", { message: { role: "assistant" } }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 6s");
	now = 7_000;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 7s • ↓100", "no live TTFT counter or live tok/s without the request start");
});

test("a provider retry restarts the live TTFT counter and the settled TTFT anchors on durationMs", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "before_provider_request", {}, ctx);
	now = 3_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 3s • TTFT 2.0s…");
	now = 3_500;
	await invoke(pi, "before_provider_request", {}, ctx);
	now = 4_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 4s • TTFT 0.5s…");
	now = 5_000;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } }, ctx);
	// Pi's durationMs belongs to the attempt that produced the message: 3.5s to 6s.
	await endRequest(pi, ctx, (at) => { now = at; }, { start: 3_500, end: 6_000, timestamp: 9, usage: { input: 10, output: 50 } });
	assert.deepEqual(pi.timings, [{ version: 1, messageTimestamp: 9, ttftMs: 1_500, thinkingMs: 0 }]);
	assert.equal(workingMessages.at(-1), "Working... 6s • ↑10 ↓50 CH0.0% • TTFT 1.5s • 20 tok/s");
});

test("an unobserved first output, error or abort settles usage without timing fields", async () => {
	let now = 0;
	const pi = new FakePi();
	createWorkTimingExtension({ now: () => now, setInterval: () => ({}), clearInterval: () => {} })(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const setNow = (at: number) => { now = at; };

	await beginInteraction(pi, ctx);
	await runRequest(pi, ctx, setNow, { start: 1_000, end: 3_000, timestamp: 1, usage: { input: 100, output: 20 } });
	assert.deepEqual(pi.timings.at(-1), { version: 1, messageTimestamp: 1, thinkingMs: 0 });
	await runRequest(pi, ctx, setNow, { start: 4_000, firstOutputAt: 4_500, end: 5_000, timestamp: 2, stopReason: "error", usage: { input: 100, output: 20 } });
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "before_provider_request", {}, ctx);
	await endRequest(pi, ctx, setNow, { start: 5_000, end: 6_000, timestamp: 3, stopReason: "aborted", usage: { input: 100, output: 0 } });
	assert.equal(workingMessages.at(-1), "Working... 6s • ↑100 CH0.0%");
	now = 7_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	const metrics = entryData(pi).metrics;
	// Every request contributes usage; only the first is speed-eligible, and none has a TTFT.
	assert.equal(metrics.input, 300);
	assert.equal(metrics.output, 40);
	assert.equal(metrics.speedOutput, 20);
	assert.equal(metrics.speedMs, 2_000);
	assert.equal(metrics.ttftCount, 0);
});

test("the completion entry aggregates the requests that settled during the interaction", async () => {
	let now = 0;
	const pi = new FakePi();
	createWorkTimingExtension({ now: () => now, setInterval: () => ({}), clearInterval: () => {} })(pi as unknown as ExtensionAPI);
	// History before the interaction: never counted, but its cache baseline makes the first request re-bill.
	pi.session.push({ type: "message", message: assistantMessage({ start: 0, end: 1, timestamp: 1, usage: { input: 1_000, output: 500, cacheRead: 9_000 } }) });
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const setNow = (at: number) => { now = at; };

	await beginInteraction(pi, ctx);
	await runRequest(pi, ctx, setNow, {
		start: 1_000, firstOutputAt: 3_000, thinkingEnd: 5_000, end: 9_000, timestamp: 10,
		usage: { input: 6_000, output: 200, cacheRead: 4_000, cost: { input: 0.06, cacheRead: 0.004, total: 0.07 } },
	});
	pi.session.push({ type: "message", message: { role: "toolResult", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } } } });
	await runRequest(pi, ctx, setNow, {
		start: 10_000, firstOutputAt: 13_000, thinkingEnd: 14_000, end: 15_000, timestamp: 11,
		usage: { input: 500, output: 100, cacheRead: 10_000, cost: { total: 0.01 } },
	});
	now = 20_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	assert.equal(pi.entries.length, 1);
	const data = entryData(pi);
	assert.equal(data.version, 5);
	// The first request misses 6,000 of the previous 10,000-token prompt: $0.01/k paid minus $0.001/k read.
	assert.ok(Math.abs(data.metrics.rebillCost - 0.054) < 1e-12);
	assert.deepEqual({ ...data.metrics, rebillCost: 0.054 }, {
		input: 6_500, output: 300, cacheRead: 14_000, cacheWrite: 0, cost: 0.11,
		promptTokens: 20_500, promptCacheRead: 14_000,
		rebillCount: 1, rebillTokens: 6_000, rebillCost: 0.054,
		thinkingMs: 3_000, ttftMs: 5_000, ttftCount: 2, speedOutput: 300, speedMs: 13_000,
	});
	assert.equal(renderEntry(pi, data), "Worked for 20s • ↑6.5k ↓300 R14k CH68.3% $0.110 RB1 6.0k $0.054 • ✻ 3s (15%) • TTFT 2.5s • 23 tok/s");
});

test("the interaction population starts at the external input, including a pre-run compaction", async () => {
	let now = 0;
	const pi = new FakePi();
	createWorkTimingExtension({ now: () => now, setInterval: () => ({}), clearInterval: () => {} })(pi as unknown as ExtensionAPI);
	pi.session.push({ type: "message", message: assistantMessage({ start: 0, end: 1, timestamp: 1, usage: { input: 9_000, output: 9, cost: { total: 9 } } }) });
	const ctx = context([]);
	const setNow = (at: number) => { now = at; };

	await invoke(pi, "input", { type: "input", text: "go", source: "interactive" }, ctx);
	// Pi checks compaction after the input and before before_agent_start.
	pi.session.push({ type: "compaction", usage: { input: 2_000, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } });
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "go" }, ctx);
	await runRequest(pi, ctx, setNow, { start: 1_000, firstOutputAt: 1_200, end: 2_000, timestamp: 2, usage: { input: 100, output: 20, cost: { total: 0.1 } } });
	now = 3_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	const metrics = entryData(pi).metrics;
	assert.equal(metrics.input, 2_100, "the compaction settled during the interaction; earlier history did not");
	assert.equal(metrics.output, 320);
	assert.ok(Math.abs(metrics.cost - 0.6) < 1e-12);

	// A later steering-only input or an extension-origin input never moves a later interaction's start.
	await invoke(pi, "input", { type: "input", text: "auto", source: "extension" }, ctx);
	pi.session.push({ type: "compaction", usage: { input: 7_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 7 } } });
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	now = 4_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1, "an extension-origin run opens no interaction");
});

test("timing observation never changes the provider payload or model context", async () => {
	const pi = new FakePi();
	createWorkTimingExtension({ setInterval: () => ({}), clearInterval: () => {} })(pi as unknown as ExtensionAPI);
	const ctx = context([]);
	await beginInteraction(pi, ctx);
	await invoke(pi, "turn_start", {}, ctx);
	const payload = { messages: [{ role: "user", content: "go" }] };
	assert.equal(await invoke(pi, "before_provider_request", { type: "before_provider_request", payload }, ctx), undefined);
	assert.deepEqual(payload, { messages: [{ role: "user", content: "go" }] });
	for (const name of ["context", "context_with_system", "before_provider_headers"]) assert.equal(pi.handlers.has(name), false, name);
	// The request entry is a custom entry, which Pi excludes from model context.
	await endRequest(pi, ctx, () => {}, { start: 0, end: 1, timestamp: 5, usage: { input: 1, output: 1 } });
	assert.equal((pi.session.at(-2) as { type: string }).type, "custom");
});

test("keeps one interaction open across an idle gap and summarizes once at quiescence", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	const state = installProducer(pi, {
		facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])],
		delivery: deliveryFacts(),
	});
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	const setNow = (at: number) => { now = at; };
	await beginInteraction(pi, ctx);
	await runRequest(pi, ctx, setNow, {
		start: 1_000, firstOutputAt: 1_500, thinkingEnd: 2_000, end: 2_500, timestamp: 1, usage: { input: 1_000, output: 200 },
	});
	now = 3_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-bash",
		toolName: "bash",
		result: { details: { executionId: "exec-1", status: "running" } },
	}, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 0, "a settled run does not end an interaction whose owned job still runs");

	// The job is terminal, but its result has not been delivered yet: still no summary.
	now = 40_000;
	state.facts = [shellFacts([{ id: "exec-1", toolCallId: "call-bash", phase: "terminal", status: "exited", exitCode: 0, disposition: "pending" }])];
	state.delivery = deliveryFacts([{ producer: "retained-shell", id: "exec-1", toolCallId: "call-bash" }]);
	publish(pi);
	await settle();
	assert.equal(pi.entries.length, 0, "pending or reserved result delivery prolongs the interaction");

	// The delivery wake starts a native run that is part of the same interaction.
	now = 50_000;
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	await runRequest(pi, ctx, setNow, {
		start: 52_000, firstOutputAt: 52_500, thinkingEnd: 53_000, end: 54_000, timestamp: 2, usage: { input: 600, output: 300 },
	});
	now = 60_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 0, "a reserved delivery keeps the interaction open after its last run");
	assert.equal(workingMessages.at(-1), undefined, "the native working row may stop while the span stays open");

	// The cleared delivery invalidates the observation; quiescence finalizes the one summary.
	state.delivery = deliveryFacts();
	now = 62_000;
	publish(pi);
	await settle();

	assert.equal(pi.entries.length, 1, "one external interaction produces one summary");
	const data = entryData(pi);
	assert.equal(data.version, 5);
	assert.equal(data.totalMs, 62_000);
	assert.equal(data.status, "settled");
	assert.equal(data.humanWaitMs, 0);
	// Both runs' requests belong to the interaction; the idle gap is work elapsed, not a second entry.
	assert.equal(renderEntry(pi, data), "Worked for 1m2s • ↑1.6k ↓500 CH0.0% • ✻ 1s (2%) • TTFT 0.5s • 143 tok/s");

	// A late notice for the already-finished job cannot resurrect the settled interaction.
	now = 64_000;
	publish(pi);
	await settle();
	assert.equal(pi.entries.length, 1);
});

test("compares producer registration order without changing the outcome", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	// The consumer subscribes before the producer: a pull-based read must not depend on load order.
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const state = installProducer(pi, { facts: [shellFacts([])], delivery: deliveryFacts() });

	await beginInteraction(pi, ctx);
	now = 4_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).totalMs, 4_000);
	assert.equal(state.facts.length, 1);
});

test("ignores pre-existing and late unrelated work", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const state = installProducer(pi, {
		facts: [shellFacts([{ id: "exec-old", toolCallId: "old-call" }])],
		delivery: deliveryFacts([{ producer: "retained-shell", id: "exec-old", toolCallId: "old-call" }]),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 10_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1, "an older running job is not this interaction's work");
	assert.equal(entryData(pi).status, "settled");
	assert.equal(entryData(pi).totalMs, 10_000);

	// Its terminal notice starts an automatic run, which has no human interaction to summarize.
	state.facts = [shellFacts([{ id: "exec-old", toolCallId: "old-call", phase: "terminal", status: "exited", exitCode: 0 }])];
	state.delivery = deliveryFacts();
	now = 20_000;
	publish(pi);
	await settle();
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	now = 21_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 22_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1, "late unrelated notices never fabricate a second summary");
});

test("adopts pre-existing work only through an explicit control receipt", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const state = installProducer(pi, {
		facts: [shellFacts([{ id: "exec-old", toolCallId: "old-call" }])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "inspect-call", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "inspect-call",
		toolName: "bash",
		result: { details: { executionId: "exec-old", status: "running" } },
	}, ctx);
	now = 10_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 0, "an explicit receipt adopts the older execution into this interaction");

	now = 30_000;
	state.facts = [shellFacts([{ id: "exec-old", toolCallId: "old-call", phase: "terminal", status: "exited", exitCode: 0 }])];
	publish(pi);
	await settle();
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).totalMs, 30_000);
});

test("deducts pure human wait but keeps time while an owned job is progressing", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const state = installProducer(pi, {
		facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-bash",
		toolName: "bash",
		result: { details: { executionId: "exec-1", status: "running" } },
	}, ctx);

	// The blocking prompt starts while the retained job progresses: that interval is autonomous.
	now = 10_000;
	await invoke(pi, "ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, ctx);
	now = 20_000;
	state.facts = [shellFacts([{ id: "exec-1", toolCallId: "call-bash", phase: "terminal", status: "exited", exitCode: 0 }])];
	publish(pi);
	await settle();
	// From here nothing but the human is progressing, so the remainder of the prompt is pure wait.
	now = 30_000;
	await invoke(pi, "ui_prompt_end", {}, ctx);
	now = 35_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	const data = entryData(pi);
	assert.equal(data.humanWaitMs, 10_000);
	assert.equal(data.totalMs, 25_000, "autonomous wall time excludes only the pure human wait");
	assert.equal(data.status, "settled");
	assert.equal(renderEntry(pi, data), "Worked for 25s • waited 10s");
});

test("cuts an awaiting interaction on new external input and never calls it complete", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	installProducer(pi, {
		facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-bash",
		toolName: "bash",
		result: { details: { executionId: "exec-1", status: "running" } },
	}, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 0);

	now = 20_000;
	await beginInteraction(pi, ctx, "new question");
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).status, "interrupted", "new input cuts the span instead of completing it");
	assert.equal(entryData(pi).totalMs, 20_000);
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Interrupted after 20s");

	now = 25_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 2);
	assert.equal(entryData(pi, 1).status, "settled");
	assert.equal(entryData(pi, 1).totalMs, 5_000);
});

test("keeps queued steering input inside the run that is still streaming", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	installProducer(pi, { facts: [shellFacts([])], delivery: deliveryFacts() });
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 2_000;
	await invoke(pi, "input", { type: "input", text: "also this", source: "interactive", streamingBehavior: "steer" }, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1, "steering is one interaction, not a cut");
	assert.equal(entryData(pi).status, "settled");
	assert.equal(entryData(pi).totalMs, 5_000);
});

test("promotion cuts the work clock at the input and counts the in-flight request wholly", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	installProducer(pi, { facts: [shellFacts([])], delivery: deliveryFacts() });
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const setNow = (at: number) => { now = at; };

	// Automatic work with no human boundary measures a run span only; this request settles before any input.
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	await runRequest(pi, ctx, setNow, { start: 100, firstOutputAt: 200, end: 400, timestamp: 1, usage: { input: 500, output: 50 } });
	now = 500;
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "before_provider_request", {}, ctx);
	now = 1_000;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
	now = 1_500;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, ctx);

	// A person steers that run mid-request. The request settles afterwards, so it belongs to the interaction.
	now = 2_000;
	await invoke(pi, "input", { type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
	now = 2_100;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } }, ctx);
	now = 2_400;
	await invoke(pi, "message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 1 } }, ctx);
	await endRequest(pi, ctx, setNow, { start: 500, end: 3_000, timestamp: 2, usage: { input: 1_200, output: 500 } });
	await invoke(pi, "turn_end", {}, ctx);
	now = 6_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	assert.equal(pi.entries.length, 1);
	const data = entryData(pi);
	assert.equal(data.scope, "interaction");
	assert.equal(data.status, "settled");
	assert.equal(data.totalMs, 4_000, "the work clock starts at the input, not at the automatic run");
	assert.equal(data.metrics.input, 1_200, "the request that settled before the input is not interaction work");
	assert.equal(data.metrics.output, 500, "usage is a whole-request fact");
	assert.equal(data.metrics.thinkingMs, 800, "thinking before the input belongs to the same request");
	assert.equal(data.metrics.ttftMs, 500);
	assert.equal(renderEntry(pi, data), "Worked for 4s • ↑1.2k ↓500 CH0.0% • ✻ <1s (20%) • TTFT 0.5s • 200 tok/s");
});

test("promotion keeps the run's ongoing executions but excludes unrelated older work", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const state = installProducer(pi, {
		facts: [shellFacts([
			{ id: "exec-run", toolCallId: "call-bash" },
			{ id: "exec-adopted", toolCallId: "older-call" },
			{ id: "exec-old", toolCallId: "old-call" },
		])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-bash",
		toolName: "bash",
		result: { details: { executionId: "exec-run", status: "running" } },
	}, ctx);
	await invoke(pi, "tool_execution_start", { toolCallId: "call-control", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-control", toolName: "bash",
		result: { details: { executionId: "exec-adopted", status: "running" } },
	}, ctx);
	now = 2_000;
	await invoke(pi, "input", { type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 0, "the run's ongoing execution is now the interaction's work");

	now = 7_000;
	state.facts = [shellFacts([
		{ id: "exec-run", toolCallId: "call-bash", phase: "terminal", status: "exited", exitCode: 0 },
		{ id: "exec-adopted", toolCallId: "older-call" },
		{ id: "exec-old", toolCallId: "old-call" },
	])];
	publish(pi);
	await settle();
	assert.equal(pi.entries.length, 0, "promotion retains explicit control receipts from the automatic run");
	now = 8_000;
	state.facts = [shellFacts([
		{ id: "exec-run", toolCallId: "call-bash", phase: "terminal", status: "exited", exitCode: 0 },
		{ id: "exec-adopted", toolCallId: "older-call", phase: "terminal", status: "exited", exitCode: 0 },
		{ id: "exec-old", toolCallId: "old-call" },
	])];
	publish(pi);
	await settle();
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).totalMs, 6_000);
	assert.equal(entryData(pi).status, "settled", "an unrelated older execution was excluded at promotion");
});

test("counts a blocking prompt inside a native tool as human wait unless owned work progresses", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const state = installProducer(pi, {
		facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 500;
	await invoke(pi, "turn_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-bash",
		toolName: "bash",
		result: { details: { executionId: "exec-1", status: "running" } },
	}, ctx);
	// The tool itself blocks on the user, while the retained job keeps progressing.
	now = 2_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-confirm", toolName: "ask" }, ctx);
	now = 10_000;
	await invoke(pi, "ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, ctx);
	now = 20_000;
	await invoke(pi, "ui_prompt_end", {}, ctx);
	assert.equal(workingMessages.at(-1), "Working... 20s • ⚙ 8s", "the tool clock froze but the prompt was autonomous");

	now = 25_000;
	state.facts = [shellFacts([{ id: "exec-1", toolCallId: "call-bash", phase: "terminal", status: "exited", exitCode: 0 }])];
	publish(pi);
	await settle();
	now = 30_000;
	await invoke(pi, "ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, ctx);
	now = 40_000;
	await invoke(pi, "ui_prompt_end", {}, ctx);
	now = 45_000;
	await invoke(pi, "tool_execution_end", { toolCallId: "call-confirm", toolName: "ask" }, ctx);
	now = 46_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 50_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	const data = entryData(pi);
	assert.equal(data.humanWaitMs, 10_000, "the in-tool prompt is human wait once owned work stopped");
	assert.equal(data.totalMs, 40_000);
	assert.equal(data.status, "settled");
	assert.equal(renderEntry(pi, data), "Worked for 40s • waited 10s");
});

test("does not bind stale human input to a later extension-triggered run", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	installProducer(pi, { facts: [shellFacts([])], delivery: deliveryFacts() });
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	// The host accepted this input but another extension handled it, so no run started for it.
	await invoke(pi, "input", { type: "input", text: "handled", source: "interactive" }, ctx);
	now = 100_000;
	// A much later automatic prompt is not that human's interaction.
	await invoke(pi, "input", { type: "input", text: "resume work", source: "extension" }, ctx);
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "resume work" }, ctx);
	now = 101_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 102_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.deepEqual(pi.entries, [], "an extension-triggered run never consumes stale human intent");

	// The next real external input still starts its own interaction normally.
	await beginInteraction(pi, ctx, "real question");
	now = 107_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).totalMs, 5_000);
});

test("reports an aborted run as interrupted without waiting for quiescence", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	installProducer(pi, {
		facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await invoke(pi, "tool_execution_end", {
		toolCallId: "call-bash",
		toolName: "bash",
		result: { details: { executionId: "exec-1", status: "running" } },
	}, ctx);
	now = 7_000;
	await invoke(pi, "agent_settled", { aborted: true }, ctx);
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).status, "interrupted");
	assert.equal(entryData(pi).totalMs, 7_000);
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Interrupted after 7s");
});

test("ends a failed main run at the failure even while owned work still runs", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	(ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch = () => [
		{ id: LEAF_ID, type: "message", message: { role: "assistant", stopReason: "error", content: [] } },
	];
	const producer = installProducer(pi, {
		facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])],
		delivery: deliveryFacts(),
	});
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	producer.facts = [];
	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	producer.facts = [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])];
	await invoke(pi, "tool_execution_end", { toolCallId: "call-bash", toolName: "bash", result: { details: {} } }, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1, "no automatic continuation can resume a failed main run");
	assert.equal(entryData(pi).status, "failed");
	assert.equal(entryData(pi).totalMs, 5_000);
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Failed after 5s");

	now = 9_000;
	producer.facts = [shellFacts([{ id: "exec-1", toolCallId: "call-bash", phase: "terminal", status: "exited", exitCode: 0 }])];
	publish(pi);
	await settle();
	assert.equal(pi.entries.length, 1, "a late terminal cannot reopen or extend the failed interaction");
});

test("does not fabricate a summary for extension-origin runs", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	// An automatic custom run paints the live row but has no human interaction to summarize.
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 3_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.deepEqual(pi.entries, []);
	assert.equal(workingMessages.at(-1), undefined);

	// sendUserMessage-style continuation is still extension origin, not a new human interaction.
	await invoke(pi, "input", { type: "input", text: "resume", source: "extension" }, ctx);
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "resume" }, ctx);
	now = 4_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.deepEqual(pi.entries, []);
});

test("unavailable execution state is reported instead of claiming completion", async () => {
	let now = 0;
	const pi = new FakePi();
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);
	// A loaded producer that cannot answer its queries makes quiescence unverifiable.
	installProducer(pi, { facts: [shellFacts([], "unavailable")], delivery: deliveryFacts() });
	const scheduler = new FakeScheduler();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);

	await beginInteraction(pi, ctx);
	now = 2_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(pi.entries.length, 1);
	assert.equal(entryData(pi).status, "unavailable");
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Timed 2s (state unavailable)");
});

test("session replacement and branch changes release state without writing old scope", async () => {
	for (const eventName of ["session_shutdown", "session_tree"]) {
		let now = 0;
		const scheduler = new FakeScheduler();
		const pi = new FakePi();
		const workingMessages: Array<string | undefined> = [];
		const ctx = context(workingMessages);
		installProducer(pi, { facts: [shellFacts([{ id: "exec-1", toolCallId: "call-bash" }])], delivery: deliveryFacts() });
		createWorkTimingExtension({
			now: () => now,
			setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
			clearInterval: (handle) => scheduler.clearInterval(handle),
		})(pi as unknown as ExtensionAPI);

		await beginInteraction(pi, ctx);
		now = 1_000;
		await invoke(pi, "tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
		assert.equal(pi.events.count(LOOP_FACTS_EVENT), 1);

		now = 2_000;
		await invoke(pi, eventName, { reason: "reload" }, ctx);
		assert.equal(scheduler.callback, undefined, `${eventName} stops the timer`);
		assert.equal(pi.events.count(LOOP_FACTS_EVENT), 0, `${eventName} releases the quiescence observer`);
		assert.deepEqual(pi.entries, [], `${eventName} writes nothing into the next scope`);
	}
});

test("headless modes do not start timers or persist display entries", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages, "rpc");

	await invoke(pi, "input", { type: "input", text: "go", source: "rpc" }, ctx);
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "go" }, ctx);
	now = 10_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	assert.equal(scheduler.callback, undefined);
	assert.deepEqual(workingMessages, []);
	assert.deepEqual(pi.entries, []);
});

test("folds labels only at field boundaries", () => {
	assert.equal(foldStatusLine("A • B • C", 20), "A • B • C");
	assert.equal(foldStatusLine("A • B • C", 9), "A • B • C");
	assert.equal(foldStatusLine("A • B • C", 8), "A • B\nC");
	assert.equal(foldStatusLine("AAAA • B", 2), "AAAA\nB");
	assert.equal(foldStatusLine("A • B • C", 0), "A • B • C");
});

test("compacts the working label to the single-line row", () => {
	const label = "Working... 2s • ↑12k ↓3.5k CH0.0% $0.120 • ✻ 4s • TTFT 3.2s • 25 tok/s";
	assert.equal(compactStatusLabel(label, 80), label);
	// Fields are omitted whole; a later field still fills in when an earlier one does not fit.
	assert.equal(compactStatusLabel(label, 30), "Working... 2s • ✻ 4s");
	assert.equal(compactStatusLabel(label, 40), "Working... 2s • ↑12k ↓3.5k CH0.0% $0.120");
	assert.equal(compactStatusLabel(label, 60), "Working... 2s • ↑12k ↓3.5k CH0.0% $0.120 • ✻ 4s • TTFT 3.2s");
});

test("keeps the live tool timer at narrow widths", () => {
	const label = "Working... 47m29s • ⚙ 46m51s • ↑9.9k ↓20k CH0.0% • ✻ 4s • TTFT 1.2s • 217 tok/s";
	assert.equal(compactStatusLabel(label, 200), label);
	// The live tool timer is kept; metric fields are the optional ones.
	assert.equal(compactStatusLabel(label, 30), "Working... 47m29s • ⚙ 46m51s");
	assert.equal(compactStatusLabel(label, 45), "Working... 47m29s • ⚙ 46m51s • ✻ 4s");
	assert.equal(compactStatusLabel(label, 60), "Working... 47m29s • ⚙ 46m51s • ↑9.9k ↓20k CH0.0% • ✻ 4s");
});

test("compacts the working label on narrow terminals and on resize", async () => {
	let now = 0;
	let width = 40;
	let resizeListener: (() => void) | undefined;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
		columns: () => width,
		onResize: (listener) => {
			resizeListener = listener;
			return () => {
				resizeListener = undefined;
			};
		},
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await invoke(pi, "before_agent_start", {}, ctx);
	assert.ok(resizeListener);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "before_provider_request", {}, ctx);
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
	}, ctx);
	now = 3_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial: { usage: { input: 12_000, output: 3_500 } } },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 3s • ↓3.5k");

	width = 120;
	resizeListener?.();
	assert.equal(workingMessages.at(-1), "Working... 3s • ↓3.5k • TTFT 1.0s • 1,750 tok/s");

	await invoke(pi, "session_shutdown", { reason: "reload" }, ctx);
	assert.equal(resizeListener, undefined);
});

test("folds the settled entry at field boundaries and word-wraps lone over-wide fields", () => {
	const pi = new FakePi();
	createWorkTimingExtension()(pi as unknown as ExtensionAPI);
	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	const component = renderer(
		{
			data: {
				version: 5,
				totalMs: 415_000,
				humanWaitMs: 0,
				scope: "interaction",
				status: "settled",
				metrics: {
					input: 204_000, output: 10_000, cacheRead: 1_100_000, cacheWrite: 0, cost: 3.591,
					promptTokens: 1_313_000, promptCacheRead: 1_100_000,
					rebillCount: 14, rebillTokens: 90_000, rebillCost: 0.813,
					thinkingMs: 19_000, ttftMs: 81_000, ttftCount: 10, speedOutput: 10_000, speedMs: 400_000,
				},
			},
		} as never,
		{ expanded: false },
		theme,
	);
	assert.ok(component);

	assert.deepEqual(component.render(200).map((line) => stripAnsi(line).trim()), [
		"Worked for 6m55s • ↑204k ↓10k R1.1M CH83.8% $3.591 RB14 90k $0.813 • ✻ 19s (5%) • TTFT 8.1s • 25 tok/s",
	]);
	const folded = component.render(60).map((line) => stripAnsi(line).trim());
	assert.deepEqual(folded, [
		"Worked for 6m55s",
		"↑204k ↓10k R1.1M CH83.8% $3.591 RB14 90k $0.813",
		"✻ 19s (5%) • TTFT 8.1s • 25 tok/s",
	]);
	for (const line of component.render(60)) assert.ok(visibleWidth(line) <= 60);

	const narrow = component.render(10);
	assert.ok(narrow.length > folded.length);
	for (const line of narrow) assert.ok(visibleWidth(line) <= 10);
	const joined = narrow.map((line) => stripAnsi(line).trim()).join(" ");
	assert.ok(joined.includes("Worked for"));
	assert.ok(joined.includes("25 tok/s"));
});

test("older entries render only what their stored fields support", () => {
	const pi = new FakePi();
	createWorkTimingExtension()(pi as unknown as ExtensionAPI);
	// Forward-only: a version-4 entry keeps its head and wait; its old token fields are not interpreted.
	assert.equal(
		renderEntry(pi, { version: 4, totalMs: 9_000, humanWaitMs: 2_000, status: "interrupted", reasoningMs: 3_000, outputTokens: 100 }),
		"Interrupted after 9s • waited 2s",
	);
	// Unknown payloads render a zero-duration head instead of throwing.
	assert.equal(renderEntry(pi, { version: 99 }), "Worked for 0s");
});
