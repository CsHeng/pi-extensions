import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	executionKey,
	observeExecutionQuiescence,
	readExecutionQuiescence,
	type ExecutionScope,
} from "../shared/execution-quiescence.ts";

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
export type WorkTimingScope = "interaction" | "run";
/** A settled interaction reached quiescence; interrupted and unavailable did not. */
export type WorkTimingStatus = "settled" | "interrupted" | "unavailable";

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
	/** Version 4: whether the span reached quiescence, was cut short, or could not be verified. */
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
 * One measured span. An interaction span starts at real external input and ends only
 * when the main loop is settled and every execution it owns has finished without a
 * pending or reserved result delivery; a run span measures a model run that no human
 * input started and produces no summary entry.
 */
interface TimingSpan {
	kind: WorkTimingScope;
	startedAt: number;
	ctx: ExtensionContext;
	/** Completed-run totals; the in-flight turn is added by each snapshot. */
	reasoningMs: number;
	lastTurnReasoningMs: number;
	outputTokens: number;
	inputTokens: number;
	generationMs: number;
	streamedOutputTokens: number;
	/** Pure human wait excluded from `totalMs`; interactions only. */
	humanWaitMs: number;
	/** Executions already present when the interaction started; never inferred as its work. */
	excludedExecutions: Set<string>;
	/** Native tool calls started in this span, kept as the raw opaque ids the host gave. */
	toolCallIds: Set<string>;
	/** Producer executions explicitly adopted by a control or query receipt. */
	executionKeys: Set<string>;
	/** Native Agent runs explicitly adopted by a control or query receipt. */
	runIds: Set<string>;
	turn: TurnTiming | undefined;
	/** Tools executing right now, in start order. */
	tools: ActiveTool[];
	/** Start of the open extension UI prompt span, when the user is being asked. */
	promptStartedAt: number | undefined;
	/** When the open prompt's human wait was last attributed. */
	promptSampledAt: number | undefined;
	/** Whether related executions were progressing at the last prompt sample. */
	promptBusy: boolean;
	/** The slow-lane duration sample shared by both paint lanes. */
	clock: ClockSample | undefined;
	/** The host accepted a run and has not settled it yet. */
	runActive: boolean;
	/** A native run settled inside this interaction; owned work may still be running. */
	awaiting: boolean;
	lastStatus: string | undefined;
	stopObserving: (() => void) | undefined;
}

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
		status: current && (candidate.status === "interrupted" || candidate.status === "unavailable")
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

/**
 * Producer receipts from a control or query call adopt work that started earlier.
 * Creation receipts already carry the originating tool call, so this only needs the
 * public execution/run identities a late inspect, wait, join or cancel returns.
 */
function adoptionFromToolResult(result: unknown): { executionKeys: string[]; runIds: string[] } {
	const details = (result as { details?: unknown } | undefined)?.details;
	if (!details || typeof details !== "object") return { executionKeys: [], runIds: [] };
	const record = details as { executionId?: unknown; runId?: unknown };
	return {
		executionKeys: typeof record.executionId === "string" && record.executionId
			? [executionKey("retained-shell", record.executionId)]
			: [],
		runIds: typeof record.runId === "string" && record.runId ? [record.runId] : [],
	};
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
		let span: TimingSpan | undefined;
		/**
		 * A real external input has arrived, but its native run has not started yet. Every input
		 * event replaces or clears it, and only the user run that follows that input can consume
		 * it, so a handled input cannot be inherited by a later automatic run.
		 */
		let pendingInteractionStart: number | undefined;
		let intervalHandle: unknown;
		let unsubscribeResize: (() => void) | undefined;

		const turnReasoningAt = (turn: TurnTiming, at: number): number => {
			let total = turn.completedReasoningMs;
			for (const startedAt of turn.activeReasoning.values()) {
				total += Math.max(0, at - startedAt);
			}

			return total;
		};

		const scopeOf = (current: TimingSpan): ExecutionScope => ({
			toolCallIds: current.toolCallIds,
			...(current.executionKeys.size > 0 ? { executionKeys: current.executionKeys } : {}),
			...(current.runIds.size > 0 ? { runIds: current.runIds } : {}),
			...(current.excludedExecutions.size > 0 ? { excludedExecutions: current.excludedExecutions } : {}),
		});

		/** Whether related async work is progressing; unavailable state counts as work, not human wait. */
		const relatedExecutionsActive = (current: TimingSpan): boolean => {
			const quiescence = readExecutionQuiescence(pi, current.ctx, scopeOf(current));
			return quiescence.state === "unavailable" || quiescence.activeExecutions > 0;
		};

		const toolSnapshotAt = (current: TimingSpan, at: number): Pick<TimingSnapshot, "toolMs" | "toolCount"> => {
			if (current.tools.length === 0) return { toolMs: 0, toolCount: 0 };
			const openPromptMs = current.promptStartedAt === undefined ? 0 : Math.max(0, at - current.promptStartedAt);
			let toolMs = 0;
			for (const tool of current.tools) {
				// A prompt that opened after this tool started pauses only its own span.
				const promptMs = Math.min(openPromptMs, Math.max(0, at - tool.startedAt));
				const elapsed = Math.max(0, at - tool.startedAt - tool.promptMs - promptMs);
				// The longest-running tool leads; ties keep the oldest (start order).
				if (elapsed > toolMs) toolMs = elapsed;
			}
			return { toolMs, toolCount: current.tools.length };
		};

		const snapshotAt = (current: TimingSpan, at: number): TimingSnapshot => {
			const turn = current.turn;
			const turnReasoningMs = turn ? turnReasoningAt(turn, at) : current.lastTurnReasoningMs;
			const currentOutputTokens = turn ? turnOutputTokens(turn) : 0;
			const currentInputTokens = turn ? turnInputTokens(turn) : 0;
			const currentGenerationMs = turn ? turnDecodeMs(turn, at) : 0;
			const currentStreamedTokens = turn && turn.decodeStartedAt !== undefined && currentGenerationMs > 0
				? currentOutputTokens
				: 0;
			const outputTokens = current.outputTokens + currentOutputTokens;
			return {
				// Human wait is excluded: the span reports autonomous wall time.
				totalMs: Math.max(0, at - current.startedAt - current.humanWaitMs),
				reasoningMs: current.reasoningMs + (turn ? turnReasoningMs : 0),
				turnReasoningMs,
				outputTokens,
				inputTokens: current.inputTokens + currentInputTokens,
				generationMs: current.generationMs + currentGenerationMs,
				streamedOutputTokens: current.streamedOutputTokens + currentStreamedTokens,
				...toolSnapshotAt(current, at),
			};
		};

		// The slow lane samples durations; the stream lane refreshes tokens/rate.
		// Both publish through the same formatter and working-message writer.
		const sampleClock = (current: TimingSpan, at: number): void => {
			const snapshot = snapshotAt(current, at);
			current.clock = {
				totalMs: snapshot.totalMs,
				reasoningMs: snapshot.reasoningMs,
				turnReasoningMs: snapshot.turnReasoningMs,
				toolMs: snapshot.toolMs,
			};
		};

		const paint = (at: number, resampleClock: boolean): void => {
			const current = span;
			if (!current) return;
			if (resampleClock) sampleClock(current, at);
			const snapshot = snapshotAt(current, at);
			const durations = current.clock ?? snapshot;
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
			if (label === current.lastStatus) return;
			current.lastStatus = label;
			current.ctx.ui.setWorkingMessage(label);
		};

		const stopInterval = (): void => {
			if (intervalHandle === undefined) return;
			cancel(intervalHandle);
			intervalHandle = undefined;
		};

		const startInterval = (): void => {
			if (intervalHandle !== undefined) return;
			intervalHandle = schedule(() => {
				const current = span;
				if (!current) return;
				const at = now();
				sampleHumanWait(current, at);
				paint(at, true);
			}, STATUS_UPDATE_INTERVAL_MS);
		};

		/**
		 * Attribute the open prompt's elapsed time. A blocking UI prompt is human wait even when a
		 * native tool is the one awaiting it: the prompt lifecycle is authoritative for who is
		 * blocking, and only related async work makes that interval autonomous. The interval that
		 * just ended is classified with the state that held during it, then that state refreshes.
		 */
		function sampleHumanWait(current: TimingSpan, at: number): void {
			if (current.kind !== "interaction" || current.promptStartedAt === undefined || current.promptSampledAt === undefined) return;
			if (!current.promptBusy) {
				current.humanWaitMs += Math.max(0, at - current.promptSampledAt);
			}
			current.promptSampledAt = at;
			current.promptBusy = relatedExecutionsActive(current);
		}

		const closePrompt = (current: TimingSpan, at: number): void => {
			if (current.promptStartedAt === undefined) return;
			sampleHumanWait(current, at);
			current.promptStartedAt = undefined;
			current.promptSampledAt = undefined;
		};

		const finishTurn = (current: TimingSpan, at: number): void => {
			// Tool and prompt events always precede the turn boundary; close any leftover
			// state so a stale timer can never outlive its turn.
			closePrompt(current, at);
			current.tools.length = 0;
			if (!current.turn) return;
			const reasoningMs = turnReasoningAt(current.turn, at);
			pauseTurnDecode(current.turn, at);
			const outputTokens = turnOutputTokens(current.turn);
			const generationMs = turnDecodeMs(current.turn, at);
			current.reasoningMs += reasoningMs;
			current.lastTurnReasoningMs = reasoningMs;
			current.outputTokens += outputTokens;
			current.inputTokens += turnInputTokens(current.turn);
			current.generationMs += generationMs;
			if (generationMs > 0) current.streamedOutputTokens += outputTokens;
			current.turn = undefined;
		};

		const releaseSpan = (): void => {
			const current = span;
			if (!current) return;
			stopInterval();
			current.stopObserving?.();
			span = undefined;
			current.ctx.ui.setWorkingMessage();
		};

		const finalize = (current: TimingSpan, at: number, status: WorkTimingStatus): void => {
			if (span !== current) return;
			const humanWaitMs = current.humanWaitMs;
			const data: WorkTimingEntryData = {
				version: WORK_TIMING_VERSION,
				totalMs: Math.max(0, at - current.startedAt - humanWaitMs),
				reasoningMs: current.reasoningMs,
				lastTurnReasoningMs: current.lastTurnReasoningMs,
				outputTokens: current.outputTokens,
				inputTokens: current.inputTokens,
				generationMs: current.generationMs,
				streamedOutputTokens: current.streamedOutputTokens,
				scope: "interaction",
				status,
				humanWaitMs,
			};
			releaseSpan();
			pi.appendEntry<WorkTimingEntryData>(WORK_TIMING_ENTRY_TYPE, data);
		};

		/** Close the interaction only on authoritative quiescence; the helper stays passive. */
		const concludeIfQuiet = (current: TimingSpan, at: number): boolean => {
			if (span !== current || current.kind !== "interaction" || current.runActive) return false;
			const quiescence = readExecutionQuiescence(pi, current.ctx, scopeOf(current));
			if (quiescence.state === "busy") return false;
			finalize(current, at, quiescence.state === "quiescent" ? "settled" : "unavailable");
			return true;
		};

		const watchQuiescence = (current: TimingSpan): void => {
			if (current.kind !== "interaction" || current.stopObserving) return;
			current.stopObserving = observeExecutionQuiescence(pi, () => {
				if (span !== current || current.kind !== "interaction") return;
				const at = now();
				sampleHumanWait(current, at);
				concludeIfQuiet(current, at);
			});
		};

		const createSpan = (kind: WorkTimingScope, startedAt: number, ctx: ExtensionContext): TimingSpan => ({
			kind,
			startedAt,
			ctx,
			reasoningMs: 0,
			lastTurnReasoningMs: 0,
			outputTokens: 0,
			inputTokens: 0,
			generationMs: 0,
			streamedOutputTokens: 0,
			humanWaitMs: 0,
			excludedExecutions: new Set(),
			toolCallIds: new Set(),
			executionKeys: new Set(),
			runIds: new Set(),
			turn: undefined,
			tools: [],
			promptStartedAt: undefined,
			promptSampledAt: undefined,
			promptBusy: false,
			clock: undefined,
			runActive: false,
			awaiting: false,
			lastStatus: undefined,
			stopObserving: undefined,
		});

		/**
		 * Pin the work that already exists so an unrelated older job can never be mistaken
		 * for this interaction's work; adopting it later still needs an explicit receipt.
		 */
		const startInteraction = (startedAt: number, ctx: ExtensionContext): TimingSpan => {
			const current = createSpan("interaction", startedAt, ctx);
			const quiescence = readExecutionQuiescence(pi, ctx);
			for (const execution of quiescence.executions) {
				if (execution.phase !== "terminal") current.excludedExecutions.add(execution.key);
			}
			watchQuiescence(current);
			return current;
		};

		/**
		 * An external input during an extension-started run starts a fresh interaction at that
		 * moment. The earlier run's completed metrics are not historical interaction work, and a
		 * mid-turn cut keeps only its post-cut part; ongoing execution attribution and live tool
		 * clocks stay so work the person is now waiting on remains owned by the interaction.
		 */
		const promoteToInteraction = (current: TimingSpan, at: number, ctx: ExtensionContext): TimingSpan => {
			const next = createSpan("interaction", at, ctx);
			for (const toolCallId of current.toolCallIds) next.toolCallIds.add(toolCallId);
			for (const key of current.executionKeys) next.executionKeys.add(key);
			for (const runId of current.runIds) next.runIds.add(runId);
			// The live tool clocks measure the tool itself, not the interaction, so they continue.
			next.tools = current.tools;
			if (current.turn) next.turn = cutTurnAt(current.turn, at);
			// Executions this run already owns stay in scope; unrelated ones are excluded rather than
			// mistaken for the interaction's own work.
			const attributed = (execution: { toolCallId?: string; runId?: string; key: string }): boolean =>
				(execution.toolCallId !== undefined && next.toolCallIds.has(execution.toolCallId))
				|| next.executionKeys.has(execution.key)
				|| (execution.runId !== undefined && next.runIds.has(execution.runId));
			const quiescence = readExecutionQuiescence(pi, ctx);
			for (const execution of quiescence.executions) {
				if (execution.phase !== "terminal" && !attributed(execution)) next.excludedExecutions.add(execution.key);
			}
			next.runActive = true;
			next.awaiting = false;
			watchQuiescence(next);
			return next;
		};

		const teardown = (): void => {
			stopInterval();
			unsubscribeResize?.();
			unsubscribeResize = undefined;
			span?.stopObserving?.();
			span = undefined;
			pendingInteractionStart = undefined;
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
			const at = now();
			if (event.source === "extension") {
				// Every user-message run comes from prompt(), which emits input first, while custom
				// runs never emit input. The most recent input is therefore that run's input: clearing
				// here means an input another handler consumed cannot let a much later automatic run
				// inherit stale human intent. No correlation id exists to bind more tightly.
				pendingInteractionStart = undefined;
				return;
			}
			const current = span;
			if (!current) {
				// The run it starts decides whether an interaction exists; a handled input does not fabricate one.
				pendingInteractionStart = at;
				return;
			}
			if (current.runActive) {
				// Steering or follow-up during the run belongs to the same interaction. An automatic
				// run only becomes an interaction from the moment a person joins it.
				if (current.kind === "run") span = promoteToInteraction(current, at, ctx);
				else current.ctx = ctx;
				return;
			}
			// A human typed while this interaction awaited quiescence: it was cut, not completed.
			finalize(current, at, "interrupted");
			pendingInteractionStart = at;
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!unsubscribeResize) {
				// Display-only refresh: realigns the fold with the new width immediately.
				unsubscribeResize = onResize(() => paint(now(), false));
			}
			const at = now();
			let current = span;
			if (!current) {
				// Only a run started by real external input opens an interaction.
				if (event.messageType === "user" && pendingInteractionStart !== undefined) {
					current = startInteraction(pendingInteractionStart, ctx);
					pendingInteractionStart = undefined;
					span = current;
				} else {
					// Automatic continuation without a human boundary: live timing only, no summary.
					current = createSpan("run", at, ctx);
					span = current;
				}
			} else {
				current.ctx = ctx;
			}
			// A prompt cannot span native runs; normal settlement closes it explicitly.
			if (current.promptStartedAt !== undefined) {
				current.promptStartedAt = undefined;
				current.promptSampledAt = undefined;
			}
			current.runActive = true;
			current.awaiting = false;
			paint(at, true);
			startInterval();
		});

		pi.on("turn_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !span) return;
			finishTurn(span, now());
			span.turn = {
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
			if (ctx.mode !== "tui" || !span?.turn) return;
			const turn = span.turn;
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
			if (ctx.mode !== "tui" || !span?.turn) return;
			if ((event as { message?: { role?: unknown } }).message?.role !== "assistant") return;
			pauseTurnDecode(span.turn, now());
			paint(now(), true);
		});

		const toolNameOf = (event: { toolName?: unknown }): string =>
			typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";

		const removeActiveTool = (event: { toolCallId?: unknown; toolName?: unknown }): void => {
			if (!span) return;
			const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
			const toolName = typeof event.toolName === "string" && event.toolName ? event.toolName : undefined;
			let index = toolCallId === undefined ? -1 : span.tools.findIndex((tool) => tool.toolCallId === toolCallId);
			if (index < 0 && toolName !== undefined) index = span.tools.findIndex((tool) => tool.toolName === toolName);
			if (index >= 0) span.tools.splice(index, 1);
		};

		pi.on("tool_execution_start", (event, ctx) => {
			if (ctx.mode !== "tui" || !span) return;
			const current = span;
			const at = now();
			if (current.promptStartedAt !== undefined) sampleHumanWait(current, at);
			if (current.turn) pauseTurnDecode(current.turn, at);
			const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
			// Raw host ids stay opaque; they only name work that began in this span.
			if (toolCallId) current.toolCallIds.add(toolCallId);
			current.tools.push({
				toolCallId,
				toolName: toolNameOf(event),
				startedAt: at,
				promptMs: 0,
			});
			paint(at, true);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			if (ctx.mode !== "tui" || !span) return;
			const current = span;
			const at = now();
			if (current.promptStartedAt !== undefined) sampleHumanWait(current, at);
			// Keep explicit control/query ownership even in an automatic run: a person may
			// join it later, and promotion must retain work it already adopted.
			const adopted = adoptionFromToolResult((event as { result?: unknown }).result);
			for (const key of adopted.executionKeys) current.executionKeys.add(key);
			for (const runId of adopted.runIds) current.runIds.add(runId);
			removeActiveTool(event);
			paint(at, true);
		});

		pi.on("ui_prompt_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !span) return;
			const current = span;
			const at = now();
			// Coalesced by the host into one outer span; waiting on the user is not tool time.
			current.promptStartedAt ??= at;
			// Only interactions attribute human wait; a run span just freezes its tool clock.
			if (current.kind !== "interaction") return;
			if (current.promptSampledAt === undefined) {
				current.promptSampledAt = at;
				current.promptBusy = relatedExecutionsActive(current);
			}
		});

		pi.on("ui_prompt_end", (_event, ctx) => {
			if (ctx.mode !== "tui" || !span || span.promptStartedAt === undefined) return;
			const current = span;
			const at = now();
			const promptStartedAt = current.promptStartedAt;
			if (promptStartedAt === undefined) return;
			sampleHumanWait(current, at);
			current.promptStartedAt = undefined;
			current.promptSampledAt = undefined;
			const waitedMs = Math.max(0, at - promptStartedAt);
			for (const tool of current.tools) tool.promptMs += waitedMs;
			paint(at, true);
		});

		pi.on("turn_end", (event, ctx) => {
			if (ctx.mode !== "tui" || !span) return;
			if (span.turn) recordTurnOutput(span.turn, {}, event.message);
			finishTurn(span, now());
			paint(now(), true);
		});

		pi.on("agent_settled", (event, ctx) => {
			if (ctx.mode !== "tui" || !span) return;
			const current = span;
			current.ctx = ctx;
			const settledAt = now();
			finishTurn(current, settledAt);
			current.runActive = false;
			current.clock = undefined;
			current.lastStatus = undefined;
			if (current.kind === "run") {
				// No human interaction opened this run, so there is nothing to summarize.
				releaseSpan();
				return;
			}
			if (event.aborted) {
				finalize(current, settledAt, "interrupted");
				return;
			}
			current.awaiting = true;
			// One summary only after the main loop and all work this interaction owns are quiet.
			if (concludeIfQuiet(current, settledAt)) return;
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
