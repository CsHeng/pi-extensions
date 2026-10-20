import assert from "node:assert/strict";
import test from "node:test";
import type { ChildActivity } from "../extensions/agents/contracts.ts";
import { JsonlProtocolParser } from "../extensions/agents/protocol.ts";

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function assistant(stopReason = "stop", text = "done", errorMessage?: string) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, cost: { total: 0.25 } },
			stopReason,
			...(errorMessage === undefined ? {} : { errorMessage }),
		},
	};
}

test("failed response proposals are not active executions; actual starts still fence final completion", () => {
	for (const started of [false, true]) {
		const parser = new JsonlProtocolParser();
		if (started) parser.push(line({ type: "tool_execution_start", toolCallId: "abandoned", toolName: "read" }));
		parser.push(line({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "abandoned", name: "read" }], stopReason: "error", errorMessage: "retryable" } }));
		parser.push(line(assistant()));
		parser.push(line({ type: "agent_settled" }));
		assert.equal(parser.finish().reportComplete, !started);
	}
});

test("redundant large aggregate cannot replace essential final message or framing", () => {
	const aggregate = line({ type: "agent_end", messages: ["x".repeat(2 * 1024 * 1024)] });
	for (const chunkSize of [4096, aggregate.length]) {
		const parser = new JsonlProtocolParser(); parser.push(line(assistant()));
		for (let offset = 0; offset < aggregate.length; offset += chunkSize) parser.push(aggregate.slice(offset, offset + chunkSize));
		parser.push(line({ type: "agent_settled" }));
		assert.equal(parser.finish().reportComplete, true);
	}
	const truncated = new JsonlProtocolParser(); truncated.push(line(assistant())); truncated.push(aggregate.slice(0, -1));
	assert.equal(truncated.finish().reportComplete, false);
	const essential = new JsonlProtocolParser(); essential.push(line(assistant("stop", "x".repeat(2 * 1024 * 1024)))); essential.push(line({ type: "agent_settled" }));
	assert.equal(essential.finish().reportComplete, false);
});

test("fragmented and coalesced events preserve final output and usage", () => {
	const parser = new JsonlProtocolParser();
	const payload = line(assistant());
	parser.push(payload.slice(0, 13));
	parser.push(`${payload.slice(13)}${line({ type: "unknown_future", secret: "do-not-copy" })}`);
	assert.deepEqual(parser.finish(), {
		output: "done",
		usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.25, turns: 1 },
		stopReason: "stop",
		messageCount: 1,
		malformedLines: 0,
		reportComplete: false,
	});
});

test("activity projects lifecycle and overlapping allowed tools only", () => {
	let now = 100;
	const snapshots: Readonly<ChildActivity>[] = [];
	const parser = new JsonlProtocolParser({ now: () => now, allowedTools: ["read", "grep"], onActivity: (value) => snapshots.push(value) });
	parser.push(line({ type: "agent_start" }));
	now = 110;
	parser.push(line({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { secret: "alpha" } }));
	parser.push(line({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { secret: "beta" } }));
	parser.push(line({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { secret: "gamma" } }));
	assert.deepEqual(snapshots.at(-1)?.activeTools, ["read"]);
	parser.push(line({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: "visible", isError: false }));
	assert.deepEqual(snapshots.at(-1)?.activeTools, ["read"]);
	parser.push(line({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "visible", isError: false }));
	assert.deepEqual(snapshots.at(-1)?.activeTools, []);
	parser.push(line({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: "secret", isError: true }));
	assert.equal(snapshots.at(-1)?.phase, "running");
	assert.equal(snapshots.at(-1)?.errorCount, 1);
	now = 150;
	assert.equal(parser.snapshot().elapsedMs, 50);
	assert.equal(parser.snapshot().inactiveForMs, 40);
	assert.doesNotMatch(JSON.stringify(snapshots), /alpha|beta|gamma|secret|bash/);
	assert.equal(Object.isFrozen(snapshots[0]), true);
});

test("call projection keeps distinct executions, redacts secrets, and survives an observer failure", () => {
	let now = 0;
	let thrown = false;
	const parser = new JsonlProtocolParser({
		now: () => now,
		allowedTools: ["bash", "read"],
		onActivity() {
			if (!thrown) { thrown = true; throw new Error("observer down"); }
		},
	});
	now = 20;
	parser.push(line({
		type: "tool_execution_start",
		toolCallId: "bash-1",
		toolName: "bash",
		args: { command: "grep -R / --token alpha", timeout: 5, secret: "alpha" },
	}));
	now = 30;
	parser.push(line({
		type: "tool_execution_start",
		toolCallId: "parent/2",
		toolName: "bash",
		parentToolCallId: "bash-1",
		args: { command: "echo nested", env: { TOKEN: "beta" } },
	}));
	now = 40;
	parser.push(line({
		type: "tool_execution_update",
		toolCallId: "bash-1",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "x".repeat(400) + "TAIL" }], details: { fullOutputPath: "/tmp/secret-path" } },
	}));
	const running = parser.snapshot().calls ?? [];
	const silent = running.find((call) => call.id === "bash-1");
	const nested = running.find((call) => call.id === "parent/2");
	assert.equal(running.filter((call) => call.tool === "bash").length, 2);
	assert.equal(silent?.parentId, undefined);
	assert.equal(silent?.summary, "grep -R / --token [redacted]");
	assert.equal(silent?.deadlineMs, 5_000);
	assert.equal(silent?.status, "running");
	assert.equal(silent?.startedMs, 20);
	assert.equal(silent?.updatedMs, 40);
	assert.equal(silent?.outputMs, 40);
	assert.equal(silent?.truncated, true);
	assert.match(silent?.tail ?? "", /TAIL$/);
	assert.equal(nested?.parentId, "bash-1");
	assert.equal(nested?.deadlineMs, undefined);
	assert.equal(nested?.summary, "echo nested");
	assert.equal(nested?.updatedMs, 30);
	assert.equal(nested?.outputMs, undefined);
	parser.push(line({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/tmp/notes.txt", token: "gamma" } }));
	const read = parser.snapshot().calls?.find((call) => call.id === "read-1");
	assert.equal(read?.summary, "/tmp/notes.txt");
	assert.equal(read?.parentId, undefined);
	assert.equal(read?.deadlineMs, undefined);
	assert.equal(read?.outputMs, undefined);
	now = 45;
	parser.push(line({ type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "   " }] } }));
	const quiet = parser.snapshot().calls?.find((call) => call.id === "bash-1");
	assert.equal(quiet?.updatedMs, 45);
	assert.equal(quiet?.outputMs, 40);
	assert.match(quiet?.tail ?? "", /TAIL$/);
	assert.doesNotMatch(JSON.stringify(parser.snapshot()), /alpha|beta|gamma|secret-path|TOKEN/);
	parser.push(line({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: "ok" }));
	parser.push(line({ type: "tool_execution_end", toolCallId: "parent/2", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "nested done" }] } }));
	parser.push(line({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "failed" }] } }));
	const finished = parser.snapshot().calls ?? [];
	assert.equal(finished.find((call) => call.id === "bash-1")?.status, "failed");
	assert.equal(finished.find((call) => call.id === "parent/2")?.status, "succeeded");
	assert.equal(finished.find((call) => call.id === "parent/2")?.tail, "nested done");
	assert.equal(finished.find((call) => call.id === "parent/2")?.outputMs, finished.find((call) => call.id === "parent/2")?.updatedMs);
	parser.push(line(assistant()) + line({ type: "agent_settled" }));
	assert.equal(parser.finish().reportComplete, true);
	assert.equal(thrown, true);
});

test("unmatched output updates stay optional and cannot grow past the pending-call ceiling", () => {
	const parser = new JsonlProtocolParser({ allowedTools: ["bash"] });
	parser.push(line({ type: "tool_execution_start", toolCallId: "known", toolName: "bash", args: { command: "sleep 1" } }));
	for (let index = 0; index < 1_024; index += 1) {
		parser.push(line({ type: "tool_execution_update", toolCallId: `unknown-${index}`, toolName: "bash", partialResult: { content: [{ type: "text", text: "noise" }] } }));
	}
	parser.push(line({ type: "tool_execution_update", toolCallId: "known", toolName: "bash", partialResult: { content: [{ type: "text", text: "still here" }] } }));
	parser.push(line({ type: "tool_execution_update", toolCallId: "overflow", toolName: "bash", partialResult: { content: [{ type: "text", text: "dropped" }] } }));
	for (let index = 0; index < 1_009; index += 1) {
		parser.push(line({ type: "tool_execution_end", toolCallId: `unknown-${index}`, toolName: "bash", isError: false, result: { content: [{ type: "text", text: "done" }] } }));
	}
	const calls = parser.snapshot().calls ?? [];
	assert.equal(calls.find((call) => call.id === "known")?.tail, "still here");
	assert.equal(calls.some((call) => call.id === "unknown-1023"), false);
	assert.equal(calls.some((call) => call.id === "overflow"), false);
	assert.equal(parser.snapshot().callsTruncated, true);
	parser.push(line({ type: "tool_execution_end", toolCallId: "known", toolName: "bash", isError: false, result: { content: [] } }));
	parser.push(line(assistant()) + line({ type: "agent_settled" }));
	assert.equal(parser.finish().reportComplete, true);
});

test("agent_end is nonfinal while agent_settled is semantic settlement", () => {
	const phases: string[] = [];
	const parser = new JsonlProtocolParser({ onActivity: (value) => phases.push(value.phase) });
	parser.push(line(assistant("error", "ignored", "sensitive provider error")));
	parser.push(line({ type: "agent_end", messages: [{ content: "sensitive" }] }));
	assert.equal(parser.snapshot().phase, "settling");
	assert.equal(parser.snapshot().agentSettledObserved, false);
	parser.push(line({ type: "agent_start" }));
	assert.equal(parser.snapshot().phase, "running");
	assert.equal(parser.snapshot().errorCount, 1);
	parser.push(line({ type: "agent_settled" }));
	assert.equal(parser.snapshot().phase, "settled-awaiting-exit");
	assert.equal(parser.snapshot().agentEndObserved, true);
	assert.equal(parser.snapshot().agentSettledObserved, true);
	assert.equal(parser.snapshot().errorObserved, true);
	assert.doesNotMatch(JSON.stringify(phases), /sensitive/);
});

test("report completeness rejects stale, truncated, oversized and structurally invalid episodes", () => {
	for (const tail of [
		line(assistant("toolUse", "")),
		line({ type: "message_start", message: { role: "assistant" } }),
		line({ type: "message_end", message: { role: "assistant", content: "invalid" } }),
		line({ type: "message_end", message: null }),
		line({ type: "message_start", message: null }),
		line({ type: "message_update", message: {} }),
		line({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "later" } }),
		line({ type: "tool_execution_start", toolCallId: "pending", toolName: "read" }),
		"{broken}\n",
		"x".repeat(1024 * 1024 + 1) + "\n",
	]) {
		const parser = new JsonlProtocolParser();
		parser.push(line(assistant()) + tail + line({ type: "agent_settled" }));
		assert.equal(parser.finish().reportComplete, false);
	}
	const truncated = new JsonlProtocolParser();
	truncated.push(line(assistant()) + JSON.stringify({ type: "agent_settled" }));
	assert.equal(truncated.finish().reportComplete, false);
	const complete = new JsonlProtocolParser();
	complete.push(line(assistant()) + line({ type: "agent_settled" }));
	assert.equal(complete.finish().reportComplete, true);
});

test("quiet native compaction preserves the current answer but open, failed, malformed and retrying maintenance cannot reuse it", () => {
	const start = { type: "compaction_start", reason: "threshold" };
	const end = { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "summary", firstKeptEntryId: "tail", tokensBefore: 100 } };
	const settle = { type: "agent_settled" };
	for (const reason of ["manual", "threshold"]) {
		const parser = new JsonlProtocolParser();
		parser.push([assistant(), { ...start, reason }, { ...end, reason }, settle].map(line).join(""));
		assert.equal(parser.finish().reportComplete, true);
	}
	for (const events of [[start, settle], [start, { ...end, willRetry: true }, settle], [start, { ...end, aborted: true }, settle], [start, { ...end, errorMessage: "failed" }, settle], [start, { ...end, result: {} }, settle], [start, { ...end, errorMessage: {} }, settle], [start, { ...end, errorMessage: null }, settle], [{ ...start, reason: { toString: null } }, end, settle]]) {
		const parser = new JsonlProtocolParser(); parser.push([assistant(), ...events].map(line).join(""));
		assert.equal(parser.finish().reportComplete, false);
	}
	const retried = new JsonlProtocolParser();
	retried.push([assistant("error", "", "overflow"), start, { ...end, willRetry: true }, { type: "agent_start" }, assistant("stop", "current"), settle].map(line).join(""));
	assert.equal(retried.finish().reportComplete, true);
});

test("malformed lines are bounded diagnostics and valid unknown objects refresh liveness", () => {
	let now = 0;
	let calls = 0;
	const parser = new JsonlProtocolParser({ now: () => now, onActivity: () => { calls += 1; } });
	parser.push("{bad}\n");
	now = 25;
	parser.push(line({ type: "PRIVATE-EVENT-TYPE", payload: "private" }));
	assert.equal(calls, 1);
	assert.equal(parser.snapshot().latestEventType, "unknown");
	assert.doesNotMatch(JSON.stringify(parser.snapshot()), /PRIVATE/);
	assert.equal(parser.snapshot().inactiveForMs, 0);
	assert.equal(parser.finish().malformedLines, 1);
});
