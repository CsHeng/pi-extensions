import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	createInteractionBoundary,
	type InteractionClose,
	type InteractionSpan,
	type InteractionStatus,
} from "../shared/interaction-boundary.ts";
import {
	collectLaneTotals,
	emptyLaneTotals,
	formatDuration,
	parseLaneTotals,
	REQUEST_TIMING_ENTRY_TYPE,
	REQUEST_TIMING_VERSION,
	requestLaneTotals,
	timingMetricFields,
	usageMetricFields,
	type AssistantMessageLike,
	type LaneTotals,
	type RequestTimingData,
	type TimingFormatOptions,
} from "../shared/usage-metrics.ts";

export { formatDuration, REQUEST_TIMING_ENTRY_TYPE };

export const WORK_TIMING_ENTRY_TYPE = "work-timing";
const WORK_TIMING_VERSION = 5;
/**
 * Clock cadence. Time fields are re-sampled on this tick, so every duration on the
 * label advances in the same frame; the label is only reposted when it changed.
 */
const STATUS_UPDATE_INTERVAL_MS = 1_000;
const OUTPUT_CHARS_PER_TOKEN = 4;
/** A live tool field appears only after this much work, so quick reads never flash. */
const TOOL_ELAPSED_MIN_MS = 2_000;
/** The tool field's `⚙ ` prefix; the field survives narrow-width compaction. */
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
 * message). Fields keep their order; the elapsed head and a live tool field
 * are always kept; other fields that no longer fit are omitted whole rather
 * than truncated mid-field.
 */
export function compactStatusLabel(status: string, width: number): string {
	if (width <= 0) return status;
	const budget = Math.max(1, width);
	if (visibleWidth(status) <= budget) return status;
	const fields = status.split(" • ");
	const required = new Set<number>();
	const toolIndex = fields.findIndex((field) => field.startsWith(TOOL_FIELD_PREFIX));
	if (toolIndex > 0) required.add(toolIndex);
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

/** A settled interaction reached quiescence; failed, interrupted and unavailable did not. */
export type WorkTimingStatus = InteractionStatus;

export interface WorkTimingEntryData {
	version: typeof WORK_TIMING_VERSION;
	/** Autonomous wall time of the interaction, human wait excluded. */
	totalMs: number;
	/** Pure human wait already excluded from `totalMs`. */
	humanWaitMs: number;
	scope: "interaction";
	status: WorkTimingStatus;
	/** Interaction-lane aggregate of the requests that settled during the interaction. */
	metrics: LaneTotals;
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

/** The main loop's in-flight provider request. */
interface RequestTiming {
	/**
	 * The request has started: `before_provider_request`, or the first assistant stream event on
	 * transports that never expose it. Until then the row keeps the previous request's settled values.
	 */
	begun: boolean;
	/** Main-agent `before_provider_request`; restarts on a provider retry. Drives the live counters. */
	startedAt: number | undefined;
	/** First thinking start or thinking, text or tool-call delta. */
	firstOutputAt: number | undefined;
	completedThinkingMs: number;
	activeThinking: Map<number, number>;
	/** Characters seen in streamed text, thinking, and tool-call deltas. */
	deltaChars: number;
	/** Characters in the current assistant message content, when the host exposes it. */
	messageChars: number;
	/** Output tokens a partial message already reports. */
	providerOutputTokens: number;
}

interface ActiveTool {
	toolCallId: string | undefined;
	toolName: string;
	startedAt: number;
	/** Time spent waiting on extension UI prompts while this tool was active. */
	promptMs: number;
}

/** The slow-lane sample of every duration on the row. */
interface ClockSample {
	totalMs: number;
	toolMs: number;
	thinkingMs: number;
	/** Running TTFT counter while the request waits for its first output. */
	ttftWaitMs: number | undefined;
}

/**
 * Measurements of one span. The shared interaction boundary owns when a span starts and ends
 * (external input through final quiescence, failure or interruption); this extension owns only
 * what it measures inside that span.
 */
interface TimingData {
	/** Session entries before the interaction; later usage-bearing entries are its population. */
	entryStart: number;
	request: RequestTiming | undefined;
	/** The last settled request's values, shown while its tools run. */
	settled: LaneTotals | undefined;
	/** Tools executing right now, in start order. */
	tools: ActiveTool[];
	clock: ClockSample | undefined;
	lastStatus: string | undefined;
}

type TimingSpan = InteractionSpan<TimingData>;

function defaultSetInterval(callback: () => void, intervalMs: number): unknown {
	const handle = globalThis.setInterval(callback, intervalMs);
	handle.unref();
	return handle;
}

function defaultClearInterval(handle: unknown): void {
	globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isOutputSignal(type: unknown): boolean {
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

function usageOutputTokens(source: unknown): number {
	const value = Number((source as { usage?: { output?: unknown } } | undefined)?.usage?.output);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function newRequest(startedAt: number | undefined): RequestTiming {
	return {
		begun: startedAt !== undefined,
		startedAt,
		firstOutputAt: undefined,
		completedThinkingMs: 0,
		activeThinking: new Map(),
		deltaChars: 0,
		messageChars: 0,
		providerOutputTokens: 0,
	};
}

function thinkingAt(request: RequestTiming, at: number): number {
	let total = request.completedThinkingMs;
	for (const startedAt of request.activeThinking.values()) total += Math.max(0, at - startedAt);
	return total;
}

/** In-flight output estimate: provider-reported partial output or characters / 4. */
function estimatedOutputTokens(request: RequestTiming): number {
	const chars = Math.max(request.deltaChars, request.messageChars);
	return Math.max(request.providerOutputTokens, Math.round(chars / OUTPUT_CHARS_PER_TOKEN));
}

/**
 * The persisted timing fact of a settled request. `TTFT` anchors the request start at
 * `message_end − durationMs`, so it shares its start point with Pi's request duration.
 */
function settledTiming(request: RequestTiming, message: AssistantMessageLike, at: number): RequestTimingData | undefined {
	if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return undefined;
	const durationMs = typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs > 0
		? message.durationMs
		: undefined;
	const startedAt = durationMs === undefined ? request.startedAt : at - durationMs;
	const ttftMs = request.firstOutputAt === undefined || startedAt === undefined ? undefined : request.firstOutputAt - startedAt;
	const validTtft = ttftMs !== undefined && ttftMs > 0 && (durationMs === undefined || ttftMs <= durationMs);
	return {
		version: REQUEST_TIMING_VERSION,
		messageTimestamp: message.timestamp,
		...(validTtft ? { ttftMs } : {}),
		thinkingMs: thinkingAt(request, at),
	};
}

function sessionEntries(ctx: ExtensionContext): readonly unknown[] {
	return ctx.sessionManager.getEntries();
}

/** The lane's metric block: usage fields as one field, then each timing field. */
function metricBlock(totals: LaneTotals, options?: TimingFormatOptions): string[] {
	const usage = usageMetricFields(totals).map((field) => field.text).join(" ");
	return [...(usage ? [usage] : []), ...timingMetricFields(totals, options).map((field) => field.text)];
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
		/** Session entries at the latest external input; the interaction it opens starts there. */
		let pendingEntryStart: number | undefined;

		const emptyData = (): TimingData => ({
			entryStart: 0,
			request: undefined,
			settled: undefined,
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
			// Usage-bearing entries that settled during the interaction, re-bills against the whole session.
			const metrics = collectLaneTotals(sessionEntries(current.ctx), {
				models: current.ctx.modelRegistry,
				from: current.data.entryStart,
			});
			pi.appendEntry<WorkTimingEntryData>(WORK_TIMING_ENTRY_TYPE, {
				version: WORK_TIMING_VERSION,
				totalMs,
				humanWaitMs,
				scope: "interaction",
				status,
				metrics,
			});
		};

		const boundary = createInteractionBoundary<TimingData>({
			pi,
			now,
			createData: emptyData,
			/**
			 * A request belongs to the interaction in which it settles, so the in-flight request
			 * and the live tool clocks continue; the interaction's entry population starts now.
			 */
			promoteData: (previous) => ({
				...emptyData(),
				tools: previous.tools,
				request: previous.request,
				settled: previous.settled,
			}),
			onStart: (span) => {
				// The population starts at the external input that opened the interaction, so work Pi does
				// between that input and the run start (such as a pre-run compaction) is included.
				span.data.entryStart = pendingEntryStart ?? sessionEntries(span.ctx).length;
				pendingEntryStart = undefined;
			},
			onClose: finalize,
		});

		const toolSnapshotAt = (current: TimingSpan, at: number): { toolMs: number; toolCount: number } => {
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

		const clockAt = (current: TimingSpan, at: number): ClockSample => {
			const request = current.data.request;
			return {
				// Human wait is excluded: the span reports autonomous wall time.
				totalMs: Math.max(0, at - current.startedAt - current.humanWaitMs),
				toolMs: toolSnapshotAt(current, at).toolMs,
				thinkingMs: request ? thinkingAt(request, at) : 0,
				ttftWaitMs: request?.startedAt !== undefined && request.firstOutputAt === undefined
					? Math.max(0, at - request.startedAt)
					: undefined,
			};
		};

		/** In-flight estimates of the request lane; settlement replaces them. */
		const liveRequest = (request: RequestTiming, durations: ClockSample, at: number): { totals: LaneTotals; ttftLive: boolean } => {
			const totals = emptyLaneTotals();
			totals.output = estimatedOutputTokens(request);
			totals.thinkingMs = durations.thinkingMs;
			let ttftLive = false;
			if (request.startedAt !== undefined) {
				totals.ttftCount = 1;
				if (request.firstOutputAt === undefined) {
					totals.ttftMs = durations.ttftWaitMs ?? Math.max(0, at - request.startedAt);
					ttftLive = true;
				} else {
					totals.ttftMs = Math.max(0, request.firstOutputAt - request.startedAt);
					totals.speedOutput = totals.output;
					totals.speedMs = Math.max(0, at - request.startedAt);
				}
			}
			return { totals, ttftLive };
		};

		// The slow lane samples durations; the stream lane refreshes output and rate.
		// Both publish through the same formatter and working-message writer.
		const paint = (at: number, resampleClock: boolean): void => {
			const current = boundary.current;
			if (!current) return;
			if (resampleClock || !current.data.clock) current.data.clock = clockAt(current, at);
			const durations = current.data.clock;
			const toolCount = current.data.tools.length;
			// Live tool timing: only a long-running tool is worth surfacing, and it
			// vanishes the moment the tool ends.
			const fields = [`Working... ${formatDuration(durations.totalMs)}`];
			if (durations.toolMs >= TOOL_ELAPSED_MIN_MS && toolCount > 0) {
				fields.push(`${TOOL_FIELD_PREFIX}${formatDuration(durations.toolMs)}${toolCount > 1 ? ` +${toolCount - 1}` : ""}`);
			}
			const request = current.data.request;
			if (request?.begun) {
				const live = liveRequest(request, durations, at);
				fields.push(...metricBlock(live.totals, { ttftLive: live.ttftLive }));
			} else if (current.data.settled) {
				fields.push(...metricBlock(current.data.settled));
			}
			// Compact to the host's single-line working row; fields that cannot fit are omitted.
			const label = compactStatusLabel(fields.join(" • "), Math.max(1, columns() - WORKING_ROW_CHROME));
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

		/** Tool and prompt events precede the turn boundary; close any leftover state. */
		const finishTurn = (current: TimingSpan, at: number): void => {
			boundary.closePrompt(at);
			current.data.tools.length = 0;
			current.data.request = undefined;
		};

		const teardown = (): void => {
			stopInterval();
			unsubscribeResize?.();
			unsubscribeResize = undefined;
			pendingEntryStart = undefined;
			boundary.reset();
		};

		pi.registerEntryRenderer<WorkTimingEntryData>(
			WORK_TIMING_ENTRY_TYPE,
			(entry, _options, theme) => {
				const data = (entry.data && typeof entry.data === "object" ? entry.data : {}) as Partial<WorkTimingEntryData>;
				const totalMs = nonNegative(data.totalMs);
				const elapsed = formatDuration(totalMs);
				const head = data.status === "interrupted"
					? `Interrupted after ${elapsed}`
					: data.status === "failed"
						? `Failed after ${elapsed}`
						: data.status === "unavailable"
							? `Timed ${elapsed} (state unavailable)`
							: `Worked for ${elapsed}`;
				const humanWaitMs = nonNegative(data.humanWaitMs);
				const fields = [
					head,
					...(humanWaitMs >= 1_000 ? [`waited ${formatDuration(humanWaitMs)}`] : []),
					...metricBlock(parseLaneTotals(data.metrics), { thinkingShareOfMs: totalMs }),
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
			// Mirrors the boundary's pending start: every input replaces or clears it.
			const external = event.source === "interactive" || event.source === "rpc";
			pendingEntryStart = external ? sessionEntries(ctx).length : undefined;
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
			const at = now();
			finishTurn(current, at);
			// Pi may still process queued messages and prepare the request; the previous request's
			// settled values stay until the next request actually starts.
			current.data.request = newRequest(undefined);
			paint(at, true);
		});

		/** The next request started: the previous request's settled values leave the row. */
		const beginRequest = (current: TimingSpan): void => {
			const request = current.data.request;
			if (!request || request.begun) return;
			request.begun = true;
			current.data.settled = undefined;
		};

		pi.on("message_start", (event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current?.data.request || current.data.request.begun) return;
			if ((event as { message?: { role?: unknown } }).message?.role !== "assistant") return;
			// Transports without a provider-request stage: the stream start marks the request, with no live counters.
			beginRequest(current);
			paint(now(), true);
		});

		pi.on("before_provider_request", (_event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current?.data.request) return;
			// The main request is about to be sent; a retry restarts the live counter.
			const at = now();
			current.data.request = newRequest(at);
			current.data.settled = undefined;
			paint(at, true);
			// Observation only: never replaces the provider payload.
			return undefined;
		});

		pi.on("message_update", (event, ctx) => {
			const current = boundary.current;
			const request = current?.data.request;
			if (ctx.mode !== "tui" || !current || !request) return;
			beginRequest(current);
			const at = now();
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "thinking_start") {
				if (!request.activeThinking.has(assistantEvent.contentIndex)) {
					request.activeThinking.set(assistantEvent.contentIndex, at);
				}
			} else if (assistantEvent.type === "thinking_end") {
				const startedAt = request.activeThinking.get(assistantEvent.contentIndex);
				if (startedAt !== undefined) {
					request.completedThinkingMs += Math.max(0, at - startedAt);
					request.activeThinking.delete(assistantEvent.contentIndex);
				}
			}
			const firstOutput = isOutputSignal(assistantEvent.type) && request.firstOutputAt === undefined;
			if (firstOutput) request.firstOutputAt = at;
			request.deltaChars += streamedOutputChars(assistantEvent);
			request.messageChars = Math.max(request.messageChars, messageOutputChars(event.message));
			request.providerOutputTokens = Math.max(
				request.providerOutputTokens,
				usageOutputTokens(event.message),
				usageOutputTokens((assistantEvent as { partial?: unknown }).partial),
			);
			// The first output fixes the TTFT counter in the same frame.
			paint(at, firstOutput);
		});

		pi.on("message_end", (event, ctx) => {
			const current = boundary.current;
			const message = (event as { message?: AssistantMessageLike }).message;
			if (ctx.mode !== "tui" || !current || message?.role !== "assistant") return;
			const at = now();
			const request = current.data.request;
			// Append before Pi persists the message, so the timing fact exists when usage settles.
			const timing = request ? settledTiming(request, message, at) : undefined;
			if (timing) pi.appendEntry<RequestTimingData>(REQUEST_TIMING_ENTRY_TYPE, timing);
			current.data.settled = requestLaneTotals(sessionEntries(ctx), message, ctx.modelRegistry);
			current.data.request = undefined;
			paint(at, true);
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

		pi.on("turn_end", (_event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			const at = now();
			finishTurn(current, at);
			paint(at, true);
		});

		pi.on("agent_settled", (event, ctx) => {
			const current = boundary.current;
			if (ctx.mode !== "tui" || !current) return;
			const settledAt = now();
			finishTurn(current, settledAt);
			current.data.settled = undefined;
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
