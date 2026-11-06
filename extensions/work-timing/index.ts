import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	createInteractionBoundary,
	type InteractionClose,
	type InteractionKind,
	type InteractionSpan,
	type InteractionStatus,
} from "../shared/interaction-boundary.ts";

export const WORK_TIMING_ENTRY_TYPE = "work-timing";
const WORK_TIMING_VERSION = 4;
/**
 * Clock cadence. Time fields are re-sampled on this tick, so every duration on the
 * label advances in the same frame; the label is only reposted when it changed.
 */
const STATUS_UPDATE_INTERVAL_MS = 1_000;
const OUTPUT_CHARS_PER_TOKEN = 4;
/** A live tool field appears only after this much work, so quick reads never flash. */
const TOOL_ELAPSED_MIN_MS = 2_000;
/** The tool field's `⚙ ` prefix; the field survives narrow-width compaction like `R / ΣR`. */
const TOOL_FIELD_PREFIX = "⚙ ";
/** Entry rows mirror the host Text component's one-column side padding. */
const TEXT_PADDING_X = 1;
/**
 * Chrome the fullscreen working row reserves around the message: the `─ ` rule
 * prefix, the two spinner columns, a separating space, and the minimum dash
 * fill. The live label compacts to what remains of the terminal width.
 */
const WORKING_ROW_CHROME = 8;

/** Same width source pi-tui's ProcessTerminal uses, so folds match host rendering exactly. */
function defaultColumns(): number {
	return process.stdout.columns || Number(process.env.COLUMNS) || 80;
}

function defaultOnResize(listener: () => void): () => void {
	process.stdout.on("resize", listener);
	return () => process.stdout.removeListener("resize", listener);
}

/**
 * Fold a ` • `-separated label onto multiple lines, breaking only at field
 * boundaries. Fields that alone exceed the width pass through unchanged; the
 * host's word wrap (or wrapTextWithAnsi for entry rows) handles those.
 */
export function foldStatusLine(status: string, width: number): string {
	if (width <= 0) return status;
	const budget = Math.max(1, width);
	if (visibleWidth(status) <= budget) return status;
	const lines: string[] = [];
	let current = "";
	for (const field of status.split(" • ")) {
		const candidate = current ? `${current} • ${field}` : field;
		if (!current || visibleWidth(candidate) <= budget) {
			current = candidate;
		} else {
			lines.push(current);
			current = field;
		}
	}
	if (current) lines.push(current);
	return lines.join("\n");
}

const FIELD_SEPARATOR_WIDTH = 3;

/**
 * Compact the live label to ONE line for the host's single-line working row
 * (fullscreen renders only the first line of a multi-line or over-wide
 * message). Fields keep their order; the `R x / ΣR y` structure is always
 * kept; fields that no longer fit are omitted whole rather than truncated
 * mid-field — matching the zero-state label, which omits tokens and rate
 * until they exist.
 */
export function compactStatusLabel(status: string, width: number): string {
	if (width <= 0) return status;
	const budget = Math.max(1, width);
	if (visibleWidth(status) <= budget) return status;
	const fields = status.split(" • ");
	const coreIndex = fields.findIndex((field) => /^R .* \/ ΣR /.test(field));
	if (coreIndex < 0) return status;
	// `R / ΣR` and a live tool field are the row's identity while work is in flight;
	// optional fields fill back in around them only while the budget allows.
	const required = new Set<number>([coreIndex]);
	const toolIndex = fields.findIndex((field) => field.startsWith(TOOL_FIELD_PREFIX));
	if (toolIndex >= 0) required.add(toolIndex);
	const head = fields[0]!;
	const kept: string[] = [head];
	let current = visibleWidth(head);
	for (let index = 1; index < fields.length; index += 1) {
		const field = fields[index]!;
		const candidate = current + FIELD_SEPARATOR_WIDTH + visibleWidth(field);
		if (required.has(index)) {
			kept.push(field);
			current = candidate;
			continue;
		}
		// Reserve room for required fields that still come later before taking an optional one.
		let reserve = 0;
		for (const requiredIndex of required) {
			if (requiredIndex > index) reserve += FIELD_SEPARATOR_WIDTH + visibleWidth(fields[requiredIndex]!);
		}
		if (candidate + reserve <= budget) {
			kept.push(field);
			current = candidate;
		}
	}
	return kept.join(" • ");
}

/** What an entry measures: one external interaction, or the restored single-run meaning of v1-v3. */
export type WorkTimingScope = InteractionKind;
/** A settled interaction reached quiescence; failed, interrupted and unavailable did not. */
export type WorkTimingStatus = InteractionStatus;

export interface WorkTimingEntryData {
	version: 1 | 2 | 3 | 4;
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
	/** Version 4: interaction span, or the historical single-run scope of v1-v3. */
	scope: WorkTimingScope;
	/** Version 4: whether the span reached quiescence, failed, was cut short, or could not be verified. */
	status: WorkTimingStatus;
	/** Version 4: pure human wait already excluded from `totalMs`. */
	humanWaitMs: number;
}

interface WorkTimingDependencies {
	now?: () => number;
	setInterval?: (callback: () => void, intervalMs: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	/** Reports the host render width in columns; defaults to pi-tui's terminal width source. */
	columns?: () => number;
	/** Subscribes a terminal-resize listener; the returned function unsubscribes. */
	onResize?: (listener: () => void) => () => void;
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
	/** Character prefix already produced before an interaction joined this turn. */
	outputBaseline: number;
	/** A joined turn cannot attribute cumulative provider usage to its post-cut portion. */
	partial: boolean;
	/** First thinking or output token of this turn. */
	decodeStartedAt: number | undefined;
	/** First pause: assistant output ended or a tool started. */
	decodePausedAt: number | undefined;
}

interface ActiveTool {
	toolCallId: string | undefined;
	toolName: string;
	startedAt: number;
	/** Time spent waiting on extension UI prompts while this tool was active. */
	promptMs: number;
}

interface ClockSample {
	totalMs: number;
	reasoningMs: number;
	turnReasoningMs: number;
	toolMs: number;
}

/**
 * Measurements of one span. The shared interaction boundary owns when a span starts and ends
 * (external input through final quiescence, failure or interruption); this extension owns only
 * what it measures inside that span.
 */
interface TimingData {
	/** Completed-run totals; the in-flight turn is added by each snapshot. */
	reasoningMs: number;
	lastTurnReasoningMs: number;
	outputTokens: number;
	inputTokens: number;
	generationMs: number;
	streamedOutputTokens: number;
	turn: TurnTiming | undefined;
	/** Tools executing right now, in start order. */
	tools: ActiveTool[];
	/** The slow-lane duration sample shared by both paint lanes. */
	clock: ClockSample | undefined;
	lastStatus: string | undefined;
}

type TimingSpan = InteractionSpan<TimingData>;

interface TimingSnapshot {
	totalMs: number;
	reasoningMs: number;
	turnReasoningMs: number;
	outputTokens: number;
	inputTokens: number;
	generationMs: number;
	streamedOutputTokens: number;
	/** Longest-running active tool, zero when no tool is executing. */
	toolMs: number;
	toolCount: number;
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

/** `↑ input ↓ output tokens` as one field, omitting whichever side is unreported. */
export function tokenCountFields(inputTokens: number, outputTokens: number): string[] {
	const parts: string[] = [];
	if (inputTokens > 0) parts.push(`↑ ${formatTokens(inputTokens)}`);
	if (outputTokens > 0) parts.push(`↓ ${formatTokens(outputTokens)}`);
	return parts.length === 0 ? [] : [`${parts.join(" ")} tokens`];
}

/** ` • ↑ input ↓ output tokens`, omitting whichever side the provider has not reported. */
export function formatTokenCounts(inputTokens: number, outputTokens: number): string {
	const fields = tokenCountFields(inputTokens, outputTokens);
	return fields.length === 0 ? "" : ` • ${fields[0]}`;
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
	const candidate = (data && typeof data === "object" ? data : {}) as Partial<WorkTimingEntryData>;
	const version = candidate.version === 1 || candidate.version === 2 || candidate.version === 3
		? candidate.version
		: WORK_TIMING_VERSION;
	const current = version === WORK_TIMING_VERSION;
	return {
		version,
		totalMs: validDuration(candidate.totalMs),
		reasoningMs: validDuration(candidate.reasoningMs),
		lastTurnReasoningMs: validDuration(candidate.lastTurnReasoningMs),
		outputTokens: validDuration(candidate.outputTokens),
		inputTokens: validDuration(candidate.inputTokens),
		generationMs: validDuration(candidate.generationMs),
		streamedOutputTokens: validDuration(candidate.streamedOutputTokens),
		// Older entries recorded one settled native run and claim no human-wait exclusion.
		scope: current && candidate.scope === "interaction" ? "interaction" : "run",
		status: current && (candidate.status === "interrupted" || candidate.status === "failed" || candidate.status === "unavailable")
			? candidate.status
			: "settled",
		humanWaitMs: current ? validDuration(candidate.humanWaitMs) : 0,
	};
}

function turnOutputTokens(turn: TurnTiming): number {
	const chars = Math.max(turn.deltaChars, turn.messageChars);
	if (turn.partial) return Math.round(Math.max(0, chars - turn.outputBaseline) / OUTPUT_CHARS_PER_TOKEN);
	return Math.max(turn.providerOutputTokens, Math.round(chars / OUTPUT_CHARS_PER_TOKEN));
}

/** Provider input tokens this interaction can attribute to the turn. */
function turnInputTokens(turn: TurnTiming): number {
	// This request's prompt was sent before the person joined, even if usage arrives later.
	return turn.partial ? 0 : turn.providerInputTokens;
}

/**
 * Cut an in-flight turn at the moment an interaction joined it. Nothing produced, reasoned
 * or decoded before the cut belongs to the interaction: the decode window restarts at the cut,
 * completed reasoning is dropped, and token metrics subtract the already-seen prefix so only
 * the rest of the turn is attributed. A turn that had finished decoding contributes no
 * decode window at all.
 */
function cutTurnAt(turn: TurnTiming, at: number): TurnTiming {
	const chars = Math.max(turn.deltaChars, turn.messageChars);
	const decoding = turn.decodeStartedAt !== undefined && turn.decodePausedAt === undefined;
	return {
		completedReasoningMs: 0,
		activeReasoning: new Map([...turn.activeReasoning.keys()].map((index) => [index, at])),
		deltaChars: turn.deltaChars,
		messageChars: turn.messageChars,
		providerOutputTokens: turn.providerOutputTokens,
		providerInputTokens: turn.providerInputTokens,
		outputBaseline: chars,
		partial: true,
		decodeStartedAt: decoding ? at : undefined,
		decodePausedAt: undefined,
	};
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
	const columns = dependencies.columns ?? defaultColumns;
	const onResize = dependencies.onResize ?? defaultOnResize;

	return (pi: ExtensionAPI): void => {
		let intervalHandle: unknown;
		let unsubscribeResize: (() => void) | undefined;

		const emptyData = (): TimingData => ({
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 0,
			inputTokens: 0,
			generationMs: 0,
			streamedOutputTokens: 0,
			turn: undefined,
			tools: [],
			clock: undefined,
			lastStatus: undefined,
		});

		const stopInterval = (): void => {
			if (intervalHandle === undefined) return;
			cancel(intervalHandle);
			intervalHandle = undefined;
		};

		/** The interaction ended; the boundary already released its span and observer. */
		const finalize = ({ span: current, status, totalMs, humanWaitMs }: InteractionClose<TimingData>): void => {
			stopInterval();
			current.ctx.ui.setWorkingMessage();
			const data = current.data;
			pi.appendEntry<WorkTimingEntryData>(WORK_TIMING_ENTRY_TYPE, {
				version: WORK_TIMING_VERSION,
				totalMs,
				reasoningMs: data.reasoningMs,
				lastTurnReasoningMs: data.lastTurnReasoningMs,
				outputTokens: data.outputTokens,
				inputTokens: data.inputTokens,
				generationMs: data.generationMs,
				streamedOutputTokens: data.streamedOutputTokens,
				scope: "interaction",
				status,
				humanWaitMs,
			});
		};

		const boundary = createInteractionBoundary<TimingData>({
			pi,
			now,
			createData: emptyData,
			/**
			 * The earlier run's completed metrics are not historical interaction work, and a
			 * mid-turn cut keeps only its post-cut part. The live tool clocks measure the tools
			 * themselves, not the interaction, so they continue.
			 */
			promoteData: (previous, at) => ({
				...emptyData(),
				tools: previous.tools,
				turn: previous.turn ? cutTurnAt(previous.turn, at) : undefined,
			}),
			onClose: finalize,
		});

		const turnReasoningAt = (turn: TurnTiming, at: number): number => {
			let total = turn.completedReasoningMs;
			for (const startedAt of turn.activeReasoning.values()) {
				total += Math.max(0, at - startedAt);
			}

			return total;
		};

		const toolSnapshotAt = (current: TimingSpan, at: number): Pick<TimingSnapshot, "toolMs" | "toolCount"> => {
			const tools = current.data.tools;
			if (tools.length === 0) return { toolMs: 0, toolCount: 0 };
			const openPromptMs = current.promptStartedAt === undefined ? 0 : Math.max(0, at - current.promptStartedAt);
			let toolMs = 0;
			for (const tool of tools) {
				// A prompt that opened after this tool started pauses only its own span.
				const promptMs = Math.min(openPromptMs, Math.max(0, at - tool.startedAt));
				const elapsed = Math.max(0, at - tool.startedAt - tool.promptMs - promptMs);
				// The longest-running tool leads; ties keep the oldest (start order).
				if (elapsed > toolMs) toolMs = elapsed;
			}
			return { toolMs, toolCount: tools.length };
		};

		const snapshotAt = (current: TimingSpan, at: number): TimingSnapshot => {
			const data = current.data;
			const turn = data.turn;
			const turnReasoningMs = turn ? turnReasoningAt(turn, at) : data.lastTurnReasoningMs;
			const currentOutputTokens = turn ? turnOutputTokens(turn) : 0;
			const currentInputTokens = turn ? turnInputTokens(turn) : 0;
			const currentGenerationMs = turn ? turnDecodeMs(turn, at) : 0;
			const currentStreamedTokens = turn && turn.decodeStartedAt !== undefined && currentGenerationMs > 0
				? currentOutputTokens
				: 0;
			const outputTokens = data.outputTokens + currentOutputTokens;
			return {
				// Human wait is excluded: the span reports autonomous wall time.
				totalMs: Math.max(0, at - current.startedAt - current.humanWaitMs),
				reasoningMs: data.reasoningMs + (turn ? turnReasoningMs : 0),
				turnReasoningMs,
				outputTokens,
				inputTokens: data.inputTokens + currentInputTokens,
				generationMs: data.generationMs + currentGenerationMs,
				streamedOutputTokens: data.streamedOutputTokens + currentStreamedTokens,
				...toolSnapshotAt(current, at),
			};
		};

		// The slow lane samples durations; the stream lane refreshes tokens/rate.
		// Both publish through the same formatter and working-message writer.
		const sampleClock = (current: TimingSpan, at: number): void => {
			const snapshot = snapshotAt(current, at);
			current.data.clock = {
				totalMs: snapshot.totalMs,
				reasoningMs: snapshot.reasoningMs,
				turnReasoningMs: snapshot.turnReasoningMs,
				toolMs: snapshot.toolMs,
			};
		};

		const paint = (at: number, resampleClock: boolean): void => {
			const current = boundary.current;
			if (!current) return;
			if (resampleClock) sampleClock(current, at);
			const snapshot = snapshotAt(current, at);
			const durations = current.data.clock ?? snapshot;
			// Live tool timing: only a long-running tool is worth surfacing, and it
			// vanishes the moment the tool ends.
			const toolField = durations.toolMs >= TOOL_ELAPSED_MIN_MS
				? `${TOOL_FIELD_PREFIX}${formatDuration(durations.toolMs)}${snapshot.toolCount > 1 ? ` +${snapshot.toolCount - 1}` : ""}`
				: "";
			const status =
				`Working... ${formatDuration(durations.totalMs)}` +
				(toolField ? ` • ${toolField}` : "") +
				formatTokenCounts(snapshot.inputTokens, snapshot.outputTokens) +
				` • R ${formatReasoningDuration(durations.turnReasoningMs)}` +
				` / ΣR ${formatReasoningDuration(durations.reasoningMs)}` +
				rateSuffix(snapshot.streamedOutputTokens, snapshot.generationMs);
			// Compact to the host's single-line working row; fields that cannot fit are omitted.
			const label = compactStatusLabel(status, Math.max(1, columns() - WORKING_ROW_CHROME));
			if (label === current.data.lastStatus) return;
			current.data.lastStatus = label;
			current.ctx.ui.setWorkingMessage(label);
		};

		const startInterval = (): void => {
			if (intervalHandle !== undefined) return;
			intervalHandle = schedule(() => {
				if (!boundary.current) return;
				const at = now();
				boundary.samplePrompt(at);
				paint(at, true);
			}, STATUS_UPDATE_INTERVAL_MS);
		};

		const finishTurn = (current: TimingSpan, at: number): void => {
			// Tool and prompt events always precede the turn boundary; close any leftover
			// state so a stale timer can never outlive its turn.
			boundary.closePrompt(at);
			const data = current.data;
			data.tools.length = 0;
			if (!data.turn) return;
			const reasoningMs = turnReasoningAt(data.turn, at);
			pauseTurnDecode(data.turn, at);
			const outputTokens = turnOutputTokens(data.turn);
			const generationMs = turnDecodeMs(data.turn, at);
			data.reasoningMs += reasoningMs;
			data.lastTurnReasoningMs = reasoningMs;
			data.outputTokens += outputTokens;
			data.inputTokens += turnInputTokens(data.turn);
			data.generationMs += generationMs;
			if (generationMs > 0) data.streamedOutputTokens += outputTokens;
			data.turn = undefined;
		};

		const teardown = (): void => {
			stopInterval();
			unsubscribeResize?.();
			unsubscribeResize = undefined;
			boundary.reset();
		};

		pi.registerEntryRenderer<WorkTimingEntryData>(
			WORK_TIMING_ENTRY_TYPE,
			(entry, _options, theme) => {
				const data = normalizeEntryData(entry.data);
				const share = formatReasoningShare(data.reasoningMs, data.totalMs);
				// Settled summary: cumulative values only (turn detail stays in the live label).
				const rate = formatTokenRate(data.streamedOutputTokens, data.generationMs);
				const elapsed = formatDuration(data.totalMs);
				const head = data.status === "interrupted"
					? `Interrupted after ${elapsed}`
					: data.status === "failed"
						? `Failed after ${elapsed}`
						: data.status === "unavailable"
							? `Timed ${elapsed} (state unavailable)`
							: `Worked for ${elapsed}`;
				const waited = data.humanWaitMs >= 1_000 ? formatDuration(data.humanWaitMs) : "";
				const fields = [
					head,
					...(waited ? [`waited ${waited}`] : []),
					...tokenCountFields(data.inputTokens, data.outputTokens),
					`ΣR ${formatReasoningDuration(data.reasoningMs)} (${share})`,
					...(rate ? [rate] : []),
				];
				const text = fields.join(" • ");
				return {
					render(width: number): string[] {
						// Fold at field boundaries; a lone over-wide field falls back to word wrap.
						const limit = Math.max(1, width - TEXT_PADDING_X * 2);
						const rows = foldStatusLine(text, limit)
							.split("\n")
							.flatMap((row) => (visibleWidth(row) > limit ? wrapTextWithAnsi(row, limit) : [row]));
						return rows.map((row) => {
							const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
							return theme.fg("muted", row) + padding;
						});
					},
					invalidate(): void {},
				};
			},
		);

		pi.on("input", (event, ctx) => {
			if (ctx.mode !== "tui") return;
			boundary.input(event.source, ctx, now());
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!unsubscribeResize) {
				// Display-only refresh: realigns the fold with the new width immediately.
				unsubscribeResize = onResize(() => paint(now(), false));
			}
			const at = now();
			boundary.beforeAgentStart(event.messageType, ctx, at);
			paint(at, true);
			startInterval();
		});

		pi.on("turn_start", (_event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			finishTurn(current, now());
			current.data.turn = {
				completedReasoningMs: 0,
				activeReasoning: new Map(),
				deltaChars: 0,
				messageChars: 0,
				providerOutputTokens: 0,
				providerInputTokens: 0,
				outputBaseline: 0,
				partial: false,
				decodeStartedAt: undefined,
				decodePausedAt: undefined,
			};
			paint(now(), true);
		});

		pi.on("message_update", (event, ctx) => {
			const turn = boundary.current?.data.turn;
			if (ctx.mode !== "tui" || !turn) return;
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "thinking_start") {
				if (!turn.activeReasoning.has(assistantEvent.contentIndex)) {
					turn.activeReasoning.set(assistantEvent.contentIndex, now());
				}
			} else if (assistantEvent.type === "thinking_end") {
				const startedAt = turn.activeReasoning.get(assistantEvent.contentIndex);
				if (startedAt !== undefined) {
					turn.completedReasoningMs += Math.max(0, now() - startedAt);
					turn.activeReasoning.delete(assistantEvent.contentIndex);
				}
			}
			if (isDecodeSignal(assistantEvent.type)) startTurnDecode(turn, now());
			recordTurnOutput(turn, assistantEvent, event.message);
			paint(now(), false);
		});

		pi.on("message_end", (event, ctx) => {
			const turn = boundary.current?.data.turn;
			if (ctx.mode !== "tui" || !turn) return;
			if ((event as { message?: { role?: unknown } }).message?.role !== "assistant") return;
			pauseTurnDecode(turn, now());
			paint(now(), true);
		});

		const toolNameOf = (event: { toolName?: unknown }): string =>
			typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";

		const removeActiveTool = (current: TimingSpan, event: { toolCallId?: unknown; toolName?: unknown }): void => {
			const tools = current.data.tools;
			const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
			const toolName = typeof event.toolName === "string" && event.toolName ? event.toolName : undefined;
			let index = toolCallId === undefined ? -1 : tools.findIndex((tool) => tool.toolCallId === toolCallId);
			if (index < 0 && toolName !== undefined) index = tools.findIndex((tool) => tool.toolName === toolName);
			if (index >= 0) tools.splice(index, 1);
		};

		pi.on("tool_execution_start", (event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			const at = now();
			boundary.toolStart(event.toolCallId, at);
			if (current.data.turn) pauseTurnDecode(current.data.turn, at);
			const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
			current.data.tools.push({
				toolCallId,
				toolName: toolNameOf(event),
				startedAt: at,
				promptMs: 0,
			});
			paint(at, true);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			const at = now();
			boundary.toolEnd((event as { result?: unknown }).result, at);
			removeActiveTool(current, event);
			paint(at, true);
		});

		pi.on("ui_prompt_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !boundary.current) return;
			// Waiting on the user is not tool time; only interactions attribute human wait.
			boundary.promptStart(now());
		});

		pi.on("ui_prompt_end", (_event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			const at = now();
			const waitedMs = boundary.promptEnd(at);
			if (waitedMs === undefined) return;
			for (const tool of current.data.tools) tool.promptMs += waitedMs;
			paint(at, true);
		});

		pi.on("turn_end", (event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			if (current.data.turn) recordTurnOutput(current.data.turn, {}, event.message);
			finishTurn(current, now());
			paint(now(), true);
		});

		pi.on("agent_settled", (event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			const settledAt = now();
			finishTurn(current, settledAt);
			current.data.clock = undefined;
			current.data.lastStatus = undefined;
			// One summary only after the main loop and all work this interaction owns are quiet,
			// or when the interaction was cut or failed.
			const outcome = boundary.settled(event.aborted === true, ctx, settledAt);
			if (outcome === "closed") return;
			// A run no human started has nothing to summarize; an awaiting interaction keeps its
			// span while the native working row stops between runs.
			stopInterval();
			ctx.ui.setWorkingMessage();
		});

		pi.on("session_tree", () => {
			// A branch change moves the append target: never write old-scope state into it.
			teardown();
		});

		pi.on("session_shutdown", () => {
			teardown();
		});
	};
}

export default createWorkTimingExtension();
