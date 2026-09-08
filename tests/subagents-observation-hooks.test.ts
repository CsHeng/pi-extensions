import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAME, type RunTelemetry } from "../extensions/subagents/contracts.ts";
import { registerObservationHooks } from "../extensions/subagents/observation-hooks.ts";
import { isLocalTiming } from "../extensions/subagents/telemetry.ts";

function harness(child = false, now: () => number = () => performance.now()) {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const customs: Array<{ customType: string; data: any }> = [];
	const entries: any[] = [{ id: "root", type: "message", parentId: null, message: { role: "user" } }];
	let tools = [SUBAGENT_TOOL_NAME];
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getActiveTools: () => tools,
		setTools: (value: string[]) => { tools = value; },
		appendEntry(customType: string, data: unknown) {
			customs.push({ customType, data }); entries.push({ type: "custom", id: `custom${customs.length}`, parentId: entries.at(-1)?.id ?? null, customType, data });
		},
	};
	const ctx = { model: { contextWindow: 128000 }, sessionManager: { getHeader: (): unknown => ({ type: "session", version: 3, id: "owner" }), getEntries: () => entries, getLeafId: () => "root" } };
	const api = registerObservationHooks(pi as unknown as ExtensionAPI, { child, now });
	// Pi's public callback order is (event, context). SessionManager is read-only.
	const emit = (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
	return { api, emit, customs, entries, pi, ctx };
}
const assistant = { message: { role: "assistant", content: [] } };
const thinking = (type: string, contentIndex: number) => ({ assistantMessageEvent: { type, contentIndex } });
const tool = (toolName = SUBAGENT_TOOL_NAME, toolCallId = "call") => ({ toolName, toolCallId });
const run: RunTelemetry = { schemaVersion: 4, runId: "run", runDurationMs: 1, requestedTasks: 1, admittedTasks: 1, launchedChildren: 1, peakConcurrency: 1, peakConcurrencyByRole: { explorer: 0, reviewer: 0, worker: 1 } };

test("public child hooks capture model, overlapping thinking, tool and compaction endpoints", () => {
	let time = 0; const f = harness(true, () => ++time);
	f.emit("before_agent_start"); f.emit("message_start", assistant);
	f.emit("message_update", thinking("thinking_start", 0)); f.emit("message_update", thinking("thinking_start", 1));
	f.emit("message_update", thinking("thinking_end", 0)); f.emit("message_update", thinking("thinking_end", 1)); f.emit("message_end", assistant);
	f.emit("message_end", { message: { role: "toolResult" } });
	f.emit("tool_execution_start", tool("read")); f.emit("tool_execution_end", tool("read"));
	f.emit("session_before_compact"); f.emit("session_compact"); f.emit("agent_settled");
	assert.equal(f.customs[0]!.customType, "csheng-episode-observation");
	const timing = f.customs.at(-1)!.data; assert.equal(isLocalTiming(timing), true); assert.equal(timing.complete, true);
	assert.equal(timing.spans.assistant.length, 1); assert.equal(timing.spans.reasoning.length, 2);
	assert.equal(timing.spans.localTool.length, 1); assert.equal(timing.spans.compaction.length, 1);
});

test("missing, duplicate, invalid-clock and oversized identities remain incomplete", () => {
	for (const mode of ["missing", "duplicate", "clock", "bounded"]) {
		let count = 0; const f = harness(true, () => mode === "clock" ? 100 - count++ : count++);
		f.emit("before_agent_start");
		if (mode === "missing") f.emit("message_end", assistant);
		else if (mode === "bounded") f.emit("tool_execution_start", tool("read", "x".repeat(200)));
		else { f.emit("message_start", assistant); if (mode === "duplicate") f.emit("message_start", assistant); f.emit("message_end", assistant); }
		f.emit("agent_settled"); assert.equal(f.customs.at(-1)!.data.complete, false);
	}
});

test("shutdown never invents a completed interaction, including closed local spans", () => {
	const f = harness(true); f.emit("before_agent_start"); f.emit("message_start", assistant); f.emit("message_end", assistant); f.emit("session_shutdown");
	assert.equal(f.customs.at(-1)!.data.complete, false);
});

test("compaction failure closes its observed span but never copies error text", () => {
	const f = harness(true); f.emit("session_before_compact");
	f.emit("session_compact_failed", { reason: "overflow", aborted: true, errorMessage: "SECRET" }); f.emit("agent_settled");
	assert.deepEqual(f.customs[0]!.data, { reason: "overflow", aborted: true }); assert.doesNotMatch(JSON.stringify(f.customs), /SECRET/);
	assert.equal(f.customs.at(-1)!.data.complete, true);
});

test("failed parent compaction has unknown usage even when it precedes delegation", () => {
	const f = harness(); f.emit("before_agent_start"); f.emit("session_before_compact");
	f.emit("session_compact_failed", { reason: "threshold", aborted: false, errorMessage: "SECRET" });
	assert.equal(f.customs.length, 0, "do not write parent diagnostics before an actual delegation");
	f.emit("tool_execution_start", tool()); f.emit("tool_execution_end", tool()); f.emit("agent_settled");
	const observation = f.customs.find((entry) => entry.customType === "csheng-parent-observation")!.data;
	assert.equal(observation.native.usage.cost, null); assert.equal(observation.native.entries[0].kind, "compaction");
	assert.equal(observation.timing.complete, true); assert.doesNotMatch(JSON.stringify(f.customs), /SECRET/);
});

test("missing thinking start and a lost compaction usage marker cannot look complete", () => {
	const f = harness(true); f.emit("before_agent_start"); f.emit("message_start", assistant);
	f.emit("message_update", thinking("thinking_delta", 0)); f.emit("message_end", assistant); f.emit("agent_settled");
	assert.equal(f.customs.at(-1)!.data.complete, false);
	const doneOnly = harness(true); doneOnly.emit("before_agent_start"); doneOnly.emit("message_start", assistant);
	doneOnly.emit("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }] } }); doneOnly.emit("agent_settled");
	assert.equal(doneOnly.customs.at(-1)!.data.complete, false);
	assert.deepEqual(doneOnly.customs.at(-1)!.data.spans.reasoning, []);
	const failed = harness(true); const append = failed.pi.appendEntry;
	failed.pi.appendEntry = (type, data) => { if (type === "csheng-compaction-unavailable") throw new Error("optional"); append(type, data); };
	failed.emit("before_agent_start"); failed.emit("session_before_compact"); failed.emit("session_compact_failed", { reason: "overflow", aborted: true }); failed.emit("agent_settled");
	assert.equal(failed.customs.some((entry) => entry.customType === "csheng-episode-timing"), false);
});

test("ordinary parent requests, idle shutdown and disabled tools write nothing", () => {
	const f = harness(); f.emit("session_shutdown"); f.emit("before_agent_start"); f.emit("tool_execution_start", tool("read")); f.emit("tool_execution_end", tool("read")); f.emit("agent_settled");
	assert.equal(f.customs.length, 0);
	f.emit("before_agent_start"); f.emit("tool_execution_start", tool()); f.emit("tool_execution_end", tool()); f.pi.setTools([]); f.emit("agent_settled");
	assert.equal(f.customs.length, 0);
});

test("parent owns only newly appended direct usage, not old tree-branch or nested child totals", () => {
	const f = harness();
	const message = (id: string, parentId: string, input: number) => ({ type: "message", id, parentId, message: { role: "assistant", usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: 1 } } });
	f.entries.push(message("old", "root", 99)); f.emit("before_agent_start");
	f.emit("tool_execution_start", tool()); f.api.recordRun({ telemetry: run, clockKey: "clock", originMs: 1 }); f.emit("tool_execution_end", tool());
	f.entries.push({ type: "message", id: "nested", parentId: "old", message: { role: "toolResult", details: { usage: { input: 999 } } } }, message("new", "root", 2));
	f.emit("agent_settled"); const data = f.customs[0]!.data;
	assert.equal(data.native.usage.input, 2); assert.equal(data.runs.length, 1); assert.equal(data.timing.spans.delegationWait.length, 1);
});

test("excess runs, unavailable context and optional persistence failure stay bounded", () => {
	const f = harness(); f.emit("before_agent_start"); f.emit("tool_execution_start", tool());
	for (let index = 0; index < 40; index++) f.api.recordRun({ telemetry: run, clockKey: "clock", originMs: 1 });
	f.emit("tool_execution_end", tool()); f.ctx.sessionManager.getHeader = () => { throw new Error("SECRET"); }; f.emit("agent_settled");
	assert.equal(f.customs[0]!.data.runs.length, 32); assert.equal(f.customs[0]!.data.timing.complete, false); assert.equal(f.customs[0]!.data.native.available, false);
	const broken = harness(true); broken.pi.appendEntry = () => { throw new Error("disk unavailable"); };
	assert.doesNotThrow(() => { broken.emit("before_agent_start"); broken.emit("agent_settled"); });
});
