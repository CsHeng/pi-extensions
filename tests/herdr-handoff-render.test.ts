import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { HANDOFF_RESULT_SCHEMA_VERSION, emptyContinuation, type HandoffResult } from "../extensions/herdr-handoff/contracts.ts";
import { boundToolContent, formatHandoffResult, formatStatus } from "../extensions/herdr-handoff/render.ts";

function result(overrides: Partial<HandoffResult> = {}): HandoffResult {
	return {
		schemaVersion: HANDOFF_RESULT_SCHEMA_VERSION,
		handoffId: "hid",
		mode: "delegate-return",
		action: "begin",
		planSha256: "abc123def456",
		bridgeStatus: "returned",
		agentOutcome: "implemented",
		workspaceStatus: "within_declared_writes",
		continuation: emptyContinuation(),
		durationMs: 10,
		recipientKind: "codex",
		recipientName: "codex-worker",
		workspace: { status: "within_declared_writes", changedPaths: ["src.ts"], violations: [] },
		...overrides,
	};
}

test("handoff rendering stays compact, unverified, and redacted", () => {
	const text = formatHandoffResult(result());
	assert.match(text, /parent verification required/);
	assert.match(text, /unverified claim/);
	assert.doesNotMatch(text, /\bverified\b/);
	assert.doesNotMatch(text, /\bcompleted\b/);
	assert.doesNotMatch(text, /--secret/);
	assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
});

test("status output omits profile IDs and argv", () => {
	const text = formatStatus({
		ready: true,
		version: "0.8.2",
		launchConfigValid: true,
		profileCount: 2,
		active: false,
		handlePresent: false,
	});
	assert.match(text, /profiles=2/);
	assert.doesNotMatch(text, /codex-default/);
	assert.doesNotMatch(text, /argv/);
});

test("bound tool content enforces Pi limits", () => {
	const huge = Array.from({ length: DEFAULT_MAX_LINES + 50 }, (_, index) => `line-${index}`).join("\n");
	const bounded = boundToolContent(huge);
	assert.ok(bounded.split("\n").length <= DEFAULT_MAX_LINES);
});
