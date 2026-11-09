import assert from "node:assert/strict";
import test from "node:test";

import {
	collectLaneTotals,
	emptyLaneTotals,
	formatDuration,
	formatLatency,
	formatRebill,
	formatThinkingDuration,
	formatTokenRate,
	parseLaneTotals,
	parseRequestTiming,
	REQUEST_TIMING_ENTRY_TYPE,
	requestLaneTotals,
	timingMetricFields,
	usageMetricFields,
	type LaneTotals,
} from "../extensions/shared/usage-metrics.ts";
import {
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js";

const catalog = { cost: { cacheRead: 0.3 } };
/** Pi's oracle reads `getModel`; the extensions read the registry's `find`. */
const piModels = { getModel: () => catalog } as never;
const models = { find: () => catalog };

let clock = 1_000;

interface AssistantOptions {
	cacheWrite?: number;
	model?: string;
	output?: number;
	durationMs?: number;
	stopReason?: string;
	timestamp?: number;
}

function assistant(input: number, cacheRead: number, options: AssistantOptions = {}) {
	const cacheWrite = options.cacheWrite ?? 0;
	// $3/M input, $0.30/M cache read, $3.75/M cache write, $15/M output.
	const output = options.output ?? 0;
	const cost = { input: input * 3e-6, output: output * 15e-6, cacheRead: cacheRead * 3e-7, cacheWrite: cacheWrite * 3.75e-6 };
	return {
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant", provider: "p", model: options.model ?? "m1", timestamp: options.timestamp ?? (clock += 1_000),
			stopReason: options.stopReason ?? "stop",
			...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
			usage: { input, output, cacheRead, cacheWrite, cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite } },
		},
	};
}

function timing(messageTimestamp: number, thinkingMs: number, ttftMs?: number) {
	return {
		type: "custom",
		customType: REQUEST_TIMING_ENTRY_TYPE,
		data: { version: 1, messageTimestamp, thinkingMs, ...(ttftMs === undefined ? {} : { ttftMs }) },
	};
}

/** A session with cacheless turns, growth, noise, misses, a model switch, a reset and a cache warm. */
function rebillSession() {
	return [
		// No cache activity yet: a cacheless provider never counts.
		assistant(5_000, 0),
		assistant(9_000, 0),
		// Cache appears; growth only.
		assistant(12_000, 0),
		assistant(200, 11_904),
		// Below the 1024-token noise floor, then a real miss.
		assistant(1_500, 11_000),
		assistant(9_000, 11_000),
		// Model switch re-bills and counts, as in Pi; nothing was read, so the registry price applies.
		assistant(20_000, 0, { model: "m2" }),
		// Zero-usage message leaves the previous request in place.
		assistant(0, 0),
		assistant(500, 1_000),
		// Compaction resets: the next prompt is new content.
		{ type: "compaction", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
		assistant(30_000, 0, { cacheWrite: 6_000 }),
		// Cache warming refreshes the previous request without being counted.
		{ type: "usage", kind: "cache_warm", provider: "p", model: "m1", timestamp: "2026-01-01T00:00:00.000Z", usage: { input: 0, output: 0, cacheRead: 40_000, cacheWrite: 0, cost: { total: 0.012 } } },
		assistant(40_000, 2_000),
		// A second interaction starts here; its first request re-bills against earlier history.
		assistant(5_000, 10_000),
		assistant(200, 14_900),
	];
}

const SECOND_INTERACTION = 13;

test("re-bills match Pi's /session Cache Re-billed count, tokens and dollars", () => {
	const entries = rebillSession();
	const pi = computeCacheWaste(entries as never, piModels);
	const totals = collectLaneTotals(entries, { models });
	assert.equal(totals.rebillCount, pi.missCount);
	assert.equal(totals.rebillTokens, pi.missedTokens);
	assert.ok(Math.abs(totals.rebillCost - pi.missedCost) < 1e-12);
	// The fixture exercises the registry price and a real dollar amount.
	assert.ok(pi.missCount >= 4);
	assert.ok(pi.missedCost > 0);
	// Without the registry the read rate of a no-read miss is zero, so the amount differs.
	assert.notEqual(collectLaneTotals(entries).rebillCost, totals.rebillCost);
});

test("a lane slice carries the same per-request re-bills as the session lane", () => {
	const entries = rebillSession();
	const misses = collectCacheMisses(entries as never, piModels);
	const slice = entries.slice(SECOND_INTERACTION);
	let count = 0;
	let tokens = 0;
	let cost = 0;
	for (const entry of slice) {
		const miss = misses.get((entry as { message?: never }).message as never);
		if (!miss) continue;
		count += 1;
		tokens += miss.missedTokens;
		cost += miss.missedCost;
	}
	const lane = collectLaneTotals(entries, { models, from: SECOND_INTERACTION });
	// The interaction's first request re-bills against the session's preceding history.
	assert.ok(misses.has((entries[SECOND_INTERACTION] as unknown as { message: never }).message));
	assert.equal(lane.rebillCount, count);
	assert.equal(lane.rebillTokens, tokens);
	assert.ok(Math.abs(lane.rebillCost - cost) < 1e-12);
	// A lane-local scan would see no previous request and miss it.
	assert.equal(collectLaneTotals(slice, { models }).rebillCount, count - 1);
});

test("the request lane re-bills exactly like Pi's message_end detection", () => {
	const entries = rebillSession();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index] as { type: string; message?: { role: string } };
		if (entry.type !== "message") continue;
		const previous = entries.slice(0, index);
		const expected = detectCacheMiss(previous as never, entry.message as never, piModels);
		const lane = requestLaneTotals(previous, entry.message as never, models);
		assert.equal(lane.rebillCount, expected ? 1 : 0, `request ${index}`);
		assert.equal(lane.rebillTokens, expected?.missedTokens ?? 0);
		assert.ok(Math.abs(lane.rebillCost - (expected?.missedCost ?? 0)) < 1e-12);
	}
});

test("usage sums count requests, usage-bearing tool results and summaries; CH counts requests only", () => {
	const totals = collectLaneTotals([
		assistant(100, 400, { output: 20 }),
		{ type: "message", message: { role: "toolResult", usage: { input: 7, output: 3, cacheRead: 1_000, cacheWrite: 0, cost: { total: 0.5 } } } },
		{ type: "compaction", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
		{ type: "branch_summary", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } },
		{ type: "usage", kind: "cache_warm", usage: { input: 0, output: 1, cacheRead: 500, cacheWrite: 0, cost: { total: 9 } } },
		{ type: "custom", customType: "other", data: { usage: { input: 999 } } },
		assistant(50, 950, { output: 5, cacheWrite: 0 }),
	]);
	assert.equal(totals.input, 168);
	assert.equal(totals.output, 33);
	assert.equal(totals.cacheRead, 2_350);
	// Pi cache_warm usage stays out of the dollar total.
	assert.ok(Math.abs(totals.cost - (0.5 + 0.01 + 0.02 + 100 * 3e-6 + 20 * 15e-6 + 400 * 3e-7 + 50 * 3e-6 + 5 * 15e-6 + 950 * 3e-7)) < 1e-12);
	// Prompt-token-weighted over assistant prompts: 1350 / 1500.
	assert.equal(usageMetricFields(totals).find((field) => field.key === "cacheHit")?.text, "CH90.0%");
});

test("speed counts eligible requests as a ratio of sums; timing needs a one-to-one match", () => {
	const fast = assistant(100, 0, { output: 300, durationMs: 3_000, timestamp: 101 });
	const slow = assistant(100, 0, { output: 100, durationMs: 7_000, timestamp: 102 });
	const errored = assistant(100, 0, { output: 50, durationMs: 1_000, stopReason: "error", timestamp: 103 });
	const aborted = assistant(100, 0, { output: 50, durationMs: 1_000, stopReason: "aborted", timestamp: 104 });
	const silent = assistant(100, 0, { output: 0, durationMs: 1_000, timestamp: 105 });
	const untimed = assistant(100, 0, { output: 80, timestamp: 106 });
	const totals = collectLaneTotals([
		timing(101, 1_200, 800), fast,
		timing(102, 300, 2_400), slow,
		timing(103, 900, 100), errored,
		timing(104, 900, 100), aborted,
		timing(105, 900, 100), silent,
		timing(106, 900, 100), untimed,
	]);
	assert.equal(totals.speedOutput, 400);
	assert.equal(totals.speedMs, 10_000);
	assert.equal(totals.thinkingMs, 1_500);
	assert.equal(totals.ttftMs, 3_200);
	assert.equal(totals.ttftCount, 2);
	// Ineligible requests still contribute usage.
	assert.equal(totals.output, 580);
	assert.deepEqual(timingMetricFields(totals).map((field) => field.text), ["✻ 1s", "TTFT 1.6s", "40 tok/s"]);
});

test("duplicate join keys and impossible TTFT leave timing unmatched without losing usage", () => {
	const totals = collectLaneTotals([
		timing(201, 1_000, 500), timing(201, 1_000, 500), assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 201 }),
		timing(202, 1_000, 500), assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 202 }), assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 202 }),
		timing(203, 2_000, 5_000), assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 203 }),
		timing(204, 0), assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 204 }),
	]);
	assert.equal(totals.speedOutput, 50);
	// Only the last two match; a TTFT longer than the request is not used.
	assert.equal(totals.thinkingMs, 2_000);
	assert.equal(totals.ttftCount, 0);
	assert.equal(totals.output, 50);
});

test("a timing entry before its assistant message changes nothing until the message settles", () => {
	const settled = [timing(301, 1_000, 900), assistant(1_000, 0, { output: 100, durationMs: 2_000, timestamp: 301 })];
	const before = collectLaneTotals(settled);
	const pending = collectLaneTotals([...settled, timing(302, 4_000, 3_000)]);
	assert.deepEqual(pending, before);
	const after = collectLaneTotals([...settled, timing(302, 4_000, 3_000), assistant(1_000, 0, { output: 300, durationMs: 4_000, timestamp: 302 })]);
	assert.equal(after.ttftCount, 2);
	assert.equal(after.output, 400);
});

test("the request lane is one assistant message joined to its already-appended timing entry", () => {
	const message = assistant(74_700, 0, { output: 241, durationMs: 13_400, timestamp: 401 }).message;
	const lane = requestLaneTotals([timing(401, 1_000, 9_800)], message);
	assert.equal(lane.speedOutput, 241);
	assert.equal(lane.speedMs, 13_400);
	assert.deepEqual(timingMetricFields(lane).map((field) => field.text), ["✻ 1s", "TTFT 9.8s", "18 tok/s"]);
	// Without timing the request lane still shows usage and speed.
	assert.deepEqual(timingMetricFields(requestLaneTotals([], message)).map((field) => field.text), ["18 tok/s"]);
});

test("the request lane applies the same one-to-one join as the session lane", () => {
	const message = assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 501 }).message;
	const cases = [
		// A second timing entry for the same timestamp.
		[timing(501, 1_000, 500), timing(501, 1_000, 500)],
		// An earlier assistant message already carries the timestamp.
		[assistant(10, 0, { output: 10, durationMs: 1_000, timestamp: 501 }), timing(501, 1_000, 500)],
	];
	for (const entries of cases) {
		const request = requestLaneTotals(entries, message);
		const session = collectLaneTotals([...entries, { type: "message", message }]);
		assert.equal(request.ttftCount, 0);
		assert.equal(request.thinkingMs, 0);
		assert.equal(session.ttftCount, request.ttftCount);
		assert.equal(session.thinkingMs, request.thinkingMs);
		assert.equal(request.speedOutput, 10, "usage and speed stay");
	}
});

function lane(values: Partial<LaneTotals>): LaneTotals {
	return { ...emptyLaneTotals(), ...values };
}

test("formats every lane with one field order and format", () => {
	const totals = lane({
		input: 204_000, output: 10_000, cacheRead: 1_100_000, cacheWrite: 3_000, cost: 3.5914,
		promptTokens: 1_307_000, promptCacheRead: 1_100_000,
		rebillCount: 14, rebillTokens: 90_000, rebillCost: 0.8134,
		thinkingMs: 19_000, ttftMs: 81_000, ttftCount: 10, speedOutput: 10_000, speedMs: 400_000,
	});
	assert.equal(usageMetricFields(totals).map((field) => field.text).join(" "), "↑204k ↓10k R1.1M W3.0k CH84.2% $3.591 RB14 90k $0.813");
	assert.deepEqual(timingMetricFields(totals, { thinkingShareOfMs: 415_000 }).map((field) => field.text), ["✻ 19s (5%)", "TTFT 8.1s", "25 tok/s"]);
	// Absent fields are omitted, not zero-filled.
	assert.deepEqual(usageMetricFields(emptyLaneTotals()), []);
	assert.deepEqual(timingMetricFields(emptyLaneTotals()), []);
	// The live request counter keeps its value and marks it running.
	assert.deepEqual(timingMetricFields(lane({ ttftMs: 3_240, ttftCount: 1 }), { ttftLive: true }).map((field) => field.text), ["TTFT 3.2s…"]);
});

test("re-bill dollars appear only above the display floor", () => {
	assert.equal(formatRebill(0, 0, 0), "");
	assert.equal(formatRebill(1, 62_000, 0.56), "RB1 62k $0.560");
	assert.equal(formatRebill(2, 31_000, 0), "RB2 31k");
	assert.equal(formatRebill(2, 31_000, 0.00009), "RB2 31k");
});

test("durations, latency and rates use compact display units", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(72_000), "1m12s");
	assert.equal(formatDuration(3_661_999), "1h1m1s");
	assert.equal(formatThinkingDuration(0), "0s");
	assert.equal(formatThinkingDuration(720), "<1s");
	assert.equal(formatThinkingDuration(130_000), "2m10s");
	assert.equal(formatLatency(420), "0.4s");
	assert.equal(formatLatency(9_800), "9.8s");
	assert.equal(formatLatency(12_400), "12s");
	assert.equal(formatLatency(65_000), "1m5s");
	assert.equal(formatTokenRate(0, 5_000), "");
	assert.equal(formatTokenRate(100, 0), "");
	assert.equal(formatTokenRate(4_321, 6_000), "720 tok/s");
	assert.equal(formatTokenRate(17, 5_000), "3.4 tok/s");
});

test("persisted aggregates and timing facts parse defensively", () => {
	assert.deepEqual(parseLaneTotals(undefined), emptyLaneTotals());
	assert.deepEqual(parseLaneTotals({ input: 5, output: -1, cost: "x" }), lane({ input: 5 }));
	assert.equal(parseRequestTiming({ version: 2, messageTimestamp: 1, thinkingMs: 0 }), undefined);
	assert.equal(parseRequestTiming({ version: 1, thinkingMs: 0 }), undefined);
	assert.deepEqual(parseRequestTiming({ version: 1, messageTimestamp: 7, thinkingMs: 5, ttftMs: 0 }), { version: 1, messageTimestamp: 7, thinkingMs: 5 });
});
