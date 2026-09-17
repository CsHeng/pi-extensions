import assert from "node:assert/strict";
import test from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { createPreparedInputTracker } from "../extensions/shared/prepared-input.ts";
type Message = ContextEvent["messages"][number];
const user = (text = "same", timestamp = 1): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });

test("receipt, rewritten queue and historical context are not new model inputs", () => {
	const tracker = createPreparedInputTracker();
	tracker.received({ source: "interactive", streamingBehavior: "followUp" });
	tracker.received({ source: "interactive", streamingBehavior: "steer" });
	assert.deepEqual(tracker.peek([user("history")]), []);
	const replacement = user("actually delivered");
	tracker.observe(replacement);
	assert.deepEqual(tracker.peek([]), []);
	const prepared = tracker.peek([structuredClone(replacement)]);
	assert.deepEqual(prepared.map((input) => input.provenance), ["unknown"]);
	assert.deepEqual(tracker.peek([replacement]), prepared, "peek never commits on behalf of a failing consumer");
	tracker.commit(prepared.map((input) => input.id));
	assert.deepEqual(tracker.peek([replacement]), [], "retry/tool turn is not a new occurrence");
	tracker.reset();
	assert.deepEqual(tracker.peek([replacement]), [], "recovery does not count history");
});

test("ordinary transformed/image input and known control bind by lifecycle, not raw text", () => {
	for (const source of ["interactive", "rpc", "extension"] as const) {
		const tracker = createPreparedInputTracker();
		tracker.received({ source });
		tracker.prepare();
		const message: Message = { role: "user", content: [{ type: "text", text: "expanded template" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 };
		tracker.observe(message);
		assert.equal(tracker.peek([structuredClone(message)])[0]!.provenance, source === "extension" ? "extension" : "human");
	}
});

test("mixed/concurrent ordinary preparations cannot assign guessed human credit", () => {
	const tracker = createPreparedInputTracker();
	tracker.received({ source: "interactive" });
	tracker.received({ source: "extension" });
	tracker.prepare();
	const first = user();
	tracker.observe(first);
	assert.equal(tracker.peek([first])[0]!.provenance, "unknown");
	tracker.reset();
	tracker.received({ source: "interactive" }); tracker.prepare();
	tracker.received({ source: "extension" }); tracker.prepare();
	const second = user(); tracker.observe(second);
	assert.equal(tracker.peek([second])[0]!.provenance, "unknown");
});

test("identical bodies/timestamps are distinct native occurrences, duplicate event objects are not", () => {
	const tracker = createPreparedInputTracker();
	const first = user(); const second = user();
	tracker.observe(first); tracker.observe(first); tracker.observe(second);
	const prepared = tracker.peek([structuredClone(first), structuredClone(second)]);
	assert.equal(prepared.length, 2);
	assert.notEqual(prepared[0]!.id, prepared[1]!.id);
	tracker.commit([prepared[0]!.id]);
	assert.equal(tracker.peek([first, second]).length, 1);
	tracker.commit([prepared[1]!.id]);
	assert.deepEqual(tracker.peek([first, second]), []);
});

test("custom/tool context never becomes a new user input; overflow is explicit", () => {
	const tracker = createPreparedInputTracker();
	tracker.observe({ role: "custom", customType: "control", content: "reference", display: false, timestamp: 1 });
	assert.deepEqual(tracker.peek([user()]), []);
	for (let index = 0; index < 65; index++) tracker.observe(user(String(index)));
	assert.throws(() => tracker.peek([]), /prepared_input_limit/);
	tracker.reset();
	assert.deepEqual(tracker.peek([]), []);
});
