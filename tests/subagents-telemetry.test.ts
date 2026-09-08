import assert from "node:assert/strict";
import test from "node:test";
import { HARD_LIMITS } from "../extensions/subagents/contracts.ts";
import { createRunClock, isLocalTiming, LocalTimingRecorder } from "../extensions/subagents/telemetry.ts";

test("clock identity is shared only for one source and preserves real zero", () => {
	const source = () => 100;
	const a = createRunClock(source); const b = createRunClock(source); const c = createRunClock(() => 100);
	assert.equal(a.clockKey, b.clockKey); assert.notEqual(a.clockKey, c.clockKey);
	const recorder = new LocalTimingRecorder(source); recorder.start("localTool", "a"); recorder.end("localTool", "a");
	const timing = recorder.finish();
	assert.equal(timing.clockKey, a.clockKey); assert.equal(timing.originMs, 100); assert.equal(timing.complete, true);
	assert.deepEqual(timing.boundary, { startMs: 0, endMs: 0 }); assert.equal(isLocalTiming(timing), true);
});

test("backward, negative, nonfinite and throwing clocks latch unavailable", () => {
	for (const bad of [-1, Number.NaN, Infinity, "throws"] as const) {
		let call = 0;
		const recorder = new LocalTimingRecorder(() => { if (call++ === 0) return 10; if (bad === "throws") throw new Error("clock"); return bad; });
		recorder.start("assistant", "a"); recorder.end("assistant", "a");
		const timing = recorder.finish(); assert.equal(timing.complete, false); assert.equal(timing.originMs, null); assert.equal(timing.boundary.endMs, null);
		assert.equal(isLocalTiming(timing), true);
	}
});

test("missing endpoints, duplicate starts and span overflow never become zero", () => {
	const recorder = new LocalTimingRecorder(() => 0);
	recorder.start("reasoning", "a"); recorder.start("reasoning", "a");
	for (let i = 0; i <= HARD_LIMITS.maxWaitSpans; i++) recorder.start("localTool", String(i));
	const timing = recorder.finish(); assert.equal(timing.complete, false);
	assert.equal(Object.values(timing.spans).flat().length, HARD_LIMITS.maxWaitSpans);
	assert.equal(timing.spans.reasoning[0]!.endMs, null); assert.equal(isLocalTiming(timing), true);
});

test("complete timing rejects spans outside its own clock boundary and unknown payload", () => {
	const recorder = new LocalTimingRecorder(() => 0); recorder.start("assistant", "a"); recorder.end("assistant", "a");
	const timing = recorder.finish(); timing.spans.assistant[0]!.endMs = 1;
	assert.equal(isLocalTiming(timing), false);
	assert.equal(isLocalTiming({ ...recorder.finish(), extra: "private" }), false);
});
