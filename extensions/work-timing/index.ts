import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const WORK_TIMING_ENTRY_TYPE = "work-timing";
const WORK_TIMING_VERSION = 2;
const STATUS_UPDATE_INTERVAL_MS = 250;
const OUTPUT_CHARS_PER_TOKEN = 4;

export interface WorkTimingEntryData {
	version: 1 | 2;
	totalMs: number;
	reasoningMs: number;
	lastTurnReasoningMs: number;
	/** Request-cumulative output tokens; absent on version 1 entries. */
	outputTokens: number;
}

interface WorkTimingDependencies {
	now?: () => number;
	setInterval?: (callback: () => void, intervalMs: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

interface TurnTiming {
	completedReasoningMs: number;
	activeReasoning: Map<number, number>;
	outputChars: number;
	providerOutputTokens: number;
}

interface RequestTiming {
	startedAt: number;
	completedReasoningMs: number;
	lastTurnReasoningMs: number;
	completedOutputTokens: number;
	turn: TurnTiming | undefined;
	ctx: ExtensionContext;
	lastStatus?: string;
}

interface TimingSnapshot {
	totalMs: number;
	reasoningMs: number;
	turnReasoningMs: number;
	outputTokens: number;
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
		return { version: WORK_TIMING_VERSION, totalMs: 0, reasoningMs: 0, lastTurnReasoningMs: 0, outputTokens: 0 };
	}
	const candidate = data as Partial<WorkTimingEntryData>;
	return {
		version: WORK_TIMING_VERSION,
		totalMs: validDuration(candidate.totalMs),
		reasoningMs: validDuration(candidate.reasoningMs),
		lastTurnReasoningMs: validDuration(candidate.lastTurnReasoningMs),
		outputTokens: validDuration(candidate.outputTokens),
	};
}

function turnOutputTokens(turn: TurnTiming): number {
	return Math.max(turn.providerOutputTokens, Math.round(turn.outputChars / OUTPUT_CHARS_PER_TOKEN));
}

function usageOutputTokens(event: unknown): number {
	const usage = (event as { partial?: { usage?: { output?: unknown } } } | undefined)?.partial?.usage;
	const output = Number(usage?.output);
	return Number.isFinite(output) && output > 0 ? Math.round(output) : 0;
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
			const turnReasoningMs = request.turn
				? turnReasoningAt(request.turn, at)
				: request.lastTurnReasoningMs;
			return {
				totalMs: Math.max(0, at - request.startedAt),
				reasoningMs:
					request.completedReasoningMs +
					(request.turn ? turnReasoningMs : 0),
				turnReasoningMs,
				outputTokens:
					request.completedOutputTokens +
					(request.turn ? turnOutputTokens(request.turn) : 0),
			};
		};

		const updateWorkingMessage = (): void => {
			if (!request) return;
			const snapshot = snapshotAt(now());
			if (!snapshot) return;
			const status =
				`Working... R ${formatDuration(snapshot.turnReasoningMs)}` +
				` / ΣR ${formatDuration(snapshot.reasoningMs)}` +
				` • total ${formatDuration(snapshot.totalMs)}` +
				(snapshot.outputTokens > 0 ? ` • ↓ ${formatTokens(snapshot.outputTokens)} tokens` : "");
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
			intervalHandle = schedule(updateWorkingMessage, STATUS_UPDATE_INTERVAL_MS);
		};

		const finishTurn = (at: number): void => {
			if (!request?.turn) return;
			const reasoningMs = turnReasoningAt(request.turn, at);
			request.completedReasoningMs += reasoningMs;
			request.lastTurnReasoningMs = reasoningMs;
			request.completedOutputTokens += turnOutputTokens(request.turn);
			request.turn = undefined;
		};

		pi.registerEntryRenderer<WorkTimingEntryData>(
			WORK_TIMING_ENTRY_TYPE,
			(entry, { expanded }, theme) => {
				const data = normalizeEntryData(entry.data);
				const share = formatReasoningShare(data.reasoningMs, data.totalMs);
				let text = theme.fg(
					"muted",
					`Worked for ${formatDuration(data.totalMs)} • reasoning ${formatDuration(data.reasoningMs)} (${share})` +
					(data.outputTokens > 0 ? ` • ↓ ${formatTokens(data.outputTokens)} tokens` : ""),
				);
				if (expanded) {
					text += theme.fg("dim", ` • last turn ${formatDuration(data.lastTurnReasoningMs)}`);
				}
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
					turn: undefined,
					ctx,
				};
			}
			updateWorkingMessage();
			startInterval();
		});

		pi.on("turn_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !request) return;
			finishTurn(now());
			request.turn = {
				completedReasoningMs: 0,
				activeReasoning: new Map(),
				outputChars: 0,
				providerOutputTokens: 0,
			};
			updateWorkingMessage();
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
			} else if (assistantEvent.type === "thinking_delta" || assistantEvent.type === "text_delta") {
				request.turn.outputChars += typeof assistantEvent.delta === "string" ? assistantEvent.delta.length : 0;
			}
			const providerTokens = usageOutputTokens(assistantEvent);
			if (providerTokens > request.turn.providerOutputTokens) {
				request.turn.providerOutputTokens = providerTokens;
			}
			updateWorkingMessage();
		});

		pi.on("turn_end", (_event, ctx) => {
			if (ctx.mode !== "tui" || !request) return;
			finishTurn(now());
			updateWorkingMessage();
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (ctx.mode !== "tui" || !request) return;
			const settledAt = now();
			finishTurn(settledAt);
			const snapshot = snapshotAt(settledAt);
			stopInterval();
			ctx.ui.setWorkingMessage();
			request = undefined;
			if (!snapshot) return;
			pi.appendEntry<WorkTimingEntryData>(WORK_TIMING_ENTRY_TYPE, {
				version: WORK_TIMING_VERSION,
				totalMs: snapshot.totalMs,
				reasoningMs: snapshot.reasoningMs,
				lastTurnReasoningMs: snapshot.turnReasoningMs,
				outputTokens: snapshot.outputTokens,
			});
		});

		pi.on("session_shutdown", () => {
			stopInterval();
			request = undefined;
		});
	};
}

export default createWorkTimingExtension();
