import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const WORK_TIMING_ENTRY_TYPE = "work-timing";
const WORK_TIMING_VERSION = 3;
/**
 * Clock cadence. Time fields are re-sampled on this tick, so every duration on the
 * label advances in the same frame; the label is only reposted when it changed.
 */
const STATUS_UPDATE_INTERVAL_MS = 1_000;
const OUTPUT_CHARS_PER_TOKEN = 4;

export interface WorkTimingEntryData {
	version: 1 | 2 | 3;
	totalMs: number;
	reasoningMs: number;
	lastTurnReasoningMs: number;
	/** Request-cumulative output (downstream) tokens; absent before version 2. */
	outputTokens: number;
	/** Request-cumulative input (upstream) tokens; absent before version 3. */
	inputTokens: number;
	/** Decode-window milliseconds used as the `tok/s` denominator; absent before version 3. */
	generationMs: number;
	/** Output tokens from turns that had a decode window; the `tok/s` numerator. */
	streamedOutputTokens: number;
}

interface WorkTimingDependencies {
	now?: () => number;
	setInterval?: (callback: () => void, intervalMs: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

interface TurnTiming {
	completedReasoningMs: number;
	activeReasoning: Map<number, number>;
	/** Characters seen in streamed text, thinking, and tool-call deltas. */
	deltaChars: number;
	/** Characters in the current assistant message content, when the host exposes it. */
	messageChars: number;
	providerOutputTokens: number;
	providerInputTokens: number;
	/** First thinking or output token of this turn. */
	decodeStartedAt: number | undefined;
	/** First pause: assistant output ended or a tool started. */
	decodePausedAt: number | undefined;
}

interface RequestTiming {
	startedAt: number;
	completedReasoningMs: number;
	lastTurnReasoningMs: number;
	completedOutputTokens: number;
	completedInputTokens: number;
	completedGenerationMs: number;
	completedStreamedOutputTokens: number;
	turn: TurnTiming | undefined;
	ctx: ExtensionContext;
	lastStatus?: string;
}

interface TimingSnapshot {
	totalMs: number;
	reasoningMs: number;
	turnReasoningMs: number;
	outputTokens: number;
	inputTokens: number;
	generationMs: number;
	streamedOutputTokens: number;
}

export function formatReasoningShare(reasoningMs: number, totalMs: number): string {
	if (!(totalMs > 0) || !Number.isFinite(totalMs) || !Number.isFinite(reasoningMs)) return "—";
	const percent = Math.round((Math.max(0, reasoningMs) / totalMs) * 100);
	return `${Math.min(100, Math.max(0, percent))}%`;
}

export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Group digits the same way Pi's own counters do. */
export function formatTokens(count: number): string {
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(count)));
}

/** `↑ input ↓ output tokens`, omitting whichever side the provider has not reported. */
export function formatTokenCounts(inputTokens: number, outputTokens: number): string {
	const parts: string[] = [];
	if (inputTokens > 0) parts.push(`↑ ${formatTokens(inputTokens)}`);
	if (outputTokens > 0) parts.push(`↓ ${formatTokens(outputTokens)}`);
	return parts.length === 0 ? "" : ` • ${parts.join(" ")} tokens`;
}

/**
 * Downstream throughput over the decode window, e.g. `720 tok/s`.
 * Decode time runs from the first thinking or output token through stream stalls
 * until assistant `message_end` or the first `tool_execution_start`.
 */
export function formatTokenRate(outputTokens: number, generationMs: number): string {
	if (!(outputTokens > 0) || !(generationMs > 0)) return "";
	const rate = outputTokens / (generationMs / 1_000);
	if (rate >= 10) return `${formatTokens(Math.round(rate))} tok/s`;
	return `${Math.round(rate * 10) / 10} tok/s`;
}

/** ` • 720 tok/s`, or nothing while the rate is not measurable. */
function rateSuffix(outputTokens: number, generationMs: number): string {
	const rate = formatTokenRate(outputTokens, generationMs);
	return rate ? ` • ${rate}` : "";
}

/** Reasoning durations keep their share readable: a non-zero sub-second value is not "0s". */
export function formatReasoningDuration(durationMs: number): string {
	const value = Math.max(0, durationMs);
	return value > 0 && value < 1_000 ? "<1s" : formatDuration(value);
}

function defaultSetInterval(callback: () => void, intervalMs: number): unknown {
	const handle = globalThis.setInterval(callback, intervalMs);
	handle.unref();
	return handle;
}

function defaultClearInterval(handle: unknown): void {
	globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
}

function validDuration(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeEntryData(data: unknown): WorkTimingEntryData {
	if (!data || typeof data !== "object") {
		return { version: WORK_TIMING_VERSION, totalMs: 0, reasoningMs: 0, lastTurnReasoningMs: 0, outputTokens: 0, inputTokens: 0, generationMs: 0, streamedOutputTokens: 0 };
	}
	const candidate = data as Partial<WorkTimingEntryData>;
	return {
		version: WORK_TIMING_VERSION,
		totalMs: validDuration(candidate.totalMs),
		reasoningMs: validDuration(candidate.reasoningMs),
		lastTurnReasoningMs: validDuration(candidate.lastTurnReasoningMs),
		outputTokens: validDuration(candidate.outputTokens),
		inputTokens: validDuration(candidate.inputTokens),
		generationMs: validDuration(candidate.generationMs),
		streamedOutputTokens: validDuration(candidate.streamedOutputTokens),
	};
}

function turnOutputTokens(turn: TurnTiming): number {
	const chars = Math.max(turn.deltaChars, turn.messageChars);
	return Math.max(turn.providerOutputTokens, Math.round(chars / OUTPUT_CHARS_PER_TOKEN));
}

function startTurnDecode(turn: TurnTiming, at: number): void {
	if (turn.decodeStartedAt !== undefined || turn.decodePausedAt !== undefined) return;
	turn.decodeStartedAt = at;
}

function pauseTurnDecode(turn: TurnTiming, at: number): void {
	if (turn.decodePausedAt !== undefined || turn.decodeStartedAt === undefined) return;
	turn.decodePausedAt = Math.max(turn.decodeStartedAt, at);
}

/** First-token-to-pause decode time of one turn, including thinking and stream stalls. */
function turnDecodeMs(turn: TurnTiming, at: number): number {
	if (turn.decodeStartedAt === undefined) return 0;
	const end = turn.decodePausedAt ?? at;
	return Math.max(0, end - turn.decodeStartedAt);
}

function isDecodeSignal(type: unknown): boolean {
	return type === "thinking_start" || type === "thinking_delta" || type === "text_delta" || type === "toolcall_delta";
}

/** Streamed deltas of every output kind, including tool-call arguments. */
function streamedOutputChars(event: { type?: unknown; delta?: unknown }): number {
	if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") return 0;
	return typeof event.delta === "string" ? event.delta.length : 0;
}

/** Output characters of a complete or partial assistant message, independent of stream deltas. */
function messageOutputChars(message: unknown): number {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		const type = (block as { type?: unknown } | undefined)?.type;
		if (type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") chars += text.length;
		} else if (type === "thinking") {
			const thinking = (block as { thinking?: unknown }).thinking;
			if (typeof thinking === "string") chars += thinking.length;
		} else if (type === "toolCall" && (block as { arguments?: unknown }).arguments !== undefined) {
			try {
				chars += JSON.stringify((block as { arguments: unknown }).arguments)?.length ?? 0;
			} catch {
				/* Non-serializable arguments cannot be measured. */
			}
		}
	}
	return chars;
}

function usageTokenCount(source: unknown, field: "input" | "output"): number {
	const usage = (source as { usage?: Record<string, unknown> } | undefined)?.usage;
	const value = Number(usage?.[field]);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function recordTurnOutput(turn: TurnTiming, event: { type?: unknown; delta?: unknown; partial?: unknown }, message: unknown): void {
	const deltaChars = streamedOutputChars(event);
	turn.deltaChars += deltaChars;
	turn.messageChars = Math.max(turn.messageChars, messageOutputChars(message));
	turn.providerOutputTokens = Math.max(
		turn.providerOutputTokens,
		usageTokenCount(message, "output"),
		usageTokenCount(event.partial, "output"),
	);
	turn.providerInputTokens = Math.max(
		turn.providerInputTokens,
		usageTokenCount(message, "input"),
		usageTokenCount(event.partial, "input"),
	);
}

export function createWorkTimingExtension(
	dependencies: WorkTimingDependencies = {},
): (pi: ExtensionAPI) => void {
	const now = dependencies.now ?? (() => performance.now());
	const schedule = dependencies.setInterval ?? defaultSetInterval;
	const cancel = dependencies.clearInterval ?? defaultClearInterval;

	return (pi: ExtensionAPI): void => {
		let request: RequestTiming | undefined;
		let intervalHandle: unknown;

		const turnReasoningAt = (turn: TurnTiming, at: number): number => {
			let total = turn.completedReasoningMs;
			for (const startedAt of turn.activeReasoning.values()) {
				total += Math.max(0, at - startedAt);
			}
			return total;
		};

		const snapshotAt = (at: number): TimingSnapshot | undefined => {
			if (!request) return undefined;
			const turn = request.turn;
			const turnReasoningMs = turn ? turnReasoningAt(turn, at) : request.lastTurnReasoningMs;
			const currentOutputTokens = turn ? turnOutputTokens(turn) : 0;
			const currentInputTokens = turn ? turn.providerInputTokens : 0;
			const currentGenerationMs = turn ? turnDecodeMs(turn, at) : 0;
			const currentStreamedTokens = turn && turn.decodeStartedAt !== undefined && currentGenerationMs > 0
				? currentOutputTokens
				: 0;
			const outputTokens = request.completedOutputTokens + currentOutputTokens;
			return {
				totalMs: Math.max(0, at - request.startedAt),
				reasoningMs: request.completedReasoningMs + (turn ? turnReasoningMs : 0),
				turnReasoningMs,
				outputTokens,
				inputTokens: request.completedInputTokens + currentInputTokens,
				generationMs: request.completedGenerationMs + currentGenerationMs,
				streamedOutputTokens: request.completedStreamedOutputTokens + currentStreamedTokens,
			};
		};

		// Time fields render from the last clock sample, so every duration on the label
		// advances in the same frame; token fields always come from the live counters.
		let clock: Pick<TimingSnapshot, "totalMs" | "reasoningMs" | "turnReasoningMs"> | undefined;

		const sampleClock = (at: number): void => {
			const snapshot = snapshotAt(at);
			clock = snapshot
				? { totalMs: snapshot.totalMs, reasoningMs: snapshot.reasoningMs, turnReasoningMs: snapshot.turnReasoningMs }
				: undefined;
		};

		const paint = (at: number, resampleClock: boolean): void => {
			if (!request) return;
			if (resampleClock) sampleClock(at);
			const snapshot = snapshotAt(at);
			if (!snapshot) return;
			const durations = clock ?? snapshot;
			const status =
				`Working... ${formatDuration(durations.totalMs)}` +
				formatTokenCounts(snapshot.inputTokens, snapshot.outputTokens) +
				` • R ${formatReasoningDuration(durations.turnReasoningMs)}` +
				` / ΣR ${formatReasoningDuration(durations.reasoningMs)}` +
				rateSuffix(snapshot.streamedOutputTokens, snapshot.generationMs);
			if (status === request.lastStatus) return;
			request.lastStatus = status;
			request.ctx.ui.setWorkingMessage(status);
		};

		const stopInterval = (): void => {
			if (intervalHandle === undefined) return;
			cancel(intervalHandle);
			intervalHandle = undefined;
		};

		const startInterval = (): void => {
			if (intervalHandle !== undefined) return;
			intervalHandle = schedule(() => paint(now(), true), STATUS_UPDATE_INTERVAL_MS);
		};

		const finishTurn = (at: number): void => {
			if (!request?.turn) return;
			const reasoningMs = turnReasoningAt(request.turn, at);
			request.completedReasoningMs += reasoningMs;
			request.lastTurnReasoningMs = reasoningMs;
			pauseTurnDecode(request.turn, at);
			const outputTokens = turnOutputTokens(request.turn);
			const generationMs = turnDecodeMs(request.turn, at);
			request.completedOutputTokens += outputTokens;
			request.completedInputTokens += request.turn.providerInputTokens;
			request.completedGenerationMs += generationMs;
			if (generationMs > 0) request.completedStreamedOutputTokens += outputTokens;
			request.turn = undefined;
		};

		pi.registerEntryRenderer<WorkTimingEntryData>(
			WORK_TIMING_ENTRY_TYPE,
			(entry, _options, theme) => {
				const data = normalizeEntryData(entry.data);
				const share = formatReasoningShare(data.reasoningMs, data.totalMs);
				// Settled summary: request-cumulative values only (turn detail stays in the live label).
				const text = theme.fg(
					"muted",
					`Worked for ${formatDuration(data.totalMs)}` +
					formatTokenCounts(data.inputTokens, data.outputTokens) +
					` • ΣR ${formatReasoningDuration(data.reasoningMs)} (${share})` +
					rateSuffix(data.streamedOutputTokens, data.generationMs),
				);
				return new Text(text, 1, 0);
			},
		);

		pi.on("before_agent_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!request) {
				request = {
					startedAt: now(),
					completedReasoningMs: 0,
					lastTurnReasoningMs: 0,
					completedOutputTokens: 0,
					completedInputTokens: 0,
					completedGenerationMs: 0,
					completedStreamedOutputTokens: 0,
					turn: undefined,
					ctx,
				};
			}
			paint(now(), true);
			startInterval();
		});

		pi.on("turn_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !request) return;
			finishTurn(now());
			request.turn = {
				completedReasoningMs: 0,
				activeReasoning: new Map(),
				deltaChars: 0,
				messageChars: 0,
				providerOutputTokens: 0,
				providerInputTokens: 0,
				decodeStartedAt: undefined,
				decodePausedAt: undefined,
			};
			paint(now(), true);
		});

		pi.on("message_update", (event, ctx) => {
			if (ctx.mode !== "tui" || !request?.turn) return;
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "thinking_start") {
				if (!request.turn.activeReasoning.has(assistantEvent.contentIndex)) {
					request.turn.activeReasoning.set(assistantEvent.contentIndex, now());
				}
			} else if (assistantEvent.type === "thinking_end") {
				const startedAt = request.turn.activeReasoning.get(assistantEvent.contentIndex);
				if (startedAt !== undefined) {
					request.turn.completedReasoningMs += Math.max(0, now() - startedAt);
					request.turn.activeReasoning.delete(assistantEvent.contentIndex);
				}
			}
			if (isDecodeSignal(assistantEvent.type)) startTurnDecode(request.turn, now());
			recordTurnOutput(request.turn, assistantEvent, event.message);
			paint(now(), false);
		});

		pi.on("message_end", (event, ctx) => {
			if (ctx.mode !== "tui" || !request?.turn) return;
			if ((event as { message?: { role?: unknown } }).message?.role !== "assistant") return;
			pauseTurnDecode(request.turn, now());
			paint(now(), true);
		});

		pi.on("tool_execution_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !request?.turn) return;
			pauseTurnDecode(request.turn, now());
			paint(now(), true);
		});

		pi.on("turn_end", (event, ctx) => {
			if (ctx.mode !== "tui" || !request) return;
			if (request.turn) recordTurnOutput(request.turn, {}, event.message);
			finishTurn(now());
			paint(now(), true);
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (ctx.mode !== "tui" || !request) return;
			const settledAt = now();
			finishTurn(settledAt);
			const snapshot = snapshotAt(settledAt);
			stopInterval();
			ctx.ui.setWorkingMessage();
			request = undefined;
			clock = undefined;
			if (!snapshot) return;
			pi.appendEntry<WorkTimingEntryData>(WORK_TIMING_ENTRY_TYPE, {
				version: WORK_TIMING_VERSION,
				totalMs: snapshot.totalMs,
				reasoningMs: snapshot.reasoningMs,
				lastTurnReasoningMs: snapshot.turnReasoningMs,
				outputTokens: snapshot.outputTokens,
				inputTokens: snapshot.inputTokens,
				generationMs: snapshot.generationMs,
				streamedOutputTokens: snapshot.streamedOutputTokens,
			});
		});

		pi.on("session_shutdown", () => {
			stopInterval();
			request = undefined;
		});
	};
}

export default createWorkTimingExtension();
