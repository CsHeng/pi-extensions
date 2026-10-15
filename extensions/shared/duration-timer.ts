/** Node collapses a delay above this to 1 ms. Chunk under it; do not pass the raw delay through. */
export const NATIVE_TIMER_MAX_MS = 2_147_483_647;
/** Latest timestamp `Date` can represent. Inclusive; one millisecond later throws. */
export const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export class DurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DurationError";
	}
}

/** The observation budget elapsed. The raced work is left running. */
export class DelayExpired extends Error {
	constructor() {
		super("Delay expired");
		this.name = "DelayExpired";
	}
}

export interface CancellableDelay {
	/** Stop the timer. A cancelled timer does not call its callback. Idempotent. */
	cancel(): void;
}

export interface TimerControls {
	/** Abort cancels the timer and does not call its callback. */
	signal?: AbortSignal;
	schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clear?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Positive finite milliseconds that remain an exact safe integer of at least 1.
 * No product cap. Sub-millisecond values are not a representable timer delay.
 */
export function requireDurationMs(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new DurationError("Invalid duration: must be a finite number of milliseconds greater than 0");
	}
	if (value > Number.MAX_SAFE_INTEGER) {
		throw new DurationError("Invalid duration: exceeds the representable range");
	}
	const ms = Math.trunc(value);
	if (ms < 1) throw new DurationError("Invalid duration: must be at least 1 millisecond");
	return ms;
}

/**
 * Convert seconds to milliseconds. `undefined` selects `fallbackSeconds`.
 * An explicit value is not clamped. NaN, Infinity, and non-positive values are rejected.
 */
export function durationMsFromSeconds(value: number | undefined, fallbackSeconds: number): number {
	const seconds = value === undefined ? fallbackSeconds : value;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
		throw new DurationError("Invalid duration: must be a finite number of seconds greater than 0");
	}
	const ms = seconds * 1000;
	if (!Number.isFinite(ms)) throw new DurationError("Invalid duration: exceeds the representable range");
	return requireDurationMs(ms);
}

/** Absolute timestamp for a duration that must later be rendered as a Date. */
export function timestampAfter(nowMs: number, durationMs: number): number {
	const duration = requireDurationMs(durationMs);
	if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
		throw new DurationError("Invalid duration: exceeds the representable timestamp range");
	}
	const at = nowMs + duration;
	if (!Number.isSafeInteger(at) || at > MAX_DATE_TIMESTAMP_MS) {
		throw new DurationError("Invalid duration: exceeds the representable timestamp range");
	}
	return at;
}

/**
 * Schedule `onFire` after `delayMs`. Delays above {@link NATIVE_TIMER_MAX_MS} are chained
 * cancellable chunks, so Node does not collapse them to 1 ms. Zero is an already-due delay
 * and fires on the next timer turn, not synchronously. A positive user duration should be
 * validated with {@link requireDurationMs} first.
 */
export function scheduleDelay(delayMs: number, onFire: () => void, options: TimerControls = {}): CancellableDelay {
	if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > Number.MAX_SAFE_INTEGER) {
		throw new DurationError("Invalid timer delay: must be a finite millisecond delay from 0 through the representable range");
	}
	const schedule = options.schedule ?? setTimeout;
	const clear = options.clear ?? clearTimeout;
	const signal = options.signal;
	let remaining = Math.trunc(delayMs);
	let handle: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		if (handle !== undefined) clear(handle);
		handle = undefined;
		signal?.removeEventListener("abort", onAbort);
	};
	const onAbort = (): void => { cancel(); };
	const fire = (): void => {
		if (settled) return;
		settled = true;
		handle = undefined;
		signal?.removeEventListener("abort", onAbort);
		onFire();
	};
	const arm = (): void => {
		if (settled) return;
		const chunk = Math.min(remaining, NATIVE_TIMER_MAX_MS);
		handle = schedule(() => {
			handle = undefined;
			if (settled) return;
			remaining -= chunk;
			if (settled) return;
			if (remaining <= 0) fire();
			else arm();
		}, chunk);
	};
	if (signal?.aborted) {
		settled = true;
		return { cancel() {} };
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	arm();
	return { cancel };
}

/**
 * Resolve with `work`, or reject with {@link DelayExpired} when `delayMs` elapses first.
 * Abort rejects with `signal.reason` and cancels the timer. Work settlement also cancels it.
 * Expiry does not abort `work`; a later work result is ignored. Use this for a join budget.
 */
export function raceBudget<T>(work: Promise<T>, delayMs: number, options: TimerControls = {}): Promise<T> {
	const ms = delayMs === 0 ? 0 : requireDurationMs(delayMs);
	return new Promise((resolve, reject) => {
		const signal = options.signal;
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		let settled = false;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			timer.cancel();
			signal?.removeEventListener("abort", onAbort);
			settle();
		};
		const timer = scheduleDelay(ms, () => finish(() => reject(new DelayExpired())), controlsWithoutSignal(options));
		const onAbort = (): void => finish(() => reject(abortReason(signal!)));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		work.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function controlsWithoutSignal(options: TimerControls): TimerControls {
	const next: TimerControls = {};
	if (options.schedule !== undefined) next.schedule = options.schedule;
	if (options.clear !== undefined) next.clear = options.clear;
	return next;
}

function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}
