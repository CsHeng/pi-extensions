import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { boundNativeObservation, collectNativeObservation, isNativeObservation, mergeOwnedUsage, nativeCapabilityInvalidated, nativeLeaf, projectRecordedUsage, unavailableObservation, type NativeObservation, type NativeUsageRow, type ObservedUsage } from "../extensions/subagents/observability.ts";
import { MANAGED_LIMITS } from "../extensions/subagents/session-contracts.ts";
import { emptyUsage, HARD_LIMITS } from "../extensions/subagents/contracts.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const jsonl = (...entries: unknown[]) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const none = { startLeaf: null, endLeaf: null, launched: true };
const through = (endLeaf: string, startLeaf: string | null = null) => ({ startLeaf, endLeaf, launched: true });
const session = (id = "owner") => ({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: "/secret/home/project" });
const message = (id: string, parentId: string | null, role: string, extra: Record<string, unknown> = {}) => ({
	type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z",
	message: { role, content: extra.content ?? [{ type: "text", text: extra.prose ?? "visible-prose" }], ...extra },
});
const assistant = (id: string, parentId: string | null, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	message(id, parentId, "assistant", { usage, provider: extra.provider ?? "fixture-provider", model: extra.model ?? "fixture-model", ...extra });
const usage = (input: number, cost: number, extra: Record<string, unknown> = {}) => ({
	input, output: extra.output ?? 1, cacheRead: extra.cacheRead ?? 0, cacheWrite: extra.cacheWrite ?? 0, totalTokens: extra.totalTokens ?? input + 1,
	cost: extra.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const forbidden = [
	"secret-provider", "secret-model", "visible-prose", "/secret/home/project", "/secret/token",
	"cat /etc/passwd", "SECRET_TOKEN", "nested-child-usage", "retained-assistant",
];
function redacted(value: unknown) {
	const text = JSON.stringify(value);
	for (const item of forbidden) assert.doesNotMatch(text, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("capability failure uses only structured markers in the current owned native range", () => {
	const marker = { type: "custom", id: "failure", parentId: null, customType: "csheng-subagent-capability-failure", data: { version: 1, code: "capability_invalidated" } };
	const history = jsonl(session(), marker, assistant("done", "failure", usage(1, 0)), message("next", "done", "user", { prose: JSON.stringify(marker) }), assistant("ok", "next", usage(1, 0)));
	assert.equal(nativeCapabilityInvalidated(history, null, "done"), true);
	assert.equal(nativeCapabilityInvalidated(history, "done", "ok"), false);
	assert.equal(nativeCapabilityInvalidated(history, "missing", "ok"), false);
	assert.equal(nativeCapabilityInvalidated(`${history}{`, null, "done"), false);
	const forged = jsonl(session(), message("tool", null, "toolResult", { prose: JSON.stringify(marker) }));
	assert.equal(nativeCapabilityInvalidated(forged, null, "tool"), false);
});

test("unlaunched empty files and empty selected ranges are known zero, launched empty is unavailable", () => {
	const idle = collectNativeObservation("", { startLeaf: null, endLeaf: null, launched: false });
	assert.deepEqual(idle, { available: true, ownerSessionId: null, entries: [], commands: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, contextWindow: null, toolNames: null, capabilityKey: null, commandCoverage: "complete" });
	assert.equal(collectNativeObservation("", none).available, false);
	assert.deepEqual(collectNativeObservation("", none).usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	const header = collectNativeObservation(jsonl(session()), none);
	assert.equal(header.available, true);
	assert.equal(header.ownerSessionId, "owner");
	assert.deepEqual(header.usage, idle.usage);
	const history = jsonl(session(), message("u1", null, "user"), assistant("a1", "u1", usage(3, 0.25)));
	const emptyRange = collectNativeObservation(history, through("a1", "a1"));
	assert.equal(emptyRange.available, true);
	assert.deepEqual(emptyRange.entries, []);
	assert.deepEqual(emptyRange.usage, idle.usage);
	assert.deepEqual(emptyUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
	assert.deepEqual(mergeOwnedUsage([]), { available: true, usage: idle.usage, entries: [] });
});

test("assistant and compaction cost are counted once from direct usage only", () => {
	const history = jsonl(
		session(),
		message("u1", null, "user"),
		assistant("a1", "u1", usage(4, 0.5, { output: 2, cacheRead: 0, cacheWrite: 1, totalTokens: 7 })),
		{ type: "compaction", id: "c1", parentId: "a1", summary: "visible-prose SYNTHETIC_SUMMARY", firstKeptEntryId: "a1", tokensBefore: 80, usage: usage(0, 0.25, { output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }) },
	);
	const observed = collectNativeObservation(history, through("c1"));
	assert.equal(observed.available, true);
	assert.equal(observed.entries.length, 2);
	assert.equal(observed.entries[0]?.kind, "assistant");
	assert.equal(observed.entries[1]?.kind, "compaction");
	assert.deepEqual(observed.usage, { input: 4, output: 2, cacheRead: 0, cacheWrite: 1, totalTokens: 7, cost: 0.75 });
	assert.equal(observed.entries[0]?.modelKey, digest(JSON.stringify(["fixture-provider", "fixture-model"])));
	assert.equal(observed.entries[1]?.modelKey, null);
});

test("unknown metrics stay null and are not inferred as zero or totalTokens", () => {
	const history = jsonl(
		session(),
		message("u1", null, "user"),
		assistant("a1", "u1", { input: 2, output: 0, cacheRead: 0, cost: { total: 0 } }, { provider: "fixture-provider", model: "fixture-model" }),
	);
	const observed = collectNativeObservation(history, through("a1"));
	assert.equal(observed.available, true);
	assert.deepEqual(observed.usage, { input: 2, output: 0, cacheRead: 0, cacheWrite: null, totalTokens: null, cost: 0 });
	assert.equal(observed.entries[0]?.usage.cacheWrite, null);
	assert.notEqual(observed.usage.cacheRead, null);
	assert.equal(observed.usage.cacheRead, 0);
	const poisoned = collectNativeObservation(jsonl(
		session(),
		message("u1", null, "user"),
		assistant("a1", "u1", usage(1, 0)),
		assistant("a2", "a1", { input: 1, output: Number.NaN, cacheRead: -1, cacheWrite: Number.POSITIVE_INFINITY, cost: { total: 1 } }),
	), through("a2"));
	assert.equal(poisoned.available, true);
	assert.equal(poisoned.usage.input, 2);
	assert.equal(poisoned.usage.output, null);
	assert.equal(poisoned.usage.cacheRead, null);
	assert.equal(poisoned.usage.cacheWrite, null);
	assert.equal(poisoned.usage.totalTokens, null);
	assert.equal(poisoned.usage.cost, 1);
});

test("missing summary usage, copied fork prefixes and overflowing totals are not fabricated as zero", () => {
	for (const type of ["compaction", "branch_summary"]) {
		const result = collectNativeObservation(jsonl(session(), { type, id: "summary", parentId: null }), through("summary"));
		assert.equal(result.entries.length, 1); assert.equal(result.usage.cost, null);
	}
	const history = jsonl({ ...session("fork"), parentSession: "/private/parent.jsonl" }, assistant("a", null, usage(1, 1)), assistant("b", "a", usage(2, 2)));
	assert.equal(collectNativeObservation(history, through("b")).available, false);
	assert.equal(collectNativeObservation(history, through("b", "a")).usage.cost, 2);
	assert.equal(collectNativeObservation("", { startLeaf: "missing", endLeaf: null, launched: false }).available, false);
	const overflow = collectNativeObservation(jsonl(session(), assistant("a", null, usage(1e308, 1e308)), assistant("b", "a", usage(1e308, 1e308))), through("b"));
	assert.equal(overflow.usage.input, null); assert.equal(overflow.usage.cost, null);
});

test("runtime observation validation never coerces JSON values or emits extra nested payload", () => {
	const original = collectNativeObservation(jsonl(session(), assistant("a", null, usage(1, 1))), through("a"));
	for (const kind of [{ toString: null }, ["assistant"]]) {
		const input = structuredClone(original); (input.entries[0] as unknown as Record<string, unknown>).kind = kind;
		assert.equal(isNativeObservation(input), false); assert.equal(mergeOwnedUsage([input]).available, false);
	}
	const input = structuredClone(original);
	(input.entries[0]!.usage as unknown as Record<string, unknown>).rawPrompt = "SECRET";
	assert.equal(isNativeObservation(input), false);
	const result = mergeOwnedUsage([input]); assert.equal(result.available, false); assert.doesNotMatch(JSON.stringify(result), /SECRET|rawPrompt/);
});

test("two episode ranges over one history split physical appends and merge to the full span", () => {
	const history = jsonl(
		session(),
		message("u1", null, "user"),
		assistant("a1", "u1", usage(3, 0.25)),
		message("u2", "a1", "user"),
		assistant("a2", "u2", usage(5, 0.5, { output: 2, totalTokens: 7 })),
		{ type: "compaction", id: "c1", parentId: "a2", summary: "tail", firstKeptEntryId: "u2", usage: usage(1, 0.25, { output: 0, totalTokens: 1 }) },
	);
	const first = collectNativeObservation(history, through("a1"));
	const second = collectNativeObservation(history, through("c1", "a1"));
	assert.deepEqual(first.usage, { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: 0.25 });
	assert.deepEqual(second.usage, { input: 6, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: 0.75 });
	assert.deepEqual(first.entries.map((row) => row.entryId), ["a1"]);
	assert.deepEqual(second.entries.map((row) => row.entryId), ["a2", "c1"]);
	const merged = mergeOwnedUsage([first, second]);
	assert.equal(merged.available, true);
	assert.deepEqual(merged.usage, { input: 9, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 1 });
	assert.deepEqual(merged.entries.map((row) => row.entryId), ["a1", "a2", "c1"]);
});

test("reread, retainedTail and nested parent-child envelopes count each owner once", () => {
	const childHistory = jsonl(
		session("child"),
		message("cu1", null, "user"),
		assistant("ca1", "cu1", usage(8, 1.5), { provider: "secret-provider", model: "secret-model", prose: "nested-child-usage" }),
	);
	const parentHistory = jsonl(
		session("parent"),
		message("pu1", null, "user"),
		assistant("pa1", "pu1", usage(2, 0.25), { content: [{ type: "toolCall", id: "call", name: "csheng_subagents", arguments: { tasks: ["nested-child-usage"] } }] }),
		message("pt1", "pa1", "toolResult", {
			toolName: "csheng_subagents",
			content: "nested-child-usage",
			details: { usage: usage(999, 99), entries: [{ ownerSessionId: "child", entryId: "ca1", usage: usage(999, 99) }], output: "SECRET_TOKEN" },
		}),
		{
			type: "compaction", id: "pc1", parentId: "pt1", summary: "visible-prose", firstKeptEntryId: "pt1",
			retainedTail: [assistant("retained-assistant", null, usage(999, 99), { prose: "retained-assistant" })],
			details: { usage: usage(999, 99) },
			usage: usage(1, 0.125, { output: 0, totalTokens: 1 }),
		},
	);
	const parent = collectNativeObservation(parentHistory, through("pc1"));
	const child = collectNativeObservation(childHistory, through("ca1"));
	const reread = collectNativeObservation(childHistory, through("ca1"));
	assert.deepEqual(parent.usage, { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: 0.375 });
	assert.deepEqual(child.usage, { input: 8, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: 1.5 });
	const merged = mergeOwnedUsage([parent, child, reread, child]);
	assert.equal(merged.available, true);
	assert.deepEqual(merged.entries.map((row) => `${row.ownerSessionId}:${row.entryId}`), ["parent:pa1", "parent:pc1", "child:ca1"]);
	assert.deepEqual(merged.usage, { input: 11, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: 1.875 });
	redacted(parent);
	redacted(child);
	redacted(merged);
});

test("identical repeated rows count once while conflicting same-entry rows make merge unavailable", () => {
	const history = jsonl(session(), message("u1", null, "user"), assistant("a1", "u1", usage(4, 0.4)));
	const first = collectNativeObservation(history, through("a1"));
	const copy = collectNativeObservation(history, through("a1"));
	assert.deepEqual(mergeOwnedUsage([first, copy]).usage, first.usage);
	assert.equal(mergeOwnedUsage([first, copy]).entries.length, 1);
	const conflict = collectNativeObservation(jsonl(session(), message("u1", null, "user"), assistant("a1", "u1", usage(9, 0.9))), through("a1"));
	const merged = mergeOwnedUsage([first, conflict]);
	assert.equal(merged.available, false);
	assert.deepEqual(merged.entries, []);
	assert.deepEqual(merged.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.equal(mergeOwnedUsage([collectNativeObservation("{", none), first]).available, false);
});

test("partial newline, missing, reversed and nonfinite boundaries fail closed without a silent prefix", () => {
	const history = jsonl(session(), message("u1", null, "user"), assistant("a1", "u1", usage(2, 0)), message("u2", "a1", "user"), assistant("a2", "u2", usage(5, 0)));
	const partial = collectNativeObservation(history.trimEnd(), through("a2"));
	assert.equal(partial.available, false);
	assert.equal(partial.ownerSessionId, null);
	assert.deepEqual(partial.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.equal(collectNativeObservation(`${history}{`, through("a2")).available, false);
	assert.equal(collectNativeObservation(history, through("missing")).available, false);
	assert.equal(collectNativeObservation(history, through("a2", "missing")).available, false);
	assert.equal(collectNativeObservation(history, through("u1", "a2")).available, false);
	assert.equal(collectNativeObservation(history, none).available, false);
	assert.equal(collectNativeObservation(history, through("a2", "not valid")).available, false);
	assert.deepEqual(collectNativeObservation(history, through("a2")).usage.input, 7);
	const oversized = `${jsonl(session())}${"x".repeat(MANAGED_LIMITS.maxNativeLineBytes + 1)}\n`;
	assert.equal(collectNativeObservation(oversized, none).available, false);
	assert.equal(collectNativeObservation(jsonl({ type: "session", version: 2, id: "owner" }), none).available, false);
	assert.equal(collectNativeObservation(jsonl(session(), { type: "message", id: "next", parentId: "missing", message: { role: "user" } }), through("next")).available, false);
});

test("model keys stay opaque and secrets, prose, commands and paths never leave the collector", () => {
	const before = digest("before-state");
	const after = digest("after-state");
	const capability = digest("capability-manifest");
	const history = jsonl(
		session(),
		message("u1", null, "user", { prose: "visible-prose", content: "cat /etc/passwd" }),
		assistant("a1", "u1", usage(1, 0.01), { provider: "secret-provider", model: "secret-model", prose: "visible-prose" }),
		{
			type: "custom", id: "cmd1", parentId: "a1", customType: "csheng-worker-command",
			data: {
				startMs: 10, endMs: 25, exitCode: 0, status: "succeeded", sourceBeforeKey: before, sourceAfterKey: after,
				command: "cat /etc/passwd", output: "SECRET_TOKEN", cwd: "/secret/token", path: "/secret/home/project",
			},
		},
		{
			type: "custom", id: "ep1", parentId: "cmd1", customType: "csheng-episode-observation",
			data: { contextWindow: 128000, toolNames: ["read", "grep", "find", "ls", "edit", "write"], capabilityKey: capability, prompt: "visible-prose" },
		},
	);
	const observed = collectNativeObservation(history, through("ep1"));
	assert.equal(observed.available, true);
	assert.equal(observed.entries[0]?.modelKey, digest(JSON.stringify(["secret-provider", "secret-model"])));
	assert.notEqual(observed.entries[0]?.modelKey, "secret-provider/secret-model");
	assert.deepEqual(observed.commands, [{
		ownerSessionId: "owner", entryId: "cmd1", startMs: 10, endMs: 25, exitCode: 0, status: "succeeded",
		sourceBeforeKey: before, sourceAfterKey: after,
	}]);
	assert.equal(observed.contextWindow, 128000);
	assert.deepEqual(observed.toolNames, ["read", "grep", "find", "ls", "edit", "write"]);
	assert.equal(observed.capabilityKey, capability);
	redacted(observed);
});

test("command spans keep scalar endpoints and capability metadata fails closed to null", () => {
	const before = digest("source-before");
	const prefix = jsonl(
		session(),
		message("u1", null, "user"),
		{
			type: "custom", id: "ok", parentId: "u1", customType: "csheng-worker-command",
			data: { startMs: 1, endMs: 1, exitCode: 0, status: "succeeded", sourceBeforeKey: before, sourceAfterKey: null },
		},
		{
			type: "custom", id: "back", parentId: "ok", customType: "csheng-worker-command",
			data: { startMs: 20, endMs: 10, exitCode: 2, status: "failed", sourceBeforeKey: "/secret/token", sourceAfterKey: "not-a-digest" },
		},
		{
			type: "custom", id: "bad", parentId: "back", customType: "csheng-worker-command",
			data: { startMs: Number.NaN, endMs: Number.NEGATIVE_INFINITY, exitCode: 1.5, status: "explode", sourceBeforeKey: null },
		},
	);
	const history = `${prefix}{"type":"custom","id":"inf","parentId":"bad","customType":"csheng-worker-command","data":{"startMs":1e309,"endMs":5,"exitCode":1,"status":"timeout"}}\n${jsonl({ type: "custom", id: "meta", parentId: "inf", customType: "csheng-episode-observation", data: { contextWindow: 0, toolNames: ["read", "../secret"], capabilityKey: "/secret/home/project" } })}`;
	const observed = collectNativeObservation(history, through("meta"));
	assert.equal(observed.available, true);
	assert.deepEqual(observed.commands[0], {
		ownerSessionId: "owner", entryId: "ok", startMs: 1, endMs: 1, exitCode: 0, status: "succeeded",
		sourceBeforeKey: before, sourceAfterKey: null,
	});
	assert.deepEqual(observed.commands[1], {
		ownerSessionId: "owner", entryId: "back", startMs: null, endMs: null, exitCode: 2, status: "failed",
		sourceBeforeKey: null, sourceAfterKey: null,
	});
	assert.deepEqual(observed.commands[2], {
		ownerSessionId: "owner", entryId: "bad", startMs: null, endMs: null, exitCode: null, status: "unknown",
		sourceBeforeKey: null, sourceAfterKey: null,
	});
	assert.deepEqual(observed.commands[3], {
		ownerSessionId: "owner", entryId: "inf", startMs: null, endMs: 5, exitCode: 1, status: "timeout",
		sourceBeforeKey: null, sourceAfterKey: null,
	});
	assert.equal(observed.contextWindow, null);
	assert.equal(observed.toolNames, null);
	assert.equal(observed.capabilityKey, null);
	assert.deepEqual(observed.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
	redacted(observed);
});

const emptySpans = () => ({ assistant: [], reasoning: [], localTool: [], delegationWait: [], compaction: [] });
const localTiming = (extra: Record<string, unknown> = {}) => ({
	version: 1 as const, clockKey: "clock-1", originMs: 1, boundary: { startMs: 0, endMs: 10 },
	spans: emptySpans(), complete: true, ...extra,
});

test("episode timing is accepted only as LocalTiming and missing metadata stays omitted", () => {
	const valid = collectNativeObservation(jsonl(
		session(),
		{ type: "custom", id: "t1", parentId: null, customType: "csheng-episode-timing", data: localTiming() },
	), through("t1"));
	assert.equal(valid.available, true);
	assert.deepEqual(valid.timing, localTiming());
	assert.equal(valid.commandCoverage, "complete");
	const missing = collectNativeObservation(jsonl(session(), assistant("a", null, usage(1, 0))), through("a"));
	assert.equal("timing" in missing, false);
	const invalid = collectNativeObservation(jsonl(
		session(),
		{ type: "custom", id: "t1", parentId: null, customType: "csheng-episode-timing", data: { version: 2, clockKey: "clock-1" } },
	), through("t1"));
	assert.equal(invalid.timing, null);
	const backward = collectNativeObservation(jsonl(
		session(),
		{ type: "custom", id: "t1", parentId: null, customType: "csheng-episode-timing", data: localTiming({ complete: true, boundary: { startMs: 20, endMs: 1 } }) },
	), through("t1"));
	assert.equal(backward.timing, null);
	const tooMany = collectNativeObservation(jsonl(
		session(),
		{
			type: "custom", id: "t1", parentId: null, customType: "csheng-episode-timing",
			data: localTiming({ spans: { ...emptySpans(), assistant: Array.from({ length: HARD_LIMITS.maxWaitSpans + 1 }, () => ({ startMs: 0, endMs: 1 })) } }),
		},
	), through("t1"));
	assert.equal(tooMany.timing, null);
	redacted(valid);
});

test("failed compaction custom marker adds a null usage row without zero or error prose", () => {
	const observed = collectNativeObservation(jsonl(
		session(),
		{ type: "custom", id: "cu", parentId: null, customType: "csheng-compaction-unavailable", data: { status: "failed", summary: "visible-prose", error: "SECRET_TOKEN" } },
	), through("cu"));
	assert.equal(observed.available, true);
	assert.equal(observed.entries.length, 1);
	assert.equal(observed.entries[0]?.kind, "compaction");
	assert.deepEqual(observed.entries[0]?.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.deepEqual(observed.usage, observed.entries[0]?.usage);
	redacted(observed);
});

test("bash toolCall identities set command coverage without inventing command time", () => {
	const before = digest("env-before");
	const after = digest("env-after");
	const complete = collectNativeObservation(jsonl(
		session(),
		assistant("a1", null, usage(1, 0), { content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "cat /etc/passwd" } }, { type: "text", text: "visible-prose" }] }),
		{
			type: "custom", id: "cmd1", parentId: "a1", customType: "csheng-worker-command",
			data: {
				toolCallId: "call1", startMs: 1, endMs: 2, exitCode: 0, status: "succeeded", sourceBeforeKey: before, sourceAfterKey: after,
				environmentBeforeKey: before, environmentAfterKey: after, command: "cat /etc/passwd", cwd: "/secret/token",
			},
		},
	), through("cmd1"));
	assert.equal(complete.commandCoverage, "complete");
	assert.equal(complete.commands[0]?.environmentBeforeKey, before);
	assert.equal(complete.commands[0]?.environmentAfterKey, after);
	assert.equal(complete.commands[0]?.startMs, 1);
	redacted(complete);
	const nested = collectNativeObservation(jsonl(
		session(),
		assistant("a1", null, usage(1, 0), {
			content: [{ type: "text", text: "visible-prose" }],
			details: { content: [{ type: "toolCall", name: "bash", arguments: { command: "cat /etc/passwd" } }] },
		}),
	), through("a1"));
	assert.equal(nested.commandCoverage, "complete");
	const partial = collectNativeObservation(jsonl(
		session(),
		assistant("a1", null, usage(1, 0), { content: [{ type: "toolCall", name: "bash" }, { type: "toolCall", name: "bash" }] }),
		{ type: "custom", id: "cmd1", parentId: "a1", customType: "csheng-worker-command", data: { status: "succeeded", startMs: 3, endMs: 4 } },
	), through("cmd1"));
	assert.equal(partial.commandCoverage, "partial");
	assert.equal(partial.commands.length, 1);
	assert.equal(partial.commands[0]?.startMs, 3);
	const missing = collectNativeObservation(jsonl(
		session(),
		assistant("a1", null, usage(1, 0), { content: [{ type: "toolCall", name: "bash" }] }),
	), through("a1"));
	assert.equal(missing.commandCoverage, "partial");
	assert.deepEqual(missing.commands, []);
});

test("equal command counts with mismatched identities remain partial", () => {
	const observed = collectNativeObservation(jsonl(session(),
		assistant("a", null, usage(1, 0), { content: [{ type: "toolCall", id: "one", name: "bash" }, { type: "toolCall", id: "two", name: "bash" }] }),
		{ type: "custom", id: "cmd1", parentId: "a", customType: "csheng-worker-command", data: { toolCallId: "one" } },
		{ type: "custom", id: "cmd2", parentId: "cmd1", customType: "csheng-worker-command", data: { toolCallId: "one" } },
	), through("cmd2"));
	assert.equal(observed.commandCoverage, "partial");
	assert.equal(observed.commands.length, 2);
});

test("closed observation shapes reject unknown keys and String coercion", () => {
	const original = collectNativeObservation(jsonl(session(), assistant("a", null, usage(1, 1))), through("a"));
	assert.equal(isNativeObservation(original), true);
	const extraTop = structuredClone(original); (extraTop as unknown as Record<string, unknown>).price = 1;
	assert.equal(isNativeObservation(extraTop), false);
	const extraRow = structuredClone(original); (extraRow.entries[0] as unknown as Record<string, unknown>).raw = "SECRET_TOKEN";
	assert.equal(isNativeObservation(extraRow), false);
	const extraCommand = structuredClone(original);
	extraCommand.commands.push({
		ownerSessionId: "owner", entryId: "cmd", startMs: 1, endMs: 2, exitCode: 0, status: "succeeded",
		sourceBeforeKey: null, sourceAfterKey: null, command: "cat /etc/passwd",
	} as typeof extraCommand.commands[number]);
	assert.equal(isNativeObservation(extraCommand), false);
	const stringed = structuredClone(original); (stringed as unknown as Record<string, unknown>).available = "true";
	assert.equal(isNativeObservation(stringed), false);
	assert.equal(isNativeObservation(unavailableObservation()), true);
	assert.equal(unavailableObservation().available, false);
});

test("nativeLeaf uses full native validation and allows fork headers for cursor discovery", () => {
	assert.equal(nativeLeaf(""), null);
	assert.equal(nativeLeaf(jsonl(session())), null);
	const history = jsonl(session(), message("u1", null, "user"), assistant("a1", "u1", usage(1, 0)));
	assert.equal(nativeLeaf(history), "a1");
	assert.equal(nativeLeaf(history.trimEnd()), undefined);
	assert.equal(nativeLeaf(`${history}{`), undefined);
	assert.equal(nativeLeaf(jsonl({ type: "session", version: 2, id: "owner" })), undefined);
	const fork = jsonl({ ...session("fork"), parentSession: "/private/parent.jsonl" }, assistant("a", null, usage(1, 1)), assistant("b", "a", usage(2, 2)));
	assert.equal(nativeLeaf(fork), "b");
	assert.equal(collectNativeObservation(fork, through("b")).available, false);
	assert.equal(nativeLeaf(`${jsonl(session())}${"x".repeat(MANAGED_LIMITS.maxNativeLineBytes + 1)}\n`), undefined);
});

test("boundNativeObservation fails closed past 64KiB without a truncated complete prefix", () => {
	const small = collectNativeObservation(jsonl(session(), assistant("a", null, usage(1, 1))), through("a"));
	assert.equal(boundNativeObservation(small).available, true);
	const huge = structuredClone(small);
	huge.entries = Array.from({ length: 900 }, (_, index) => ({
		ownerSessionId: "owner", entryId: `e${index}`, kind: "assistant" as const, modelKey: null,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
	}));
	assert.equal(isNativeObservation(huge), true);
	assert.ok(Buffer.byteLength(JSON.stringify(huge), "utf8") > 64 * 1024);
	const bounded = boundNativeObservation(huge);
	assert.equal(bounded.available, false);
	assert.deepEqual(bounded.entries, []);
	assert.deepEqual(bounded.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
});

// Session-wide recorded usage projection over saved episode observations.
const idleObservation = collectNativeObservation("", { startLeaf: null, endLeaf: null, launched: false });
const recordedHandle = (handle: string, expectedEpisodes: number | null, episodes: Array<{ episode: number; observation: NativeObservation }>) =>
	({ handle, expectedEpisodes, episodes });
const row = (ownerSessionId: string, entryId: string, usage: Partial<ObservedUsage>, kind: NativeUsageRow["kind"] = "assistant"): NativeUsageRow =>
	({ ownerSessionId, entryId, kind, modelKey: null, usage: { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null, ...usage } });
const syntheticObservation = (ownerSessionId: string, entries: NativeUsageRow[]): NativeObservation =>
	({ available: true, ownerSessionId, entries, commands: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, contextWindow: null, toolNames: null, capabilityKey: null });

test("recorded usage overflow cannot be labeled as a complete metric", () => {
	const observation = syntheticObservation("overflow", [row("overflow", "a", { input: Number.MAX_VALUE }), row("overflow", "b", { input: Number.MAX_VALUE })]);
	const result = projectRecordedUsage([recordedHandle("h-overflow", 1, [{ episode: 1, observation }])]);
	assert.equal(result.usage.input, null);
	assert.equal(result.metrics.input, "unavailable");
	assert.equal(result.assistantTurns, 2);
	assert.equal(result.turnsCoverage, "complete");
	assert.equal(result.status, "incomplete");
});

test("recorded usage projection sums exact turns and tokens across handles beyond admission limits", () => {
	const first = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1))), through("a1"));
	const second = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1)), message("u2", "a1", "user"), assistant("a2", "u2", usage(5, 0.5, { output: 2, totalTokens: 7 })), { type: "compaction", id: "c1", parentId: "a2", summary: "tail", firstKeptEntryId: "u2", usage: usage(1, 0.25, { output: 0, totalTokens: 1 }) }), through("c1", "a1"));
	const other = collectNativeObservation(jsonl(session("n2"), message("v1", null, "user"), assistant("b1", "v1", usage(3, 2, { output: 4, totalTokens: 6 }))), through("b1"));
	// More handles than the open-session admission limit; history size is not capped by it.
	const inputs = [recordedHandle("h1", 2, [{ episode: 1, observation: first }, { episode: 2, observation: second }]), recordedHandle("h2", 1, [{ episode: 1, observation: other }]),
		...Array.from({ length: 10 }, (_, index) => recordedHandle(`idle-${index}`, 0, []))];
	const result = projectRecordedUsage(inputs);
	assert.equal(result.status, "complete");
	assert.deepEqual(result.usage, { input: 19, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: 3.75 });
	assert.equal(result.assistantTurns, 3);
	assert.deepEqual(result.episodes, { recorded: 3, missing: 0, orphaned: 0, unprovable: false });
	assert.deepEqual(result.metrics, { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete", totalTokens: "complete", cost: "complete" });
	assert.equal(result.turnsCoverage, "complete");
	assert.equal(result.conflicts, 0);
});

test("replayed overlap, duplicate sources and repartitioned inputs keep one billing identity", () => {
	const first = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1))), through("a1"));
	const reread = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1)), message("u2", "a1", "user"), assistant("a2", "u2", usage(5, 0.5))), through("a2"));
	const other = collectNativeObservation(jsonl(session("n2"), message("v1", null, "user"), assistant("b1", "v1", usage(3, 2))), through("b1"));
	const withOverlap = projectRecordedUsage([recordedHandle("h1", 2, [{ episode: 1, observation: first }, { episode: 2, observation: reread }, { episode: 1, observation: first }]), recordedHandle("h2", 1, [{ episode: 1, observation: other }])]);
	const without = projectRecordedUsage([recordedHandle("h1", 2, [{ episode: 1, observation: first }, { episode: 2, observation: reread }]), recordedHandle("h2", 1, [{ episode: 1, observation: other }])]);
	assert.deepEqual(withOverlap.usage, without.usage);
	assert.equal(withOverlap.assistantTurns, without.assistantTurns);
	assert.equal(withOverlap.conflicts, 0);
	assert.deepEqual(withOverlap.usage, { input: 18, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 21, cost: 3.5 });
	// Partitioning the same evidence never manufactures a new billing identity.
	const partOne = projectRecordedUsage([recordedHandle("h1", 2, [{ episode: 1, observation: first }, { episode: 2, observation: reread }])]);
	const partTwo = projectRecordedUsage([recordedHandle("h2", 1, [{ episode: 1, observation: other }])]);
	const add = (left: ObservedUsage, right: ObservedUsage): ObservedUsage => ({ input: left.input! + right.input!, output: left.output! + right.output!, cacheRead: left.cacheRead! + right.cacheRead!, cacheWrite: left.cacheWrite! + right.cacheWrite!, totalTokens: left.totalTokens! + right.totalTokens!, cost: left.cost! + right.cost! });
	assert.deepEqual(add(partOne.usage, partTwo.usage), without.usage);
	assert.equal(partOne.assistantTurns! + partTwo.assistantTurns!, without.assistantTurns);
	assert.equal(partOne.status, "complete"); assert.equal(partTwo.status, "complete");
});

test("conflicting duplicate native identities make the whole projection explicitly unavailable", () => {
	const good = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(3, 1))), through("a1"));
	const conflict = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(3, 2))), through("a1"));
	const result = projectRecordedUsage([recordedHandle("h1", 2, [{ episode: 1, observation: good }, { episode: 2, observation: conflict }])]);
	assert.equal(result.status, "unavailable");
	assert.equal(result.reason, "conflicting-rows");
	assert.equal(result.conflicts, 1);
	assert.deepEqual(result.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.equal(result.assistantTurns, null);
	assert.equal(result.turnsCoverage, "unavailable");
	assert.deepEqual(Object.values(result.metrics).every((value) => value === "unavailable"), true);
});

test("missing observations keep the labeled known subtotal and never fabricate zero totals", () => {
	const first = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1))), through("a1"));
	const second = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1)), message("u2", "a1", "user"), assistant("a2", "u2", usage(5, 0.5))), through("a2", "a1"));
	const result = projectRecordedUsage([recordedHandle("h1", 3, [{ episode: 1, observation: first }, { episode: 2, observation: second }])]);
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.episodes, { recorded: 2, missing: 1, orphaned: 0, unprovable: false });
	assert.deepEqual(result.usage, { input: 15, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: 1.5 });
	assert.equal(result.assistantTurns, 2);
	assert.equal(result.metrics.input, "incomplete");
	assert.equal(result.metrics.cost, "incomplete");
	assert.equal(result.turnsCoverage, "incomplete");
	// No recorded evidence at all is unavailable, not a free zero total.
	const none = projectRecordedUsage([recordedHandle("h2", 1, [])]);
	assert.equal(none.status, "unavailable");
	assert.deepEqual(none.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.equal(none.assistantTurns, null);
	assert.deepEqual(none.episodes, { recorded: 0, missing: 1, orphaned: 0, unprovable: false });
	// A degraded handle never hides a valid recorded row.
	const mixed = projectRecordedUsage([recordedHandle("h1", 3, [{ episode: 1, observation: first }, { episode: 2, observation: second }]), recordedHandle("h2", 1, [])]);
	assert.deepEqual(mixed.usage, { input: 15, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: 1.5 });
	assert.equal(mixed.assistantTurns, 2);
	assert.equal(mixed.metrics.input, "incomplete");
});

test("null usage fields stay unknown instead of turning into zeros or complete totals", () => {
	const partial = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", { input: 3 })), through("a1"));
	const result = projectRecordedUsage([recordedHandle("h1", 1, [{ episode: 1, observation: partial }])]);
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.usage, { input: 3, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.equal(result.assistantTurns, 1);
	assert.equal(result.metrics.input, "complete");
	assert.equal(result.metrics.cost, "unavailable");
	assert.equal(result.turnsCoverage, "complete");
	const withMissing = projectRecordedUsage([recordedHandle("h2", 2, [{ episode: 1, observation: partial }])]);
	assert.equal(withMissing.metrics.input, "incomplete");
	assert.deepEqual(withMissing.usage.input, 3);
	assert.equal(withMissing.usage.cost, null);
});

test("copied fork prefixes and unavailable observations stay unbilled missing evidence", () => {
	const fork = collectNativeObservation(jsonl({ ...session("n9"), parentSession: "origin" }, message("u1", null, "user"), assistant("a1", "u1", usage(3, 1))), none);
	assert.equal(fork.available, false);
	const result = projectRecordedUsage([recordedHandle("h1", 1, [{ episode: 1, observation: fork }]), recordedHandle("h2", 1, [{ episode: 1, observation: unavailableObservation() }])]);
	assert.equal(result.status, "unavailable");
	assert.deepEqual(result.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null });
	assert.equal(result.assistantTurns, null);
	assert.deepEqual(result.episodes, { recorded: 0, missing: 2, orphaned: 0, unprovable: false });
	assert.equal(result.metrics.input, "unavailable");
});

test("unprovable episode counts and orphaned observations degrade coverage without dropping rows", () => {
	const first = collectNativeObservation(jsonl(session("n1"), message("u1", null, "user"), assistant("a1", "u1", usage(10, 1))), through("a1"));
	const legacy = projectRecordedUsage([recordedHandle("h1", null, [{ episode: 1, observation: first }])]);
	assert.equal(legacy.status, "incomplete");
	assert.deepEqual(legacy.episodes, { recorded: 1, missing: 0, orphaned: 0, unprovable: true });
	assert.equal(legacy.usage.input, 10);
	assert.equal(legacy.metrics.input, "incomplete");
	const orphaned = projectRecordedUsage([recordedHandle("h2", 1, [{ episode: 1, observation: first }, { episode: 2, observation: first }])]);
	assert.equal(orphaned.status, "incomplete");
	assert.deepEqual(orphaned.episodes, { recorded: 2, missing: 0, orphaned: 1, unprovable: false });
	assert.equal(orphaned.usage.input, 10);
	assert.equal(orphaned.assistantTurns, 1);
});

test("recorded usage inputs are validated per observation and bounded rows fail explicitly", () => {
	assert.equal(projectRecordedUsage(undefined as unknown as Parameters<typeof projectRecordedUsage>[0]).reason, "invalid-input");
	assert.equal(projectRecordedUsage([{ handle: "bad handle", expectedEpisodes: 0, episodes: [] }]).reason, "invalid-input");
	assert.equal(projectRecordedUsage([{ handle: "h1", expectedEpisodes: MANAGED_LIMITS.maxEpisodes + 1, episodes: [] }]).reason, "invalid-input");
	assert.equal(projectRecordedUsage([{ handle: "h1", expectedEpisodes: 1, episodes: [{ episode: 0, observation: idleObservation }] }]).reason, "invalid-input");
	assert.equal(projectRecordedUsage([{ handle: "h1", expectedEpisodes: 1, episodes: [{ episode: 1, observation: {} as NativeObservation }] }]).reason, "invalid-input");
	const half = Array.from({ length: 60_000 }, (_, index) => row("n1", `e${index}`, { input: 1 }));
	const budget = projectRecordedUsage([recordedHandle("h1", 1, [{ episode: 1, observation: syntheticObservation("n1", half) }]), recordedHandle("h2", 1, [{ episode: 1, observation: syntheticObservation("n2", half.map((entry) => ({ ...entry, ownerSessionId: "n2" }))) }])]);
	assert.equal(budget.status, "unavailable");
	assert.equal(budget.reason, "row-budget");
	assert.equal(budget.metrics.cost, "unavailable");
	assert.equal(budget.assistantTurns, null);
});
