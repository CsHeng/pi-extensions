import assert from "node:assert/strict";
import test from "node:test";

import { replaySessionState, sessionEntry } from "../extensions/workflow-harness/replay.ts";
import { newSessionState, updateSessionState } from "../extensions/workflow-harness/session-state.ts";

test("replays only valid active-branch state and clones persisted data", () => {
	const initial = newSessionState("request-1", "/work", "2026-08-28T00:00:00.000Z");
	const executing = updateSessionState(initial, { lifecycle: "execute" }, "2026-08-28T00:01:00.000Z");
	const entry = sessionEntry(executing);
	const replayed = replaySessionState([
		{ type: "custom", customType: "foreign", data: initial },
		entry,
	]);
	assert.deepEqual(replayed, executing);
	assert.notEqual(replayed, executing);
});

test("settled state is immutable and unknown state fields are rejected on replay", () => {
	const initial = newSessionState("request-1", "/work");
	const settled = updateSessionState(initial, { lifecycle: "settle", terminalOutcome: "pass", settled: true });
	assert.throws(() => updateSessionState(settled, { lifecycle: "verify" }), /immutable/);
	const entry = sessionEntry(initial);
	assert.throws(() => replaySessionState([{ ...entry, data: { ...initial, extra: true } }]), /replay is blocked/);
});

test("invalid newest owned entry blocks instead of resurrecting earlier state", () => {
	const initial = newSessionState("request-1", "/work");
	assert.throws(() => replaySessionState([sessionEntry(initial), { ...sessionEntry(initial), data: { invalid: true } }]), /replay is blocked/);
	assert.throws(() => replaySessionState([{ ...sessionEntry(initial), data: { ...initial, execution: { ...initial.execution, attempts: [{ malformed: true }] } } }]), /replay is blocked/);
});
