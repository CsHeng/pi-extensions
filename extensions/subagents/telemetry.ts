import { randomUUID } from "node:crypto";
import { HARD_LIMITS, type RunTiming, type TimeSpan } from "./contracts.ts";

export const monotonicNow = () => performance.now();
const clockKeys = new WeakMap<() => number, string>();

/** One parent-process monotonic clock. Wall timestamps are correlation only. */
export function createRunClock(source: () => number = monotonicNow) {
	if (!clockKeys.has(source)) clockKeys.set(source, randomUUID());
	const clockKey = clockKeys.get(source)!;
	const sample = () => { try { return source(); } catch { return Number.NaN; } };
	const started = sample();
	let last = started;
	let valid = Number.isFinite(started) && started >= 0;
	const now = () => {
		const value = sample();
		if (!Number.isFinite(value) || value < last) valid = false;
		last = value;
		return value;
	};
	return {
		clockKey,
		started,
		now,
		get valid() { return valid; },
		offset() { const value = now(); return valid ? value - started : null; },
		elapsed() { const value = now(); return valid ? value - started : null; },
	};
}

export type RunClock = ReturnType<typeof createRunClock>;
export const LOCAL_SPAN_KINDS = ["assistant", "reasoning", "localTool", "delegationWait", "compaction"] as const;
export type LocalSpanKind = typeof LOCAL_SPAN_KINDS[number];
export interface LocalTiming {
	version: 1;
	clockKey: string;
	originMs: number | null;
	boundary: TimeSpan;
	spans: Record<LocalSpanKind, TimeSpan[]>;
	complete: boolean;
}

/** Client-observed event spans, never server utilization or inferred reasoning. */
export class LocalTimingRecorder {
	private readonly clock: RunClock;
	private readonly open = new Map<string, TimeSpan>();
	private readonly spans: LocalTiming["spans"] = { assistant: [], reasoning: [], localTool: [], delegationWait: [], compaction: [] };
	private valid = true;
	private count = 0;
	constructor(now: () => number = monotonicNow) { this.clock = createRunClock(now); }
	start(kind: LocalSpanKind, key: string): void {
		const identity = `${kind}:${key}`;
		if (!key.length || key.length > 128 || this.open.has(identity) || this.count >= HARD_LIMITS.maxWaitSpans) { this.valid = false; return; }
		const span = { startMs: this.clock.offset(), endMs: null };
		this.count++; this.spans[kind].push(span); this.open.set(identity, span);
	}
	end(kind: LocalSpanKind, key: string): void {
		const identity = `${kind}:${key}`; const span = this.open.get(identity);
		if (!span) { this.valid = false; return; }
		span.endMs = this.clock.offset(); this.open.delete(identity);
	}
	hasOpen(kind: LocalSpanKind, key: string): boolean { return this.open.has(`${kind}:${key}`); }
	invalidate(): void { this.valid = false; }
	finish(): LocalTiming {
		const endMs = this.clock.elapsed();
		return { version: 1, clockKey: this.clock.clockKey, originMs: this.clock.valid ? this.clock.started : null,
			boundary: { startMs: this.clock.valid ? 0 : null, endMs }, spans: structuredClone(this.spans),
			complete: this.valid && this.clock.valid && this.open.size === 0 && Object.values(this.spans).flat().every((span) => spanDuration(span) !== null),
		};
	}
}

export function isLocalTiming(value: unknown): value is LocalTiming {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	const span = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const item = value as Record<string, unknown>;
		return Object.keys(item).every((key) => key === "startMs" || key === "endMs") && [item.startMs, item.endMs].every((endpoint) => endpoint === null || (typeof endpoint === "number" && Number.isFinite(endpoint) && endpoint >= 0));
	};
	if (Object.keys(data).some((key) => !["version", "clockKey", "originMs", "boundary", "spans", "complete"].includes(key)) || data.version !== 1
		|| typeof data.clockKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.clockKey) || typeof data.complete !== "boolean"
		|| (data.originMs !== null && !(typeof data.originMs === "number" && Number.isFinite(data.originMs) && data.originMs >= 0)) || !span(data.boundary)
		|| !data.spans || typeof data.spans !== "object" || Array.isArray(data.spans)) return false;
	const groups = data.spans as Record<string, unknown>;
	if (Object.keys(groups).length !== LOCAL_SPAN_KINDS.length) return false;
	let count = 0;
	for (const kind of LOCAL_SPAN_KINDS) {
		const entries = groups[kind]; if (!Array.isArray(entries) || (count += entries.length) > HARD_LIMITS.maxWaitSpans || !entries.every(span)) return false;
		if (data.complete && entries.some((entry) => spanDuration(entry) === null || entry.startMs < (data.boundary as TimeSpan).startMs! || entry.endMs > (data.boundary as TimeSpan).endMs!)) return false;
	}
	return !data.complete || (data.originMs !== null && spanDuration(data.boundary as TimeSpan) !== null);
}

export function spanDuration(span: TimeSpan): number | null {
	if (span.startMs === null || span.endMs === null || !Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.startMs < 0 || span.endMs < span.startMs) return null;
	return span.endMs - span.startMs;
}

/** Intervals share a single origin; effort is not wall time or utilization. */
export function workerIntervalTotals(timing: RunTiming): { effortMs: number | null; occupiedMs: number | null } {
	if (!timing.complete) return { effortMs: null, occupiedMs: null };
	const spans = timing.children.filter((span) => span.role === "worker");
	if (spans.some((span) => spanDuration(span) === null)) return { effortMs: null, occupiedMs: null };
	const sorted = spans.map((span) => ({ start: span.startMs as number, end: span.endMs as number })).sort((a, b) => a.start - b.start);
	let effortMs = 0;
	let occupiedMs = 0;
	let end = 0;
	for (const span of sorted) {
		effortMs += span.end - span.start;
		occupiedMs += Math.max(0, span.end - Math.max(end, span.start));
		end = Math.max(end, span.end);
	}
	return { effortMs, occupiedMs };
}
