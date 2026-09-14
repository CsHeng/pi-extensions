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
	createWorkTimingExtension,
	foldStatusLine,
	formatDuration,
	formatReasoningDuration,
	formatReasoningShare,
	formatTokenRate,
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

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
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

test("shows live per-turn and request reasoning then appends the settled total", async () => {
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

	await invoke(pi, "before_agent_start", {}, ctx);
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
	await invoke(pi, "agent_settled", {}, ctx);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(scheduler.callback, undefined);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 3,
			totalMs: 15_000,
			reasoningMs: 7_000,
			lastTurnReasoningMs: 2_000,
			outputTokens: 0,
			inputTokens: 0,
			generationMs: 8_500,
			streamedOutputTokens: 0,
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
	assert.equal(collapsed.render(80)[0]?.trim(), "Worked for 15s • ΣR 7s (47%)");
	const expanded = renderer(
		{ data: pi.entries[0]?.data } as never,
		{ expanded: true },
		theme,
	);
	assert.ok(expanded);
	assert.equal(expanded.render(80)[0]?.trim(), "Worked for 15s • ΣR 7s (47%)");
	const historical = renderer(
		{ data: { version: 1, totalMs: 8_000 } } as never,
		{ expanded: false },
		theme,
	);
	assert.equal(historical?.render(80)[0]?.trim(), "Worked for 8s • ΣR 0s (0%)");
	const zeroTotal = renderer(
		{ data: { version: 1, totalMs: 0, reasoningMs: 0, lastTurnReasoningMs: 0 } } as never,
		{ expanded: true },
		theme,
	);
	assert.equal(zeroTotal?.render(80)[0]?.trim(), "Worked for 0s • ΣR 0s (—)");
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
	assert.equal(workingMessages.at(-1), "Working... 13s • ↑ 5,000 ↓ 600 tokens • R 0s / ΣR 0s • 67 tok/s");
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
	now = 6_000;
	scheduler.callback?.();
	// Four seconds of work: below the threshold, so the head clock is still the only timer.
	assert.equal(workingMessages.at(-1), "Working... 6s • R 0s / ΣR 0s");

	now = 7_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 7s • $ bash 5s • R 0s / ΣR 0s");

	now = 8_000;
	await invoke(pi, "tool_execution_start", { toolCallId: "b", toolName: "read" }, ctx);
	now = 13_000;
	scheduler.callback?.();
	// The longest-running tool leads and the other concurrent tool is counted.
	assert.equal(workingMessages.at(-1), "Working... 13s • $ bash 11s +1 • R 0s / ΣR 0s");

	// Waiting on a blocking user prompt is not tool time: both tools freeze for its five seconds.
	now = 20_000;
	await invoke(pi, "ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, ctx);
	now = 25_000;
	await invoke(pi, "ui_prompt_end", {}, ctx);
	now = 26_000;
	scheduler.callback?.();
	assert.equal(workingMessages.at(-1), "Working... 26s • $ bash 19s +1 • R 0s / ΣR 0s");

	now = 27_000;
	await invoke(pi, "tool_execution_end", { toolCallId: "a", toolName: "bash" }, ctx);
	assert.equal(workingMessages.at(-1), "Working... 27s • $ read 14s • R 0s / ΣR 0s");

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

test("counts the user message's tokens live and request-cumulative tokens in the settled entry", async () => {
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
	await invoke(pi, "agent_settled", {}, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: { version: 3, totalMs: 3_500, reasoningMs: 0, lastTurnReasoningMs: 0, outputTokens: 3_500, inputTokens: 12_000, generationMs: 1_000, streamedOutputTokens: 3_500 },
	}]);

	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	const collapsed = renderer({ data: pi.entries[0]?.data } as never, { expanded: false }, theme);
	assert.equal(collapsed?.render(80)[0]?.trim(), "Worked for 3s • ↑ 12,000 ↓ 3,500 tokens • ΣR 0s (0%) • 3,500 tok/s");
	const legacy = renderer(
		{ data: { version: 1, totalMs: 8_000, reasoningMs: 4_000, lastTurnReasoningMs: 1_000 } } as never,
		{ expanded: false },
		theme,
	);
	assert.equal(legacy?.render(80)[0]?.trim(), "Worked for 8s • ΣR 4s (50%)");
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

	await invoke(pi, "before_agent_start", {}, ctx);
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
	await invoke(pi, "agent_settled", {}, ctx);

	const totalOutputTokens = toolTokens + 2_048;
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 3,
			totalMs: 6_000,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: totalOutputTokens,
			inputTokens: 900,
			generationMs: 1_000,
			streamedOutputTokens: toolTokens,
		},
	}]);
	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	const collapsed = renderer({ data: pi.entries[0]?.data } as never, { expanded: false }, theme);
	const rendered = collapsed?.render(120)[0]?.trim() ?? "";
	const expectedTokens = `• ↑ 900 ↓ ${new Intl.NumberFormat("en-US").format(totalOutputTokens)} tokens`;
	assert.equal(
		rendered,
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

	await invoke(pi, "before_agent_start", {}, ctx);
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
	await invoke(pi, "agent_settled", {}, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 3,
			totalMs: 3_500,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 3_000,
			inputTokens: 5_900,
			generationMs: 600,
			streamedOutputTokens: 600,
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

	await invoke(pi, "before_agent_start", {}, ctx);
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
	await invoke(pi, "agent_settled", {}, ctx);
	assert.deepEqual(pi.entries, [{
		customType: WORK_TIMING_ENTRY_TYPE,
		data: {
			version: 3,
			totalMs: 2_500,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 1_800,
			inputTokens: 5_000,
			generationMs: 900,
			streamedOutputTokens: 1_800,
		},
	}]);
	const renderer = pi.renderers.get(WORK_TIMING_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
	const rendered = renderer({ data: pi.entries[0]?.data } as never, { expanded: false }, theme)?.render(120)[0]?.trim() ?? "";
	assert.equal(rendered, "Worked for 2s • ↑ 5,000 ↓ 1,800 tokens • ΣR 0s (0%) • 2,000 tok/s");
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

test("session shutdown cancels active timing without appending a completed entry", async () => {
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
		setInterval: (callback, intervalMs) => scheduler.setInterval(callback, intervalMs),
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
	const label = "Working... 47m 29s • $ bash 46m 51s • ↑ 9,861 ↓ 20,323 tokens • R 4s / ΣR 1m 33s • 217 tok/s";
	assert.equal(compactStatusLabel(label, 200), label);
	// The live tool timer and `R / ΣR` are both kept; tokens and rate are the optional fields.
	assert.equal(
		compactStatusLabel(label, 60),
		"Working... 47m 29s • $ bash 46m 51s • R 4s / ΣR 1m 33s",
	);
	assert.equal(
		compactStatusLabel(label, 80),
		"Working... 47m 29s • $ bash 46m 51s • ↑ 9,861 ↓ 20,323 tokens • R 4s / ΣR 1m 33s",
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
				version: 3,
				totalMs: 12_000,
				reasoningMs: 5_400,
				lastTurnReasoningMs: 1_000,
				inputTokens: 17_234,
				outputTokens: 4_321,
				generationMs: 16_000,
				streamedOutputTokens: 11_520,
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
