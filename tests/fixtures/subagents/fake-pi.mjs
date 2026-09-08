#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "normal";
const args = process.argv.slice(2);
const capture = process.env.FAKE_PI_CAPTURE;
const sessionIndex = args.indexOf("--session");
const sessionPath = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
if (capture) {
	writeFileSync(capture, JSON.stringify({
		args,
		child: process.env.CSHENG_SUBAGENT_CHILD,
		capability: process.env.CSHENG_SUBAGENT_CAPABILITY,
		removedParentMarker: process.env.CSHENG_SUBAGENT_TEST_MODE,
		sessionPath,
	}));
}

const message = {
	role: "assistant",
	content: [{ type: "text", text: mode === "large" ? "x".repeat(60 * 1024) : "done" }],
	usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, cost: { total: 0.25 } },
	stopReason: "stop",
};
const event = JSON.stringify({ type: "message_end", message });
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (sessionPath) {
	appendFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
	appendFileSync(sessionPath, `${JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: new Date().toISOString(), message })}\n`);
}

if (mode === "fragmented") {
	process.stdout.write(event.slice(0, 17));
	setTimeout(() => { process.stdout.write(`${event.slice(17)}\n`); emit({ type: "agent_settled" }); }, 5);
} else if (mode === "empty") {
	// Deliberately successful OS exit with no protocol.
} else if (mode === "stale") {
	emit({ type: "message_end", message });
	emit({ type: "message_end", message: { ...message, content: [], stopReason: "toolUse" } });
	emit({ type: "agent_settled" });
} else if (mode === "tool-only") {
	emit({ type: "message_end", message: { role: "toolResult", toolCallId: "orphan", content: [] } });
	emit({ type: "agent_settled" });
} else if (mode === "unpaired") {
	emit({ type: "tool_execution_start", toolCallId: "pending", toolName: "read" });
	emit({ type: "message_end", message });
	emit({ type: "agent_settled" });
} else if (["length", "pending", "toolUse"].includes(mode)) {
	emit({ type: "message_end", message: { ...message, stopReason: mode } });
	emit({ type: "agent_settled" });
} else if (mode === "missing-settled") {
	emit({ type: "message_end", message });
} else if (mode === "multi-text") {
	emit({ type: "message_end", message: { ...message, content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } });
	emit({ type: "agent_settled" });
} else if (mode === "malformed") {
	process.stdout.write("{not-json}\n");
} else if (mode === "stderr") {
	process.stderr.write("e".repeat(20 * 1024));
	process.stdout.write(`${event}\n`);
	emit({ type: "agent_settled" });
} else if (mode === "nonzero") {
	process.stdout.write(`${event}\n`);
	process.exitCode = 7;
} else if (mode === "wait-term") {
	process.on("SIGTERM", () => process.exit(0));
	setInterval(() => {}, 1000);
} else if (mode === "ignore-term") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else if (mode === "activity") {
	emit({ type: "agent_start" });
	emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "secret" } });
	setTimeout(() => {
		emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "secret", isError: false });
		process.stdout.write(`${event}\n`);
		emit({ type: "agent_end", messages: [] });
		emit({ type: "agent_settled" });
	}, 10);
} else if (mode === "retry") {
	emit({ type: "message_end", message: { ...message, content: [], stopReason: "error", errorMessage: "private error" } });
	emit({ type: "agent_end", messages: [] });
	emit({ type: "agent_start" });
	process.stdout.write(`${event}\n`);
	emit({ type: "agent_settled" });
} else if (mode === "agent-end-only") {
	emit({ type: "agent_end", messages: [] });
	process.on("SIGTERM", () => process.exit(0));
	setInterval(() => {}, 1000);
} else if (mode === "settled-stall") {
	process.stdout.write(`${event}\n`);
	emit({ type: "agent_settled" });
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else {
	process.stdout.write(`${event}\n`);
	emit({ type: "agent_settled" });
}
