import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	executionKey,
	observeExecutionQuiescence,
	readExecutionQuiescence,
	type ExecutionScope,
} from "./execution-quiescence.ts";

/** One external interaction, or a run no human input started (measured live, never summarized). */
export type InteractionKind = "interaction" | "run";
/**
 * How an interaction ended. `settled` reached quiescence; `failed` ended on a main-run error,
 * after which no automatic continuation can resume it; `interrupted` was cut by abort or new
 * external input; `unavailable` could not verify quiescence.
 */
export type InteractionStatus = "settled" | "failed" | "interrupted" | "unavailable";

export interface InteractionSpan<T> {
	kind: InteractionKind;
	startedAt: number;
	ctx: ExtensionContext;
	/** Caller-owned measurements; the boundary never reads them. */
	data: T;
	/** Pure human wait excluded from the autonomous span; interactions only. */
	humanWaitMs: number;
	/** Executions already present when the interaction started; never inferred as its work. */
	excludedExecutions: Set<string>;
	/** Native tool calls started in this span, kept as the raw opaque ids the host gave. */
	toolCallIds: Set<string>;
	/** Producer executions explicitly adopted by a control or query receipt. */
	executionKeys: Set<string>;
	/** Native Agent runs explicitly adopted by a control or query receipt. */
	runIds: Set<string>;
	/** Start of the open extension UI prompt span, when the user is being asked. */
	promptStartedAt: number | undefined;
	/** When the open prompt's human wait was last attributed. */
	promptSampledAt: number | undefined;
	/** Whether related executions were progressing at the last prompt sample. */
	promptBusy: boolean;
	/** The host accepted a main run and has not settled it yet. */
	runActive: boolean;
	/** A main run settled inside this interaction; owned work may still be running. */
	awaiting: boolean;
	stopObserving: (() => void) | undefined;
}

export interface InteractionClose<T> {
	span: InteractionSpan<T>;
	at: number;
	status: InteractionStatus;
	/** Main-agent wall time from the external input to the end, minus pure human wait. */
	totalMs: number;
	humanWaitMs: number;
}

export interface InteractionBoundaryOptions<T> {
	pi: ExtensionAPI;
	now: () => number;
	createData: (kind: InteractionKind, at: number) => T;
	/** External input joined an extension-started run; derive the interaction's data from the cut. */
	promoteData: (previous: T, at: number) => T;
	/** A new interaction began, from a started run or a promoted one. */
	onStart?: (span: InteractionSpan<T>) => void;
	/** Called once per interaction; the span is already released. */
	onClose: (close: InteractionClose<T>) => void;
}

export type SettleOutcome = "none" | "released" | "closed" | "awaiting";

/** Whether the latest assistant message on the branch ended with a provider/runtime error. */
export function latestAssistantFailed(ctx: ExtensionContext): boolean {
	try {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index]!;
			if (entry.type === "message" && entry.message.role === "assistant") return entry.message.stopReason === "error";
		}
	} catch { /* An unreadable branch is not evidence of failure. */ }
	return false;
}

/**
 * Producer receipts from a control or query call adopt work that started earlier.
 * Creation receipts already carry the originating tool call, so this only needs the
 * public execution/run identities a late inspect, wait, join or cancel returns.
 */
export function adoptionFromToolResult(result: unknown): { executionKeys: string[]; runIds: string[] } {
	const details = (result as { details?: unknown } | undefined)?.details;
	if (!details || typeof details !== "object") return { executionKeys: [], runIds: [] };
	const record = details as { executionId?: unknown; runId?: unknown };
	return {
		executionKeys: typeof record.executionId === "string" && record.executionId
			? [executionKey("async-bash", record.executionId)]
			: [],
		runIds: typeof record.runId === "string" && record.runId ? [record.runId] : [],
	};
}

/**
 * The shared algorithm for when one external interaction ends: the moment a person needs to
 * look again. Each extension owns its own instance and drives it from its own host handlers,
 * so ordering against its measurements stays local and no extension depends on another's state.
 * Quiescence is read passively from neutral facts; the boundary never schedules work.
 */
export function createInteractionBoundary<T>(options: InteractionBoundaryOptions<T>) {
	const { pi, now } = options;
	let span: InteractionSpan<T> | undefined;
	/**
	 * A real external input has arrived, but its main run has not started yet. Every input
	 * event replaces or clears it, and only the user run that follows that input can consume
	 * it, so a handled input cannot be inherited by a later automatic run.
	 */
	let pendingInteractionStart: number | undefined;

	const scopeOf = (current: InteractionSpan<T>): ExecutionScope => ({
		toolCallIds: current.toolCallIds,
		...(current.executionKeys.size > 0 ? { executionKeys: current.executionKeys } : {}),
		...(current.runIds.size > 0 ? { runIds: current.runIds } : {}),
		...(current.excludedExecutions.size > 0 ? { excludedExecutions: current.excludedExecutions } : {}),
	});

	/** Whether related async work is progressing; unavailable state counts as work, not human wait. */
	const relatedExecutionsActive = (current: InteractionSpan<T>): boolean => {
		const quiescence = readExecutionQuiescence(pi, current.ctx, scopeOf(current));
		return quiescence.state === "unavailable" || quiescence.activeExecutions > 0;
	};

	/**
	 * Attribute the open prompt's elapsed time. A blocking UI prompt is human wait even when a
	 * native tool is the one awaiting it: the prompt lifecycle is authoritative for who is
	 * blocking, and only related async work makes that interval autonomous. The interval that
	 * just ended is classified with the state that held during it, then that state refreshes.
	 */
	const sampleHumanWait = (current: InteractionSpan<T>, at: number): void => {
		if (current.kind !== "interaction" || current.promptStartedAt === undefined || current.promptSampledAt === undefined) return;
		if (!current.promptBusy) current.humanWaitMs += Math.max(0, at - current.promptSampledAt);
		current.promptSampledAt = at;
		current.promptBusy = relatedExecutionsActive(current);
	};

	const closePromptOf = (current: InteractionSpan<T>, at: number): void => {
		if (current.promptStartedAt === undefined) return;
		sampleHumanWait(current, at);
		current.promptStartedAt = undefined;
		current.promptSampledAt = undefined;
	};

	const release = (current: InteractionSpan<T>): void => {
		current.stopObserving?.();
		current.stopObserving = undefined;
		if (span === current) span = undefined;
	};

	const close = (current: InteractionSpan<T>, at: number, status: InteractionStatus): void => {
		if (span !== current) return;
		release(current);
		const humanWaitMs = current.humanWaitMs;
		options.onClose({ span: current, at, status, humanWaitMs, totalMs: Math.max(0, at - current.startedAt - humanWaitMs) });
	};

	/** Close the interaction only on authoritative quiescence; the helper stays passive. */
	const concludeIfQuiet = (current: InteractionSpan<T>, at: number): boolean => {
		if (span !== current || current.kind !== "interaction" || current.runActive) return false;
		const quiescence = readExecutionQuiescence(pi, current.ctx, scopeOf(current));
		if (quiescence.state === "busy") return false;
		close(current, at, quiescence.state === "quiescent" ? "settled" : "unavailable");
		return true;
	};

	const watchQuiescence = (current: InteractionSpan<T>): void => {
		if (current.kind !== "interaction" || current.stopObserving) return;
		current.stopObserving = observeExecutionQuiescence(pi, () => {
			if (span !== current || current.kind !== "interaction") return;
			const at = now();
			sampleHumanWait(current, at);
			concludeIfQuiet(current, at);
		});
	};

	const createSpan = (kind: InteractionKind, startedAt: number, ctx: ExtensionContext, data: T): InteractionSpan<T> => ({
		kind, startedAt, ctx, data,
		humanWaitMs: 0,
		excludedExecutions: new Set(),
		toolCallIds: new Set(),
		executionKeys: new Set(),
		runIds: new Set(),
		promptStartedAt: undefined,
		promptSampledAt: undefined,
		promptBusy: false,
		runActive: false,
		awaiting: false,
		stopObserving: undefined,
	});

	/**
	 * Pin the work that already exists so an unrelated older job can never be mistaken
	 * for this interaction's work; adopting it later still needs an explicit receipt.
	 */
	const startInteraction = (startedAt: number, ctx: ExtensionContext): InteractionSpan<T> => {
		const current = createSpan("interaction", startedAt, ctx, options.createData("interaction", startedAt));
		const quiescence = readExecutionQuiescence(pi, ctx);
		for (const execution of quiescence.executions) {
			if (execution.phase !== "terminal") current.excludedExecutions.add(execution.key);
		}
		watchQuiescence(current);
		return current;
	};

	/**
	 * An external input during an extension-started run starts a fresh interaction at that
	 * moment. Ongoing execution attribution stays, so work the person is now waiting on remains
	 * owned by the interaction; the caller decides which of its measurements survive the cut.
	 */
	const promoteToInteraction = (current: InteractionSpan<T>, at: number, ctx: ExtensionContext): InteractionSpan<T> => {
		const next = createSpan("interaction", at, ctx, options.promoteData(current.data, at));
		for (const toolCallId of current.toolCallIds) next.toolCallIds.add(toolCallId);
		for (const key of current.executionKeys) next.executionKeys.add(key);
		for (const runId of current.runIds) next.runIds.add(runId);
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
		watchQuiescence(next);
		return next;
	};

	return {
		get current(): InteractionSpan<T> | undefined { return span; },

		/** Host `input`; only interactive and RPC sources are external. */
		input(source: string, ctx: ExtensionContext, at: number): void {
			if (source !== "interactive" && source !== "rpc") {
				// Every user-message run comes from prompt(), which emits input first, while custom
				// runs never emit input. Clearing here means an input another handler consumed
				// cannot let a much later automatic run inherit stale human intent.
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
				if (current.kind === "run") {
					release(current);
					span = promoteToInteraction(current, at, ctx);
					options.onStart?.(span);
				} else current.ctx = ctx;
				return;
			}
			// A human typed while this interaction awaited quiescence: it was cut, not completed.
			close(current, at, "interrupted");
			pendingInteractionStart = at;
		},

		/** Host `before_agent_start`; returns the span this main run belongs to. */
		beforeAgentStart(messageType: unknown, ctx: ExtensionContext, at: number): InteractionSpan<T> {
			let current = span;
			if (!current) {
				// Only a run started by real external input opens an interaction.
				if (messageType === "user" && pendingInteractionStart !== undefined) {
					current = startInteraction(pendingInteractionStart, ctx);
					pendingInteractionStart = undefined;
					span = current;
					options.onStart?.(current);
				} else {
					// Automatic continuation without a human boundary: live only, never summarized.
					current = createSpan("run", at, ctx, options.createData("run", at));
					span = current;
				}
			} else {
				current.ctx = ctx;
			}
			// A prompt cannot span main runs; normal settlement closes it explicitly.
			current.promptStartedAt = undefined;
			current.promptSampledAt = undefined;
			current.runActive = true;
			current.awaiting = false;
			return current;
		},

		toolStart(toolCallId: unknown, at: number): void {
			const current = span;
			if (!current) return;
			if (current.promptStartedAt !== undefined) sampleHumanWait(current, at);
			// Raw host ids stay opaque; they only name work that began in this span.
			if (typeof toolCallId === "string" && toolCallId) current.toolCallIds.add(toolCallId);
		},

		toolEnd(result: unknown, at: number): void {
			const current = span;
			if (!current) return;
			if (current.promptStartedAt !== undefined) sampleHumanWait(current, at);
			// Keep explicit control/query ownership even in an automatic run: a person may
			// join it later, and promotion must retain work it already adopted.
			const adopted = adoptionFromToolResult(result);
			for (const key of adopted.executionKeys) current.executionKeys.add(key);
			for (const runId of adopted.runIds) current.runIds.add(runId);
		},

		promptStart(at: number): void {
			const current = span;
			if (!current) return;
			// Coalesced by the host into one outer span.
			current.promptStartedAt ??= at;
			// Only interactions attribute human wait.
			if (current.kind !== "interaction" || current.promptSampledAt !== undefined) return;
			current.promptSampledAt = at;
			current.promptBusy = relatedExecutionsActive(current);
		},

		/** Returns the prompt's wall duration, or undefined when no prompt was open. */
		promptEnd(at: number): number | undefined {
			const current = span;
			const startedAt = current?.promptStartedAt;
			if (!current || startedAt === undefined) return undefined;
			closePromptOf(current, at);
			return Math.max(0, at - startedAt);
		},

		/** Refresh the open prompt's attribution, for example on a periodic clock tick. */
		samplePrompt(at: number): void {
			if (span) sampleHumanWait(span, at);
		},

		/** Tool and prompt events precede the turn boundary; close any leftover prompt state. */
		closePrompt(at: number): void {
			if (span) closePromptOf(span, at);
		},

		/** Host `agent_settled`, after the caller folded its own run measurements. */
		settled(aborted: boolean, ctx: ExtensionContext, at: number): SettleOutcome {
			const current = span;
			if (!current) return "none";
			current.ctx = ctx;
			closePromptOf(current, at);
			current.runActive = false;
			if (current.kind === "run") {
				release(current);
				return "released";
			}
			if (aborted) {
				close(current, at, "interrupted");
				return "closed";
			}
			// A main-run error stops automatic continuation; owned jobs cannot resume the loop.
			if (latestAssistantFailed(ctx)) {
				close(current, at, "failed");
				return "closed";
			}
			current.awaiting = true;
			// One end only after the main loop and all work this interaction owns are quiet.
			return concludeIfQuiet(current, at) ? "closed" : "awaiting";
		},

		/** Session or branch boundary: drop the span without reporting it into the next scope. */
		reset(): void {
			if (span) release(span);
			span = undefined;
			pendingInteractionStart = undefined;
		},
	};
}

export type InteractionBoundary<T> = ReturnType<typeof createInteractionBoundary<T>>;
