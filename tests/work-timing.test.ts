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
	formatReasoningDuration,
	formatReasoningShare,
	formatTokenRate,
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

/** Unit instances never attach real stdout resize listeners; resize cases inject their own. */
const createWorkTimingExtension = (dependencies: Parameters<typeof createExtension>[0] = {}) =>
	createExtension({ onResize: () => () => {}, ...dependencies });

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

class FakePi {
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly handlers = new Map<string, Handler[]>();
	readonly renderers = new Map<string, EntryRenderer>();
	readonly events = new FakeEvents();

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
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
		sessionManager: {
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

test("formats elapsed time with second, minute, and hour carry", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(60_000), "1m 0s");
	assert.equal(formatDuration(3_661_999), "1h 1m 1s");
});

test("derives tok/s from output tokens and decode time", () => {
	assert.equal(formatTokenRate(0, 5_000), "");
	assert.equal(formatTokenRate(100, 0), "");
	assert.equal(formatTokenRate(4_321, 6_000), "720 tok/s");
	assert.equal(formatTokenRate(17, 5_000), "3.4 tok/s");
});

test("keeps a non-zero sub-second reasoning duration visible next to its share", () => {
	assert.equal(formatReasoningDuration(0), "0s");
	assert.equal(formatReasoningDuration(720), "<1s");
	assert.equal(formatReasoningDuration(999), "<1s");
	assert.equal(formatReasoningDuration(1_000), "1s");
});

test("derives a bounded wall-time reasoning share without rewriting durations", () => {
	assert.equal(formatReasoningShare(7_000, 15_000), "47%");
	assert.equal(formatReasoningShare(0, 0), "—");
	assert.equal(formatReasoningShare(5_000, 0), "—");
	assert.equal(formatReasoningShare(20_000, 10_000), "100%");
});

test("shows live per-turn and request reasoning then appends the settled interaction", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	const extension = createWorkTimingExtension({
		now: () => now,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	});
	extension(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await beginInteraction(pi, ctx);
	assert.equal(workingMessages.at(-1), "Working... 0s • R 0s / ΣR 0s");

	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	}, ctx);
	now = 5_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 5s • R 3s / ΣR 3s");

	now = 7_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
	}, ctx);
	now = 7_500;
	await invoke(pi, "turn_end", {}, ctx);

	now = 8_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 9_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	}, ctx);
	now = 11_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
	}, ctx);
	now = 12_000;
	await invoke(pi, "turn_end", {}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 12s • R 2s / ΣR 7s");

	now = 15_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(scheduler.callback, undefined);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 4,
			totalMs: 15_000,
			reasoningMs: 7_000,
			lastTurnReasoningMs: 2_000,
			outputTokens: 0,
			inputTokens: 0,
			generationMs: 8_500,
			streamedOutputTokens: 0,
			scope: "interaction",
			status: "settled",
			humanWaitMs: 0,
		},
	}]);
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Worked for 15s • ΣR 7s (47%)");
	assert.equal(
		renderEntry(pi, { version: 1, totalMs: 8_000 }),
		"Worked for 8s • ΣR 0s (0%)",
	);
	assert.equal(
		renderEntry(pi, { version: 1, totalMs: 0, reasoningMs: 0, lastTurnReasoningMs: 0 }),
		"Worked for 0s • ΣR 0s (—)",
	);
});

test("starts decode on the first token, includes stream stalls, and pauses while tools run", async () => {
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

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(400) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { usage: { input: 5_000, output: 600 } } },
	}, ctx);
	now = 2_800;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400) },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • ↑ 5,000 ↓ 600 tokens • R 0s / ΣR 0s • 750 tok/s");

	now = 9_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "z".repeat(400) },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 9s • ↑ 5,000 ↓ 600 tokens • R 0s / ΣR 0s • 86 tok/s");

	now = 11_000;
	await invoke(pi, "tool_execution_start", { toolName: "bash" }, ctx);
	now = 13_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 13s • ⚙ 2s • ↑ 5,000 ↓ 600 tokens • R 0s / ΣR 0s • 67 tok/s");
	now = 16_000;
	await invoke(pi, "turn_end", {}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 16s • ↑ 5,000 ↓ 600 tokens • R 0s / ΣR 0s • 67 tok/s");
});

test("times the longest-running tool and pauses that clock while the user is prompted", async () => {
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

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "a", toolName: "bash" }, ctx);
	now = 3_000;
	scheduler.callback?.();
	// One second of work: below the two-second threshold, so the head clock is still the only timer.
	assert.equal(workingMessages.at(-1), "Working... 3s • R 0s / ΣR 0s");

	now = 4_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 4s • ⚙ 2s • R 0s / ΣR 0s");

	now = 8_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "b", toolName: "read" }, ctx);
	now = 13_000;
	scheduler.callback?.();
	// The longest-running tool leads and the other concurrent tool is counted.
	assert.equal(workingMessages.at(-1), "Working... 13s • ⚙ 11s +1 • R 0s / ΣR 0s");

	// Waiting on a blocking user prompt is not tool time: both tools freeze for its five seconds.
	now = 20_000;
	await invoke(pi, "ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, ctx);
	now = 25_000;
	await invoke(pi, "ui_prompt_end", {}, ctx);
	now = 26_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 26s • ⚙ 19s +1 • R 0s / ΣR 0s");

	now = 27_000;
	await invoke(pi, "tool_execution_end", { toolCallId: "a", toolName: "bash" }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 27s • ⚙ 14s • R 0s / ΣR 0s");

	now = 28_000;
	await invoke(pi, "tool_execution_end", { toolCallId: "b", toolName: "read" }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 28s • R 0s / ΣR 0s");

	// The turn boundary clears leftover tool state even without an end event.
	now = 29_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "c", toolName: "grep" }, ctx);
	now = 40_000;
	await invoke(pi, "turn_end", {}, ctx);
	assert.equal(workingMessages.at(-1), "Working... 40s • R 0s / ΣR 0s");
});

test("counts the user message's tokens live and interaction-cumulative tokens in the settled entry", async () => {
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
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • ↓ 100 tokens • R 0s / ΣR 0s");

	now = 2_800;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial: { usage: { input: 12_000, output: 3_500 } } },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • ↑ 12,000 ↓ 3,500 tokens • R 0s / ΣR 0s • 4,375 tok/s");

	now = 3_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 3_500;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 4,
			totalMs: 3_500,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 3_500,
			inputTokens: 12_000,
			generationMs: 1_000,
			streamedOutputTokens: 3_500,
			scope: "interaction",
			status: "settled",
			humanWaitMs: 0,
		},
	}]);

	assert.equal(
		renderEntry(pi, pi.entries[0]?.data),
		"Worked for 3s • ↑ 12,000 ↓ 3,500 tokens • ΣR 0s (0%) • 3,500 tok/s",
	);
	assert.equal(
		renderEntry(pi, { version: 1, totalMs: 8_000, reasoningMs: 4_000, lastTurnReasoningMs: 1_000 }),
		"Worked for 8s • ΣR 4s (50%)",
	);
});

test("counts tool-call output and provider usage that arrives only at turn end", async () => {
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
	now = 2_000;
	// Tool-call-only response: no text or thinking deltas, JSON arguments stream in.
	const toolCall = { type: "toolCall", arguments: { command: "x".repeat(396) } };
	await invoke(pi, "message_update", {
		message: { content: [toolCall] },
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "y".repeat(200) },
	}, ctx);
	scheduler.callback?.();
	const toolTokens = Math.round(JSON.stringify(toolCall.arguments).length / 4);
	assert.ok(toolTokens > 0);
	assert.equal(
		workingMessages.at(-1),
		`Working... 2s • ↓ ${new Intl.NumberFormat("en-US").format(toolTokens)} tokens • R 0s / ΣR 0s`,
	);

	now = 3_000;
	await invoke(pi, "turn_end", { message: { content: [toolCall] } }, ctx);
	now = 4_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 5_000;
	// Providers that report usage only in the final message must still count.
	await invoke(pi, "turn_end", { message: { content: [{ type: "text", text: "" }], usage: { input: 900, output: 2_048 } } }, ctx);
	now = 6_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	const totalOutputTokens = toolTokens + 2_048;
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 4,
			totalMs: 6_000,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: totalOutputTokens,
			inputTokens: 900,
			generationMs: 1_000,
			streamedOutputTokens: toolTokens,
			scope: "interaction",
			status: "settled",
			humanWaitMs: 0,
		},
	}]);
	const expectedTokens = `• ↑ 900 ↓ ${new Intl.NumberFormat("en-US").format(totalOutputTokens)} tokens`;
	assert.equal(
		renderEntry(pi, pi.entries[0]?.data),
		`Worked for 6s ${expectedTokens} • ΣR 0s (0%) • ${formatTokenRate(toolTokens, 1_000)}`,
	);
});

test("samples the clock on a one-second tick", async () => {
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => 0,
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	await invoke(pi, "before_agent_start", {}, context([]));
	assert.equal(scheduler.intervalMs, 1_000);
});

test("stream and clock lanes publish the same complete line at different cadences", async () => {
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

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	assert.equal(workingMessages.at(-1), "Working... 1s • R 0s / ΣR 0s");

	now = 1_050;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(400) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
	}, ctx);
	assert.equal(workingMessages.at(-1), "Working... 1s • ↓ 100 tokens • R 0s / ΣR 0s");

	now = 1_200;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(400) + "y".repeat(400) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400) },
	}, ctx);
	assert.equal(workingMessages.at(-1), "Working... 1s • ↓ 200 tokens • R 0s / ΣR 0s • 1,333 tok/s");

	now = 2_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • ↓ 200 tokens • R 0s / ΣR 0s • 211 tok/s");
	// Neither lane may publish a shortened, competing Working... template.
	for (const line of workingMessages) assert.match(line!, /^Working\.\.\. .* • R .* \/ ΣR /);

	const paintCount = workingMessages.length;
	scheduler.callback?.();
	assert.equal(workingMessages.length, paintCount, "unchanged snapshots do not repaint");
});

test("excludes usage-only turns from tok/s", async () => {
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
	now = 1_400;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(400) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { usage: { input: 5_000, output: 600 } } },
	}, ctx);
	now = 1_900;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400) },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 1s • ↑ 5,000 ↓ 600 tokens • R 0s / ΣR 0s • 1,200 tok/s");

	now = 2_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 2_500;
	await invoke(pi, "turn_start", {}, ctx);
	now = 3_000;
	await invoke(pi, "turn_end", { message: { content: [{ type: "text", text: "" }], usage: { input: 900, output: 2_400 } } }, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 3s • ↑ 5,900 ↓ 3,000 tokens • R 0s / ΣR 0s • 1,000 tok/s");

	now = 3_500;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 4,
			totalMs: 3_500,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 3_000,
			inputTokens: 5_900,
			generationMs: 600,
			streamedOutputTokens: 600,
			scope: "interaction",
			status: "settled",
			humanWaitMs: 0,
		},
	}]);
});

test("includes single-delta turns in the decode window", async () => {
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
	// Turn 1 streams twice (400 ms window) and reports usage.
	now = 1_400;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(400) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { usage: { input: 5_000, output: 800 } } },
	}, ctx);
	now = 1_800;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400) },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 1s • ↑ 5,000 ↓ 800 tokens • R 0s / ΣR 0s • 2,000 tok/s");

	now = 2_000;
	await invoke(pi, "turn_end", {}, ctx);
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_200;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "z".repeat(10) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "z".repeat(10), partial: { usage: { input: 0, output: 1_000 } } },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • ↑ 5,000 ↓ 1,800 tokens • R 0s / ΣR 0s • 1,333 tok/s");

	now = 2_500;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 4,
			totalMs: 2_500,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 1_800,
			inputTokens: 5_000,
			generationMs: 900,
			streamedOutputTokens: 1_800,
			scope: "interaction",
			status: "settled",
			humanWaitMs: 0,
		},
	}]);
	assert.equal(
		renderEntry(pi, pi.entries[0]?.data),
		"Worked for 2s • ↑ 5,000 ↓ 1,800 tokens • ΣR 0s (0%) • 2,000 tok/s",
	);
});

test("excludes TTFT and pauses decode on assistant message_end", async () => {
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

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 3_500;
	await invoke(pi, "message_update", {
		message: { content: [{ type: "text", text: "x".repeat(400) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { usage: { input: 1_000, output: 100 } } },
	}, ctx);
	now = 4_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 4s • ↑ 1,000 ↓ 100 tokens • R 0s / ΣR 0s • 200 tok/s");

	now = 4_000;
	await invoke(pi, "message_end", { message: { role: "user" } }, ctx);
	now = 5_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 5s • ↑ 1,000 ↓ 100 tokens • R 0s / ΣR 0s • 67 tok/s");

	now = 5_500;
	await invoke(pi, "message_end", { message: { role: "assistant" } }, ctx);
	now = 8_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 8s • ↑ 1,000 ↓ 100 tokens • R 0s / ΣR 0s • 50 tok/s");
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

	await beginInteraction(pi, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	}, ctx);
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
	}, ctx);
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { usage: { input: 1_000, output: 200 } } },
	}, ctx);
	await invoke(pi, "turn_end", {}, ctx);
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
	now = 52_000;
	await invoke(pi, "turn_start", {}, ctx);
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	}, ctx);
	now = 53_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
	}, ctx);
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial: { usage: { input: 600, output: 300 } } },
	}, ctx);
	await invoke(pi, "turn_end", {}, ctx);
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
	assert.deepEqual(data, {
		version: 4,
		totalMs: 62_000,
		reasoningMs: 2_000,
		lastTurnReasoningMs: 1_000,
		outputTokens: 500,
		inputTokens: 1_600,
		generationMs: 2_000,
		streamedOutputTokens: 500,
		scope: "interaction",
		status: "settled",
		humanWaitMs: 0,
	});
	// The idle gap between the two native runs is part of the interaction, not a second entry.
	assert.equal(renderEntry(pi, data), "Worked for 1m 2s • ↑ 1,600 ↓ 500 tokens • ΣR 2s (3%) • 250 tok/s");

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
	assert.equal(renderEntry(pi, data), "Worked for 25s • waited 10s • ΣR 0s (0%)");
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
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Interrupted after 20s • ΣR 0s (0%)");

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

test("promotes an extension-started run at the input time without its historical metrics", async () => {
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

	// Automatic work with no human boundary measures a run span only.
	await invoke(pi, "before_agent_start", { type: "before_agent_start", messageType: "custom" }, ctx);
	now = 500;
	await invoke(pi, "turn_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	}, ctx);
	now = 1_500;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
	}, ctx);
	now = 1_600;
	await invoke(pi, "message_update", {
		// Real providers can report no usage until their final event.
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
	}, ctx);

	// A person steers that run. Everything before this moment is not their interaction.
	now = 2_000;
	await invoke(pi, "input", { type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
	now = 2_100;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
	}, ctx);
	now = 2_400;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex: 1 },
	}, ctx);
	now = 2_500;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial: { usage: { input: 1_200, output: 500 } } },
	}, ctx);
	now = 3_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 6_000;
	await invoke(pi, "agent_settled", { aborted: false }, ctx);

	assert.equal(pi.entries.length, 1);
	const data = entryData(pi);
	assert.equal(data.scope, "interaction");
	assert.equal(data.status, "settled");
	assert.equal(data.totalMs, 4_000, "the interaction starts at the input, not at the automatic run");
	assert.equal(data.reasoningMs, 300, "only the post-cut thinking is attributed");
	assert.equal(data.lastTurnReasoningMs, 300);
	assert.equal(data.outputTokens, 100, "only post-cut characters are estimated; cumulative late usage cannot import prior output");
	assert.equal(data.inputTokens, 0, "this turn's prompt was sent before the cut, even when usage arrives late");
	assert.equal(data.generationMs, 1_000, "the decode window restarts at the cut");
	assert.equal(data.streamedOutputTokens, 100);
	assert.equal(renderEntry(pi, data), "Worked for 4s • ↓ 100 tokens • ΣR <1s (8%) • 100 tok/s");
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
	assert.equal(workingMessages.at(-1), "Working... 20s • ⚙ 8s • R 0s / ΣR 0s", "the tool clock froze but the prompt was autonomous");

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
	assert.equal(renderEntry(pi, data), "Worked for 40s • waited 10s • ΣR 0s (0%)");
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
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Interrupted after 7s • ΣR 0s (0%)");
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
	assert.equal(renderEntry(pi, pi.entries[0]?.data), "Timed 2s (state unavailable) • ΣR 0s (0%)");
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
	const label = "Working... 2s • ↑ 12,000 ↓ 3,500 tokens • R 0s / ΣR 0s • 4,375 tok/s";
	assert.equal(compactStatusLabel(label, 80), label);
	assert.equal(compactStatusLabel(label, 41), "Working... 2s • R 0s / ΣR 0s");
	// Rate fits after the protected core even when tokens do not.
	assert.equal(compactStatusLabel(label, 44), "Working... 2s • R 0s / ΣR 0s • 4,375 tok/s");
	// Tokens return before the core once the row allows them.
	assert.equal(
		compactStatusLabel(label, 62),
		"Working... 2s • ↑ 12,000 ↓ 3,500 tokens • R 0s / ΣR 0s",
	);
});

test("keeps the live tool timer at narrow widths", () => {
	const label = "Working... 47m 29s • ⚙ 46m 51s • ↑ 9,861 ↓ 20,323 tokens • R 4s / ΣR 1m 33s • 217 tok/s";
	assert.equal(compactStatusLabel(label, 200), label);
	// The live tool timer and `R / ΣR` are both kept; tokens and rate are the optional fields.
	assert.equal(
		compactStatusLabel(label, 60),
		"Working... 47m 29s • ⚙ 46m 51s • R 4s / ΣR 1m 33s",
	);
	assert.equal(
		compactStatusLabel(label, 80),
		"Working... 47m 29s • ⚙ 46m 51s • ↑ 9,861 ↓ 20,323 tokens • R 4s / ΣR 1m 33s",
	);
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
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
	}, ctx);
	now = 2_800;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial: { usage: { input: 12_000, output: 3_500 } } },
	}, ctx);
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • R 0s / ΣR 0s");

	width = 120;
	resizeListener?.();
	assert.equal(workingMessages.at(-1), "Working... 2s • ↑ 12,000 ↓ 3,500 tokens • R 0s / ΣR 0s • 4,375 tok/s");

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
				version: 4,
				totalMs: 12_000,
				reasoningMs: 5_400,
				lastTurnReasoningMs: 1_000,
				inputTokens: 17_234,
				outputTokens: 4_321,
				generationMs: 16_000,
				streamedOutputTokens: 11_520,
				scope: "interaction",
				status: "settled",
				humanWaitMs: 0,
			},
		} as never,
		{ expanded: false },
		theme,
	);
	assert.ok(component);

	const folded = component.render(40).map((line) => stripAnsi(line).trim());
	assert.deepEqual(folded, [
		"Worked for 12s",
		"↑ 17,234 ↓ 4,321 tokens • ΣR 5s (45%)",
		"720 tok/s",
	]);
	for (const line of component.render(40)) assert.ok(visibleWidth(line) <= 40);

	const narrow = component.render(10);
	assert.ok(narrow.length > folded.length);
	for (const line of narrow) assert.ok(visibleWidth(line) <= 10);
	const joined = narrow.map((line) => stripAnsi(line).trim()).join(" ");
	assert.ok(joined.includes("Worked for"));
	assert.ok(joined.includes("720 tok/s"));
});

test("normalizes unsupported fields on historical entries without rewriting their meaning", () => {
	const pi = new FakePi();
	createWorkTimingExtension()(pi as unknown as ExtensionAPI);
	// A version-3 entry has no scope/status/human-wait fields: it stays one settled run.
	assert.equal(
		renderEntry(pi, { version: 3, totalMs: 9_000, reasoningMs: 3_000, outputTokens: 100, inputTokens: 200, generationMs: 0, streamedOutputTokens: 0 }),
		"Worked for 9s • ↑ 200 ↓ 100 tokens • ΣR 3s (33%)",
	);
	// Unknown payloads fall back to a zero-duration settled run instead of throwing.
	assert.equal(renderEntry(pi, { version: 99 }), "Worked for 0s • ΣR 0s (—)");
});
