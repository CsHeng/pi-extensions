import assert from "node:assert/strict";
import test from "node:test";

import {
	DelayExpired,
	DurationError,
	MAX_DATE_TIMESTAMP_MS,
	NATIVE_TIMER_MAX_MS,
	durationMsFromSeconds,
	raceBudget,
	requireDurationMs,
	scheduleDelay,
	timestampAfter,
} from "../extensions/shared/duration-timer.ts";

test("duration validation keeps positive finite representable values and applies no product cap", () => {
	assert.equal(durationMsFromSeconds(undefined, 180), 180_000);
	assert.equal(durationMsFromSeconds(1800, 180), 1_800_000);
	assert.equal(durationMsFromSeconds(2_147_484, 180), 2_147_484_000);
	assert.equal(requireDurationMs(1.9), 1);
	assert.equal(timestampAfter(1_000, NATIVE_TIMER_MAX_MS + 1), 1_000 + NATIVE_TIMER_MAX_MS + 1);
	assert.throws(() => durationMsFromSeconds(Number.NaN, 180), DurationError);
	assert.throws(() => durationMsFromSeconds(Number.POSITIVE_INFINITY, 180), DurationError);
	assert.throws(() => durationMsFromSeconds(0, 180), DurationError);
	assert.throws(() => durationMsFromSeconds(-5, 180), DurationError);
	assert.throws(() => durationMsFromSeconds(1e20, 180), DurationError);
	assert.throws(() => requireDurationMs(0.4), /at least 1 millisecond/);
	assert.throws(() => timestampAfter(MAX_DATE_TIMESTAMP_MS, 1), /representable timestamp range/);
});

test("delays above the native timer ceiling are cancellable chunks and do not fire immediately", async () => {
	const pending = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
	const schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
		const handle = { delayMs } as unknown as ReturnType<typeof setTimeout>;
		pending.set(handle, { callback, delay: delayMs });
		return handle;
	};
	const clear = (handle: ReturnType<typeof setTimeout>): void => { pending.delete(handle); };
	let fired = 0;
	const timer = scheduleDelay(NATIVE_TIMER_MAX_MS + 5, () => { fired += 1; }, { schedule, clear });
	assert.equal(pending.size, 1);
	assert.equal([...pending.values()][0]?.delay, NATIVE_TIMER_MAX_MS);
	const first = [...pending.entries()][0]!;
	pending.delete(first[0]);
	first[1].callback();
	assert.equal(fired, 0);
	assert.equal([...pending.values()][0]?.delay, 5);
	timer.cancel();
	const second = [...pending.values()][0];
	assert.equal(second, undefined);
	assert.equal(fired, 0);

	let collapsed = false;
	const real = scheduleDelay(NATIVE_TIMER_MAX_MS + 1_000, () => { collapsed = true; });
	try {
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(collapsed, false);
	} finally {
		real.cancel();
	}
});

test("abort cancels a chunked timer and raceBudget distinguishes expiry from completion", async () => {
	const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
	const schedule = (callback: () => void, _delayMs: number): ReturnType<typeof setTimeout> => {
		const handle = {} as unknown as ReturnType<typeof setTimeout>;
		pending.set(handle, callback);
		return handle;
	};
	const clear = (handle: ReturnType<typeof setTimeout>): void => { pending.delete(handle); };
	const controls = { schedule, clear };
	const controller = new AbortController();
	let fired = false;
	const timer = scheduleDelay(5_000, () => { fired = true; }, { ...controls, signal: controller.signal });
	controller.abort();
	assert.equal(pending.size, 0);
	assert.equal(fired, false);
	timer.cancel();

	const completed = await raceBudget(Promise.resolve("done"), 5_000, controls);
	assert.equal(completed, "done");
	assert.equal(pending.size, 0);

	let expiredWorkSettled = false;
	const pendingWork = new Promise<string>((resolve) => {
		setTimeout(() => { expiredWorkSettled = true; resolve("late"); }, 0);
	});
	const expiry = raceBudget(pendingWork, 20, controls);
	const callback = [...pending.values()][0];
	assert.ok(callback);
	callback();
	await assert.rejects(expiry, DelayExpired);
	await pendingWork;
	assert.equal(expiredWorkSettled, true);

	const abortController = new AbortController();
	const aborted = raceBudget(new Promise(() => {}), 5_000, { ...controls, signal: abortController.signal });
	abortController.abort();
	await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
