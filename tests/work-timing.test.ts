import assert from "node:assert/strict";
import test from "node:test";

import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";

import {
	createWorkTimingExtension,
	formatDuration,
	formatReasoningShare,
	WORK_TIMING_ENTRY_TYPE,
} from "../extensions/work-timing/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;

class FakePi {
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly handlers = new Map<string, Handler>();
	readonly renderers = new Map<string, EntryRenderer>();

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}

	on(name: string, handler: Handler): void {
		this.handlers.set(name, handler);
	}

	registerEntryRenderer(customType: string, renderer: EntryRenderer): void {
		this.renderers.set(customType, renderer);
	}
}

class FakeScheduler {
	callback: (() => void) | undefined;
	clearCount = 0;

	setInterval(callback: () => void): object {
		this.callback = callback;
		return this;
	}

	clearInterval(handle: unknown): void {
		assert.equal(handle, this);
		this.callback = undefined;
		this.clearCount += 1;
	}
}

function context(
	workingMessages: Array<string | undefined>,
	mode: ExtensionContext["mode"] = "tui",
): ExtensionContext {
	return {
		mode,
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	} as unknown as ExtensionContext;
}

async function invoke(
	pi: FakePi,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<unknown> {
	const handler = pi.handlers.get(eventName);
	if (!handler) throw new Error(`missing handler ${eventName}`);
	return handler(event, ctx);
}

test("formats elapsed time with second, minute, and hour carry", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(60_000), "1m 0s");
	assert.equal(formatDuration(3_661_999), "1h 1m 1s");
});

test("derives a bounded wall-time reasoning share without rewriting durations", () => {
	assert.equal(formatReasoningShare(7_000, 15_000), "47%");
	assert.equal(formatReasoningShare(0, 0), "—");
	assert.equal(formatReasoningShare(5_000, 0), "—");
	assert.equal(formatReasoningShare(20_000, 10_000), "100%");
});

test("shows live per-turn and request reasoning then appends the settled total", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	const extension = createWorkTimingExtension({
		now: () => now,
		setInterval: (callback) => scheduler.setInterval(callback),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	});
	extension(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await invoke(pi, "before_agent_start", {}, ctx);
	assert.equal(workingMessages.at(-1), "Working... R 0s / ΣR 0s • total 0s");

	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	}, ctx);
	now = 5_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... R 3s / ΣR 3s • total 5s");

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
	assert.equal(workingMessages.at(-1), "Working... R 2s / ΣR 7s • total 12s");

	now = 15_000;
	await invoke(pi, "agent_settled", {}, ctx);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(scheduler.callback, undefined);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 2,
			totalMs: 15_000,
			reasoningMs: 7_000,
			lastTurnReasoningMs: 2_000,
			outputTokens: 0,
		},
	}]);
	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = {
		fg: (_tone: string, text: string) => text,
	} as unknown as Theme;
	const collapsed = renderer(
		{ data: pi.entries[0]?.data } as never,
		{ expanded: false },
		theme,
	);
	assert.ok(collapsed);
	assert.equal(collapsed.render(80)[0]?.trim(), "Worked for 15s • reasoning 7s (47%)");
	const expanded = renderer(
		{ data: pi.entries[0]?.data } as never,
		{ expanded: true },
		theme,
	);
	assert.ok(expanded);
	assert.equal(
		expanded.render(80)[0]?.trim(),
		"Worked for 15s • reasoning 7s (47%) • last turn 2s",
	);
	const historical = renderer(
		{ data: { version: 1, totalMs: 8_000 } } as never,
		{ expanded: false },
		theme,
	);
	assert.equal(historical?.render(80)[0]?.trim(), "Worked for 8s • reasoning 0s (0%)");
	const zeroTotal = renderer(
		{ data: { version: 1, totalMs: 0, reasoningMs: 0, lastTurnReasoningMs: 0 } } as never,
		{ expanded: true },
		theme,
	);
	assert.equal(zeroTotal?.render(80)[0]?.trim(), "Worked for 0s • reasoning 0s (—) • last turn 0s");
});

test("appends a live output-token count to the working label and the settled entry", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback) => scheduler.setInterval(callback),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 1_000;
	await invoke(pi, "turn_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
	}, ctx);
	assert.equal(workingMessages.at(-1), "Working... R 0s / ΣR 0s • total 2s • ↓ 100 tokens");

	now = 3_000;
	await invoke(pi, "message_update", {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial: { usage: { output: 3_500 } } },
	}, ctx);
	assert.equal(workingMessages.at(-1), "Working... R 0s / ΣR 0s • total 3s • ↓ 3,500 tokens");

	now = 4_000;
	await invoke(pi, "turn_end", {}, ctx);
	now = 5_000;
	await invoke(pi, "agent_settled", {}, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: { version: 2, totalMs: 5_000, reasoningMs: 0, lastTurnReasoningMs: 0, outputTokens: 3_500 },
	}]);

	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	const collapsed = renderer({ data: pi.entries[0]?.data } as never, { expanded: false }, theme);
	assert.equal(collapsed?.render(80)[0]?.trim(), "Worked for 5s • reasoning 0s (0%) • ↓ 3,500 tokens");
	const legacy = renderer(
		{ data: { version: 1, totalMs: 8_000, reasoningMs: 4_000, lastTurnReasoningMs: 1_000 } } as never,
		{ expanded: false },
		theme,
	);
	assert.equal(legacy?.render(80)[0]?.trim(), "Worked for 8s • reasoning 4s (50%)");
});

test("session shutdown cancels active timing without appending a completed entry", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback) => scheduler.setInterval(callback),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages);

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 2_000;
	await invoke(pi, "session_shutdown", { reason: "reload" }, ctx);

	assert.equal(scheduler.callback, undefined);
	assert.equal(scheduler.clearCount, 1);
	assert.deepEqual(pi.entries, []);
});

test("headless modes do not start timers or persist display entries", async () => {
	let now = 0;
	const scheduler = new FakeScheduler();
	const pi = new FakePi();
	createWorkTimingExtension({
		now: () => now,
		setInterval: (callback) => scheduler.setInterval(callback),
		clearInterval: (handle) => scheduler.clearInterval(handle),
	})(pi as unknown as ExtensionAPI);
	const workingMessages: Array<string | undefined> = [];
	const ctx = context(workingMessages, "rpc");

	await invoke(pi, "before_agent_start", {}, ctx);
	now = 10_000;
	await invoke(pi, "agent_settled", {}, ctx);

	assert.equal(scheduler.callback, undefined);
	assert.deepEqual(workingMessages, []);
	assert.deepEqual(pi.entries, []);
});
