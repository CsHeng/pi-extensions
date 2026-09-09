import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
	AGENT_OUTCOMES,
	BRIDGE_STATUSES,
	HANDOFF_ACTIONS,
	HANDOFF_ERROR_CODES,
	HANDOFF_EVENTS,
	HANDOFF_MODES,
	HANDOFF_RESULT_SCHEMA_VERSION,
	HANDOFF_STATES,
	HANDOFF_TOOL_NAME,
	HARD_LIMITS,
	HandoffToolSchema,
	TARGET_TYPES,
	WORKSPACE_STATUSES,
	claimsCompletion,
	emptyContinuation,
	initialHandoffMachine,
	ownsLiveHandle,
	transitionHandoff,
	truncateUtf8,
	type HandoffEvent,
	type HandoffResult,
	type HandoffToolInput,
} from "../extensions/herdr-handoff/contracts.ts";

function beginInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "begin",
		mode: "delegate-return",
		target: { type: "message-existing", target: "codex-worker", kind: "codex" },
		request: {
			objective: "Implement the bounded change",
			plan: { source: "inline", text: "Change only src/file.ts." },
			allowedWrites: ["src/file.ts"],
			nonGoals: ["Do not commit"],
			verification: ["focused test"],
		},
		...overrides,
	};
}

function asInput(value: Record<string, unknown>): HandoffToolInput {
	assert.equal(Check(HandoffToolSchema, value), true);
	return value as unknown as HandoffToolInput;
}

test("tool schema accepts the four actions and every mode/target combination", () => {
	assert.equal(HANDOFF_TOOL_NAME, "herdr_handoff");
	assert.equal(HandoffToolSchema.type, "object");
	assert.deepEqual(HANDOFF_ACTIONS, ["begin", "continue", "wait", "cancel"]);
	assert.deepEqual(HANDOFF_MODES, ["delegate-return", "transfer"]);
	assert.deepEqual(TARGET_TYPES, ["message-existing", "start-and-ask"]);
	for (const mode of HANDOFF_MODES) {
		assert.equal(Check(HandoffToolSchema, beginInput({ mode, target: {
			type: "message-existing",
			target: "w1:p2",
			kind: "codex",
		} })), true);
		assert.equal(Check(HandoffToolSchema, beginInput({ mode, target: {
			type: "start-and-ask",
			profileId: "codex-default",
		} })), true);
	}
	assert.equal(Check(HandoffToolSchema, {
		action: "continue",
		handle: "handoff-token",
		intent: "clarification",
		message: "Use the frozen plan.",
	}), true);
	assert.equal(Check(HandoffToolSchema, {
		action: "wait",
		handle: "handoff-token",
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	}), true);
	assert.equal(Check(HandoffToolSchema, {
		action: "cancel",
		handle: "handoff-token",
	}), true);
});

test("action-specific fields are required and unknown or forbidden fields are rejected", () => {
	assert.equal(Check(HandoffToolSchema, beginInput({ handle: "token" })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ cwd: "/tmp" })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ command: "bash" })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ env: { HERDR_ENV: "1" } })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ retry: 1 })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ fallback: "subagents" })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ closePane: true })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ kill: true })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ autoMerge: true })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ commit: true })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ permissionAnswer: "yes" })), false);
	assert.equal(Check(HandoffToolSchema, { action: "continue", intent: "repair", message: "fix" }), false);
	assert.equal(Check(HandoffToolSchema, { action: "wait", handle: "token" }), false);
	assert.equal(Check(HandoffToolSchema, { action: "cancel", handle: "token", mode: "transfer" }), false);
	assert.equal(Check(HandoffToolSchema, { action: "retry" }), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ mode: "background" })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({
		target: { type: "message-existing", target: "agent", kind: "Codex" },
	})), false);
	assert.equal(Check(HandoffToolSchema, beginInput({
		request: { ...(beginInput().request as object), allowedWrites: [] },
	})), false);
});

test("path and wait ceilings are exact", () => {
	const writes = Array.from({ length: HARD_LIMITS.maxWritePaths }, (_, index) => `src/f${index}.ts`);
	assert.equal(Check(HandoffToolSchema, beginInput({
		request: { ...(beginInput().request as object), allowedWrites: writes },
	})), true);
	assert.equal(Check(HandoffToolSchema, beginInput({
		request: { ...(beginInput().request as object), allowedWrites: [...writes, "src/extra.ts"] },
	})), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ waitTimeoutMs: HARD_LIMITS.minWaitMs - 1 })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({ waitTimeoutMs: HARD_LIMITS.maxWaitMs })), true);
	assert.equal(Check(HandoffToolSchema, beginInput({ waitTimeoutMs: HARD_LIMITS.maxWaitMs + 1 })), false);
	assert.equal(Check(HandoffToolSchema, beginInput({
		request: { ...(beginInput().request as object), objective: "x".repeat(HARD_LIMITS.maxObjectiveBytes + 1) },
	})), false);
});

test("bridge, recipient, and workspace statuses stay separate from completion claims", () => {
	const result: HandoffResult = {
		schemaVersion: HANDOFF_RESULT_SCHEMA_VERSION,
		handoffId: "handoff-1",
		mode: "delegate-return",
		action: "begin",
		planSha256: "abc",
		bridgeStatus: "returned",
		agentOutcome: "implemented",
		workspaceStatus: "within_declared_writes",
		continuation: emptyContinuation(),
		durationMs: 10,
	};
	assert.deepEqual(BRIDGE_STATUSES, ["returned", "transferred", "blocked", "timed_out", "cancelled", "failed"]);
	assert.deepEqual(AGENT_OUTCOMES, ["implemented", "no_changes", "blocked", "needs_authority", "failed"]);
	assert.deepEqual(WORKSPACE_STATUSES, [
		"within_declared_writes",
		"scope_violation",
		"history_changed",
		"not_inspected",
		"unavailable",
	]);
	assert.equal("verified" in result, false);
	assert.equal("completed" in result, false);
	assert.equal(claimsCompletion(result), false);
	assert.equal(claimsCompletion({ bridgeStatus: "returned", verified: true }), true);
	assert.equal(claimsCompletion({ outcome: "completed" }), true);
	assert.equal((HANDOFF_STATES as readonly string[]).includes("verified"), false);
	assert.equal((HANDOFF_STATES as readonly string[]).includes("completed"), false);
});

test("state table enforces one clarification, one repair, and one recovery wait", () => {
	let machine = initialHandoffMachine();
	assert.equal(ownsLiveHandle(machine), false);
	machine = expectOk(machine, "begin_delegate");
	assert.equal(machine.mode, "delegate-return");
	machine = expectOk(machine, "prompt_submitted");
	machine = expectOk(machine, "settled_idle");
	assert.equal(machine.status, "returned");
	assert.equal(machine.activeOperation, false);
	machine = expectOk(machine, "continue_clarification");
	assert.equal(machine.clarificationUsed, true);
	machine = expectOk(machine, "prompt_submitted");
	machine = expectOk(machine, "settled_done");
	machine = expectOk(machine, "continue_repair");
	assert.equal(machine.repairUsed, true);
	machine = expectOk(machine, "prompt_submitted");
	machine = expectOk(machine, "settled_blocked");
	machine = expectOk(machine, "recovery_wait");
	assert.equal(machine.recoveryWaitUsed, true);
	machine = expectOk(machine, "timed_out");
	const exhausted = transitionHandoff(machine, "recovery_wait");
	assert.equal(exhausted.ok, false);
	if (!exhausted.ok) assert.equal(exhausted.code, "continuation_budget_exhausted");
	const duplicateClarification = transitionHandoff({
		...initialHandoffMachine(),
		status: "returned",
		mode: "delegate-return",
		clarificationUsed: true,
		repairUsed: false,
		recoveryWaitUsed: false,
		unresolvedCancellation: false,
		activeOperation: false,
	}, "continue_clarification");
	assert.equal(duplicateClarification.ok, false);
	if (!duplicateClarification.ok) assert.equal(duplicateClarification.code, "continuation_budget_exhausted");
});

test("transfer settlement is delivery plus working, not semantic acceptance", () => {
	let machine = initialHandoffMachine();
	machine = expectOk(machine, "begin_transfer");
	machine = expectOk(machine, "prompt_submitted");
	const idle = transitionHandoff(machine, "settled_idle");
	assert.equal(idle.ok, false);
	machine = expectOk(machine, "observed_working");
	assert.equal(machine.status, "transferred");
	assert.equal(ownsLiveHandle(machine), false);
	for (const event of ["continue_clarification", "continue_repair", "recovery_wait", "cancel_requested"] as const) {
		const rejected = transitionHandoff(machine, event);
		assert.equal(rejected.ok, false);
		if (!rejected.ok) assert.equal(rejected.code, "ownership_transferred");
	}
});

test("timeout and blocked recovery share one wait budget and cancellation preserves identity failures", () => {
	let blocked = initialHandoffMachine();
	blocked = expectOk(blocked, "begin_delegate");
	blocked = expectOk(blocked, "prompt_submitted");
	blocked = expectOk(blocked, "settled_blocked");
	blocked = expectOk(blocked, "recovery_wait");
	blocked = expectOk(blocked, "timed_out");
	const secondWait = transitionHandoff(blocked, "recovery_wait");
	assert.equal(secondWait.ok, false);

	let timed = initialHandoffMachine();
	timed = expectOk(timed, "begin_delegate");
	timed = expectOk(timed, "prompt_submitted");
	timed = expectOk(timed, "timed_out");
	timed = expectOk(timed, "cancel_requested");
	const stale = transitionHandoff(timed, "identity_mismatch");
	assert.equal(stale.ok, true);
	if (stale.ok) assert.equal(stale.machine.status, "stale");

	let unconfirmed = initialHandoffMachine();
	unconfirmed = expectOk(unconfirmed, "begin_delegate");
	unconfirmed = expectOk(unconfirmed, "prompt_submitted");
	unconfirmed = expectOk(unconfirmed, "cancel_unconfirmed");
	assert.equal(unconfirmed.status, "failed");
	assert.equal(unconfirmed.unresolvedCancellation, true);
	const blockedBegin = transitionHandoff(unconfirmed, "begin_delegate");
	assert.equal(blockedBegin.ok, false);
	if (!blockedBegin.ok) assert.equal(blockedBegin.code, "cancel_unconfirmed");
});

test("error and lifecycle enums are code-owned and UTF-8 truncation is bounded", () => {
	assert.ok(HANDOFF_ERROR_CODES.includes("malformed_return"));
	assert.ok(HANDOFF_ERROR_CODES.includes("scope_violation"));
	assert.ok(HANDOFF_ERROR_CODES.includes("cancel_unconfirmed"));
	assert.deepEqual(HANDOFF_EVENTS.includes("prompt_submitted"), true);
	const truncated = truncateUtf8("a😀b", 5);
	assert.equal(truncated.text, "a😀");
	assert.equal(truncated.truncatedBytes, 1);
	assert.deepEqual(asInput(beginInput()).action, "begin");
});

function expectOk(machine: ReturnType<typeof initialHandoffMachine>, event: HandoffEvent) {
	const result = transitionHandoff(machine, event);
	assert.equal(result.ok, true, `${machine.status} + ${event}`);
	if (!result.ok) throw new Error("expected transition success");
	return result.machine;
}
