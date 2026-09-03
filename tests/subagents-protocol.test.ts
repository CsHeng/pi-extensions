import assert from "node:assert/strict";
import test from "node:test";
import type { ChildActivity } from "../extensions/subagents/contracts.ts";
import { JsonlProtocolParser } from "../extensions/subagents/protocol.ts";

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
	parser.push(line({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: "secret", isError: false }));
	assert.deepEqual(snapshots.at(-1)?.activeTools, ["read"]);
	parser.push(line({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "secret", isError: false }));
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
