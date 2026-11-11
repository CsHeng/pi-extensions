/**
 * Observation windows yield the main loop.
 *
 * A foreground tool call that holds the turn delays every other event until it returns: a user's
 * steering message enters only after the turn's tool calls finish, and busy result delivery happens
 * at `turn_end`. An open window therefore releases early when either is waiting. Each extension runs
 * its own instance from its own host events; the window owner decides what to return.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTICE_DELIVERY_CHANGED, NOTICE_DELIVERY_REQUEST, type NoticeDeliveryRequest, type NoticeDeliverySnapshot, type ExecutionRef } from "./execution-facts.ts";

/** `steer`: the user is inserting a message into this run. `result`: another notice is ready to deliver. */
export type YieldReason = "steer" | "result";

export interface YieldWindow {
	/** Aborts once the main loop should regain control. */
	readonly signal: AbortSignal;
	readonly reason: YieldReason | undefined;
	close(): void;
}

export interface MainLoopYield {
	/**
	 * Open one observation window. `ignore` excludes notices that belong to the observed work itself,
	 * which reach the model through this same tool result.
	 */
	open(options?: { ignore?: (ref: ExecutionRef) => boolean }): YieldWindow;
}

/** Follow-up input waits for the run to finish by the user's choice; only steering interrupts a window. */
export function isSteeringInput(event: { source?: string; streamingBehavior?: string }): boolean {
	return event.streamingBehavior === "steer" && (event.source === "interactive" || event.source === "rpc");
}

/** Pending notices that would reach the model at the next turn boundary, or none when delivery is blocked or absent. */
export function readyNotices(pi: ExtensionAPI): ExecutionRef[] {
	let snapshot: NoticeDeliverySnapshot | undefined;
	try {
		pi.events.emit(NOTICE_DELIVERY_REQUEST, { version: 1, accept: (value: NoticeDeliverySnapshot) => { if (value?.version === 1) snapshot = value; } } satisfies NoticeDeliveryRequest);
	} catch { return []; }
	if (!snapshot || snapshot.blocked || !Array.isArray(snapshot.pending)) return [];
	return snapshot.pending;
}

export function createMainLoopYield(pi: ExtensionAPI): MainLoopYield {
	interface OpenWindow { controller: AbortController; reason: YieldReason | undefined; ignore: (ref: ExecutionRef) => boolean }
	const windows = new Set<OpenWindow>();
	// Steering queued in this run reaches the model after the turn's tool calls; a window opened
	// after it was typed must release at once.
	let steerQueued = false;
	let checkQueued = false;

	const release = (window: OpenWindow, reason: YieldReason): void => {
		if (window.controller.signal.aborted) return;
		window.reason = reason;
		window.controller.abort();
		windows.delete(window);
	};
	const checkResults = (only?: OpenWindow): void => {
		const targets = only ? [only] : [...windows];
		if (targets.length === 0) return;
		const ready = readyNotices(pi);
		if (ready.length === 0) return;
		for (const window of targets) if (ready.some(ref => !window.ignore(ref))) release(window, "result");
	};
	const scheduleCheck = (): void => {
		if (checkQueued || windows.size === 0) return;
		checkQueued = true;
		queueMicrotask(() => { checkQueued = false; try { checkResults(); } catch { /* Observation cannot fail the window owner. */ } });
	};

	pi.on("input", (event) => {
		if (!isSteeringInput(event)) return;
		steerQueued = true;
		for (const window of [...windows]) release(window, "steer");
	});
	// The next turn begins after queued steering has entered the conversation.
	pi.on("turn_start", () => { steerQueued = false; });
	pi.on("agent_end", () => { steerQueued = false; });
	pi.on("session_shutdown", () => { steerQueued = false; for (const window of [...windows]) release(window, "steer"); });
	pi.events.on(NOTICE_DELIVERY_CHANGED, scheduleCheck);

	return {
		open(options) {
			const window: OpenWindow = { controller: new AbortController(), reason: undefined, ignore: options?.ignore ?? (() => false) };
			windows.add(window);
			if (steerQueued) release(window, "steer");
			else { try { checkResults(window); } catch { /* Observation cannot fail the window owner. */ } }
			return {
				signal: window.controller.signal,
				get reason() { return window.reason; },
				close() { windows.delete(window); },
			};
		},
	};
}

/** One model-facing sentence for a window that returned early. */
export function yieldNote(reason: YieldReason | undefined): string | undefined {
	if (reason === "steer") return "This call returned early because a user message is waiting; the execution continues.";
	if (reason === "result") return "This call returned early because another execution notice is ready; the execution continues.";
	return undefined;
}
