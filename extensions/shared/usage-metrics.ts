/**
 * One metric model for three lanes that differ only in scope: the working row shows one request,
 * the `Worked for` entry one external interaction, and the footer the whole session. Extensions
 * run these algorithms on their own inputs; this module holds no state and no lifecycle.
 */
import { formatTokens, promptCacheHit } from "./usage-format.ts";

/** Per-request timing fact that Pi does not persist itself, written by `work-timing`. */
export const REQUEST_TIMING_ENTRY_TYPE = "work-timing-request";
export const REQUEST_TIMING_VERSION = 1;

export interface RequestTimingData {
	version: typeof REQUEST_TIMING_VERSION;
	/** The assistant message's `timestamp`: the one-to-one join key. */
	messageTimestamp: number;
	/** First observed output signal minus the request start; absent when no signal was observed. */
	ttftMs?: number;
	/** Client-observed thinking duration of the request. */
	thinkingMs: number;
}

/** Pi treats per-request misses at or below this as cache breakpoint granularity noise. */
const REBILL_NOISE_FLOOR_TOKENS = 1024;
/** Re-bill and cost dollars below this are not displayed (subscriptions, unknown prices). */
const DOLLAR_DISPLAY_FLOOR = 0.0001;

export interface UsageFields {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
}

export interface AssistantMessageLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	timestamp?: unknown;
	stopReason?: unknown;
	durationMs?: unknown;
	usage?: UsageFields;
}

/** Cache-read price lookup ($/M tokens), satisfied by Pi's model registry. */
export interface CacheReadPriceSource {
	find(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** Aggregate of one lane; a single request is a lane of one. */
export interface LaneTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** `CH` weight: assistant prompt tokens and their cache reads. */
	promptTokens: number;
	promptCacheRead: number;
	rebillCount: number;
	rebillTokens: number;
	rebillCost: number;
	/** `✻`: thinking of eligible, matched requests. */
	thinkingMs: number;
	/** `TTFT`: sum and count of eligible, matched requests with an observed first output. */
	ttftMs: number;
	ttftCount: number;
	/** `tok/s`: output and Pi request duration of eligible requests. */
	speedOutput: number;
	speedMs: number;
}

export function emptyLaneTotals(): LaneTotals {
	return {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		promptTokens: 0, promptCacheRead: 0,
		rebillCount: 0, rebillTokens: 0, rebillCost: 0,
		thinkingMs: 0, ttftMs: 0, ttftCount: 0, speedOutput: 0, speedMs: 0,
	};
}

function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Read a persisted lane aggregate; missing or invalid fields read as zero. */
export function parseLaneTotals(data: unknown): LaneTotals {
	const totals = emptyLaneTotals();
	if (!data || typeof data !== "object") return totals;
	const record = data as Record<string, unknown>;
	for (const key of Object.keys(totals) as Array<keyof LaneTotals>) {
		totals[key] = Math.max(0, finiteOrZero(record[key]));
	}
	return totals;
}

export function parseRequestTiming(data: unknown): RequestTimingData | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== REQUEST_TIMING_VERSION) return undefined;
	const messageTimestamp = record.messageTimestamp;
	if (typeof messageTimestamp !== "number" || !Number.isFinite(messageTimestamp)) return undefined;
	const ttftMs = positiveOrUndefined(record.ttftMs);
	return {
		version: REQUEST_TIMING_VERSION,
		messageTimestamp,
		thinkingMs: Math.max(0, finiteOrZero(record.thinkingMs)),
		...(ttftMs === undefined ? {} : { ttftMs }),
	};
}

/** The previous effective request in Pi's cache-miss scan. */
export interface RebillBaseline {
	promptTokens: number;
	reportedCache: boolean;
}

export interface Rebill {
	tokens: number;
	cost: number;
}

/** One assistant message's settled facts, before lane selection. */
export interface RequestFact {
	usage: Pick<LaneTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;
	/** Pi's per-request re-bill against the session's preceding history. */
	rebill: Rebill | undefined;
	/** Present when the request is eligible for speed metrics. */
	speed: { output: number; durationMs: number } | undefined;
	thinkingMs: number | undefined;
	ttftMs: number | undefined;
}

function usageOf(fields: UsageFields | undefined): RequestFact["usage"] {
	return {
		input: finiteOrZero(fields?.input),
		output: finiteOrZero(fields?.output),
		cacheRead: finiteOrZero(fields?.cacheRead),
		cacheWrite: finiteOrZero(fields?.cacheWrite),
		cost: finiteOrZero(fields?.cost?.total),
	};
}

/**
 * One step of Pi's cache-miss detection (`core/cache-stats`, not a public export): prompt tokens
 * that were in the previous request's prompt but not read from cache, priced at this request's
 * paid rate minus its cache-read rate. Model switches count, as in Pi.
 */
export function stepRebill(
	previous: RebillBaseline | undefined,
	message: AssistantMessageLike,
	models?: CacheReadPriceSource,
): { rebill: Rebill | undefined; next: RebillBaseline | undefined } {
	const fields = message.usage;
	const input = finiteOrZero(fields?.input);
	const cacheRead = finiteOrZero(fields?.cacheRead);
	const cacheWrite = finiteOrZero(fields?.cacheWrite);
	const promptTokens = input + cacheRead + cacheWrite;
	if (!fields || promptTokens <= 0) return { rebill: undefined, next: previous };
	const cacheActivity = cacheRead + cacheWrite > 0;
	let rebill: Rebill | undefined;
	if (previous && (cacheActivity || previous.reportedCache)) {
		const missed = Math.min(previous.promptTokens, promptTokens) - cacheRead;
		if (missed > REBILL_NOISE_FLOOR_TOKENS) {
			const paidTokens = input + cacheWrite;
			const paidPerToken = paidTokens > 0
				? (finiteOrZero(fields.cost?.input) + finiteOrZero(fields.cost?.cacheWrite)) / paidTokens
				: 0;
			let readPerToken = 0;
			if (cacheRead > 0) readPerToken = finiteOrZero(fields.cost?.cacheRead) / cacheRead;
			else if (models && typeof message.provider === "string" && typeof message.model === "string") {
				readPerToken = finiteOrZero(models.find(message.provider, message.model)?.cost.cacheRead) / 1_000_000;
			}
			rebill = { tokens: missed, cost: missed * Math.max(0, paidPerToken - readPerToken) };
		}
	}
	return { rebill, next: { promptTokens, reportedCache: (previous?.reportedCache ?? false) || cacheActivity } };
}

interface EntryLike {
	type?: unknown;
	kind?: unknown;
	customType?: unknown;
	data?: unknown;
	usage?: UsageFields;
	message?: AssistantMessageLike;
}

/** Baseline change caused by a non-request entry, or `"keep"`. */
function baselineEffect(entry: EntryLike): RebillBaseline | undefined | "keep" {
	// The context legitimately changed; the next prompt is new content, not re-billed.
	if (entry.type === "compaction" || entry.type === "branch_summary") return undefined;
	if (entry.type === "usage" && entry.kind === "cache_warm" && entry.usage) {
		const promptTokens = finiteOrZero(entry.usage.input) + finiteOrZero(entry.usage.cacheRead) + finiteOrZero(entry.usage.cacheWrite);
		if (promptTokens > 0) return { promptTokens, reportedCache: true };
	}
	return "keep";
}

function isAssistantEntry(entry: EntryLike): boolean {
	return entry.type === "message" && entry.message?.role === "assistant";
}

/** Speed eligibility: completed output with a positive Pi request duration. */
function speedOf(message: AssistantMessageLike): RequestFact["speed"] {
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const output = finiteOrZero(message.usage?.output);
	const durationMs = positiveOrUndefined(message.durationMs);
	return output > 0 && durationMs !== undefined ? { output, durationMs } : undefined;
}

export function requestFact(
	message: AssistantMessageLike,
	rebill: Rebill | undefined,
	timing: RequestTimingData | undefined,
): RequestFact {
	const speed = speedOf(message);
	const matched = speed !== undefined && timing !== undefined;
	const ttftMs = matched && timing.ttftMs !== undefined && timing.ttftMs <= speed.durationMs ? timing.ttftMs : undefined;
	return {
		usage: usageOf(message.usage),
		rebill,
		speed,
		thinkingMs: matched ? timing.thinkingMs : undefined,
		ttftMs,
	};
}

export function addUsage(totals: LaneTotals, usage: RequestFact["usage"]): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost;
}

export function addRequest(totals: LaneTotals, fact: RequestFact): void {
	addUsage(totals, fact.usage);
	totals.promptTokens += fact.usage.input + fact.usage.cacheRead + fact.usage.cacheWrite;
	totals.promptCacheRead += fact.usage.cacheRead;
	if (fact.rebill) {
		totals.rebillCount += 1;
		totals.rebillTokens += fact.rebill.tokens;
		totals.rebillCost += fact.rebill.cost;
	}
	if (fact.speed) {
		totals.speedOutput += fact.speed.output;
		totals.speedMs += fact.speed.durationMs;
	}
	if (fact.thinkingMs !== undefined) totals.thinkingMs += fact.thinkingMs;
	if (fact.ttftMs !== undefined) {
		totals.ttftMs += fact.ttftMs;
		totals.ttftCount += 1;
	}
}

/**
 * Join timing entries to assistant messages one-to-one by message timestamp. A timestamp shared
 * by two timing entries or two assistant messages leaves those requests unmatched. `pending` is an
 * assistant message Pi has not persisted yet; it counts as if it were already in `entries`.
 */
function timingIndex(entries: readonly unknown[], pending?: AssistantMessageLike): Map<number, RequestTimingData> {
	const timings = new Map<number, RequestTimingData | null>();
	const assistants = new Map<number, number>();
	const countAssistant = (message: AssistantMessageLike | undefined): void => {
		if (typeof message?.timestamp === "number") assistants.set(message.timestamp, (assistants.get(message.timestamp) ?? 0) + 1);
	};
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as EntryLike;
		if (entry.type === "custom" && entry.customType === REQUEST_TIMING_ENTRY_TYPE) {
			const timing = parseRequestTiming(entry.data);
			if (!timing) continue;
			timings.set(timing.messageTimestamp, timings.has(timing.messageTimestamp) ? null : timing);
		} else if (isAssistantEntry(entry)) {
			countAssistant(entry.message);
		}
	}
	if (pending) countAssistant(pending);
	const index = new Map<number, RequestTimingData>();
	for (const [timestamp, timing] of timings) {
		if (timing && assistants.get(timestamp) === 1) index.set(timestamp, timing);
	}
	return index;
}

/**
 * Aggregate the usage-bearing entries at or after `from` in session file order. Re-bills are
 * always attributed against the whole preceding history, so a lane slice carries the same
 * re-bill facts as the session lane.
 */
export function collectLaneTotals(
	entries: readonly unknown[],
	options: { models?: CacheReadPriceSource; from?: number } = {},
): LaneTotals {
	const from = Math.max(0, options.from ?? 0);
	const totals = emptyLaneTotals();
	const timings = timingIndex(entries);
	let baseline: RebillBaseline | undefined;
	entries.forEach((raw, index) => {
		if (!raw || typeof raw !== "object") return;
		const entry = raw as EntryLike;
		const inLane = index >= from;
		if (isAssistantEntry(entry)) {
			const message = entry.message!;
			const step = stepRebill(baseline, message, options.models);
			baseline = step.next;
			if (!inLane) return;
			const timing = typeof message.timestamp === "number" ? timings.get(message.timestamp) : undefined;
			addRequest(totals, requestFact(message, step.rebill, timing));
			return;
		}
		const effect = baselineEffect(entry);
		if (effect !== "keep") baseline = effect;
		if (!inLane) return;
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
			addUsage(totals, usageOf(entry.message.usage));
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addUsage(totals, usageOf(entry.usage));
		}
	});
	return totals;
}

/** Pi's re-bill baseline after `entries`, for a request that is not yet persisted. */
export function rebillBaseline(entries: readonly unknown[], models?: CacheReadPriceSource): RebillBaseline | undefined {
	let baseline: RebillBaseline | undefined;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as EntryLike;
		if (isAssistantEntry(entry)) baseline = stepRebill(baseline, entry.message!, models).next;
		else {
			const effect = baselineEffect(entry);
			if (effect !== "keep") baseline = effect;
		}
	}
	return baseline;
}

/**
 * The request lane: one assistant message that Pi has not persisted yet, against `entries`. Its
 * timing comes from the same one-to-one join the other lanes use, so the request's timing entry
 * must already be in `entries`.
 */
export function requestLaneTotals(
	entries: readonly unknown[],
	message: AssistantMessageLike,
	models?: CacheReadPriceSource,
): LaneTotals {
	const { rebill } = stepRebill(rebillBaseline(entries, models), message, models);
	const timing = typeof message.timestamp === "number" ? timingIndex(entries, message).get(message.timestamp) : undefined;
	const totals = emptyLaneTotals();
	addRequest(totals, requestFact(message, rebill, timing));
	return totals;
}

// ---------------------------------------------------------------------------------------------
// Formatting: one formatter for every lane. Lanes only choose separators and colors.

export type MetricKey =
	| "input" | "output" | "cacheRead" | "cacheWrite" | "cacheHit" | "cost" | "rebill"
	| "thinking" | "ttft" | "rate";

export interface MetricField {
	key: MetricKey;
	text: string;
	/** The `CH` percentage, for lanes that color it. */
	percent?: number;
}

/** Compact wall duration: `0s`, `59s`, `1m12s`, `1h2m3s`. */
export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

/** Thinking stays readable next to its share: a non-zero sub-second value is not `0s`. */
export function formatThinkingDuration(durationMs: number): string {
	const value = Math.max(0, durationMs);
	return value > 0 && value < 1_000 ? "<1s" : formatDuration(value);
}

/** Latency with one decimal below ten seconds: `0.4s`, `9.8s`, `12s`, `1m5s`. */
export function formatLatency(durationMs: number): string {
	const value = Math.max(0, durationMs);
	if (value < 9_950) return `${(value / 1_000).toFixed(1)}s`;
	if (value < 59_500) return `${Math.round(value / 1_000)}s`;
	return formatDuration(value);
}

/** Output tokens per second of request duration, e.g. `25 tok/s` or `3.4 tok/s`. */
export function formatTokenRate(outputTokens: number, durationMs: number): string {
	if (!(outputTokens > 0) || !(durationMs > 0)) return "";
	const rate = outputTokens / (durationMs / 1_000);
	if (rate >= 10) return `${new Intl.NumberFormat("en-US").format(Math.round(rate))} tok/s`;
	return `${Math.round(rate * 10) / 10} tok/s`;
}

export function formatShare(partMs: number, totalMs: number): string {
	if (!(totalMs > 0) || !Number.isFinite(totalMs) || !Number.isFinite(partMs)) return "—";
	const percent = Math.round((Math.max(0, partMs) / totalMs) * 100);
	return `${Math.min(100, Math.max(0, percent))}%`;
}

/** `RB<count> <tokens>`, then ` $<amount>` when the dollars reach the display floor. */
export function formatRebill(count: number, tokens: number, cost: number): string {
	if (!(count > 0)) return "";
	const amount = cost >= DOLLAR_DISPLAY_FLOOR ? ` $${cost.toFixed(3)}` : "";
	return `RB${count} ${formatTokens(tokens)}${amount}`;
}

/** `↑ ↓ R W CH $ RB`, each present only when it has something to say. */
export function usageMetricFields(totals: LaneTotals): MetricField[] {
	const fields: MetricField[] = [];
	if (totals.input > 0) fields.push({ key: "input", text: `↑${formatTokens(totals.input)}` });
	if (totals.output > 0) fields.push({ key: "output", text: `↓${formatTokens(totals.output)}` });
	if (totals.cacheRead > 0) fields.push({ key: "cacheRead", text: `R${formatTokens(totals.cacheRead)}` });
	if (totals.cacheWrite > 0) fields.push({ key: "cacheWrite", text: `W${formatTokens(totals.cacheWrite)}` });
	const hit = promptCacheHit(totals.promptTokens - totals.promptCacheRead, totals.promptCacheRead, 0);
	if (hit !== undefined) fields.push({ key: "cacheHit", text: `CH${hit.toFixed(1)}%`, percent: hit });
	if (totals.cost > 0) fields.push({ key: "cost", text: `$${totals.cost.toFixed(3)}` });
	const rebill = formatRebill(totals.rebillCount, totals.rebillTokens, totals.rebillCost);
	if (rebill) fields.push({ key: "rebill", text: rebill });
	return fields;
}

export interface TimingFormatOptions {
	/** Interaction lane: show thinking as a share of this work-elapsed duration. */
	thinkingShareOfMs?: number;
	/** Request lane while waiting for the first output: the `TTFT` value is a running counter. */
	ttftLive?: boolean;
}

/** `✻ TTFT tok/s`; TTFT is the arithmetic mean, tok/s a ratio of sums. */
export function timingMetricFields(totals: LaneTotals, options: TimingFormatOptions = {}): MetricField[] {
	const fields: MetricField[] = [];
	if (totals.thinkingMs > 0) {
		const share = options.thinkingShareOfMs === undefined ? "" : ` (${formatShare(totals.thinkingMs, options.thinkingShareOfMs)})`;
		fields.push({ key: "thinking", text: `✻ ${formatThinkingDuration(totals.thinkingMs)}${share}` });
	}
	if (totals.ttftCount > 0) {
		fields.push({ key: "ttft", text: `TTFT ${formatLatency(totals.ttftMs / totals.ttftCount)}${options.ttftLive ? "…" : ""}` });
	}
	const rate = formatTokenRate(totals.speedOutput, totals.speedMs);
	if (rate) fields.push({ key: "rate", text: rate });
	return fields;
}
