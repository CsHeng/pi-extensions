import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionRequest, SUBAGENT_SESSION_TOOL_NAME } from "../extensions/subagents/session-contracts.ts";

test("managed actions have strict disjoint fields and bounded opaque identities", () => {
	assert.equal(SUBAGENT_SESSION_TOOL_NAME, "csheng_subagent_sessions");
	assert.deepEqual(parseSessionRequest({ action: "inspect" }), { action: "inspect" });
	assert.equal(parseSessionRequest({ action: "close", handle: "h", expectedEpisode: 1 }).disposition, undefined);
	assert.throws(() => parseSessionRequest({ action: "create" }), /missing_create/);
	assert.throws(() => parseSessionRequest({ action: "inspect", tasks: [] }));
	assert.throws(() => parseSessionRequest({ action: "inspect", handle: "../native.jsonl" }));
	assert.throws(() => parseSessionRequest({ action: "apply", handle: "h", expectedEpisode: 1 }), /missing_candidate/);
	assert.throws(() => parseSessionRequest({ action: "close", handle: "h", expectedEpisode: 1, arbitraryPermission: true }));
	const episode = { handle: "h", requestId: "req", expectedEpisode: 1, message: "continue" };
	assert.throws(() => parseSessionRequest({ action: "continue", episodes: [episode, episode] }), /invalid_episodes/);
	assert.throws(() => parseSessionRequest({ action: "continue", episodes: [{ ...episode, message: "汉".repeat(30_000) }] }), /message_too_large/);
	assert.equal(parseSessionRequest({ action: "continue", episodes: [episode] }).episodes?.length, 1);
	for (const objective of ["x".repeat(20_000), "汉".repeat(10_000)]) {
		assert.throws(() => parseSessionRequest({ action: "create", requestId: "r", tasks: [{ id: "a", role: "explorer", scope: ["."], objective }] }));
	}
	assert.throws(() => parseSessionRequest({ action: "create", requestId: "r", tasks: [{ id: "a", role: "explorer", scope: ["."], objective: "work", inputs: ["汉".repeat(40_000)] }] }));
});
