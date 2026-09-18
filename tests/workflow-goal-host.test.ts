import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow from "../extensions/workflow/index.ts";
import { hostCheckIdentity } from "../extensions/workflow/goal-host.ts";
import { goalParameters, type GoalState } from "../extensions/workflow/goal-contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness } from "./fixtures/workflow/host-fixture.ts";
const call = (args: unknown) => fauxAssistantMessage(fauxToolCall("csheng_workflow", args as never));
const enroll = () => call({ operation: "enroll", goal: "Authorized implementation", delivery: "source", authority: "user request", requirements: [{ key: "r", outcome: "result", verification: "check" }], tasks: [{ key: "t", title: "Implement", covers: ["r"] }] });
const state = (h: HostHarness): GoalState => (h.session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "csheng-workflow-state") as { data: { state: GoalState } }).data.state;

test("actual provider schema exposes only semantic operations, no revision or batch bookkeeping", () => {
 const schema = JSON.stringify(goalParameters); assert.equal(schema.includes("expectedRevision"), false); assert.equal(schema.includes('"batch"'), false);
 validateToolArguments({ name: "csheng_workflow", parameters: goalParameters } as never, { id: "test", name: "csheng_workflow", type: "toolCall", arguments: { operation: "report", summary: "check failed", facts: [{ key: "c", kind: "agent", check: "test", result: "fail" }] } });
 assert.throws(() => validateToolArguments({ name: "csheng_workflow", parameters: goalParameters } as never, { id: "test", name: "csheng_workflow", type: "toolCall", arguments: { operation: "open", expectedRevision: 0 } }));
});

for (const mode of ["tui", "rpc", "print", "json"] as const) test(`ordinary ${mode} analysis has no enrollment/snapshot/continuation`, async t => {
 const h = await createHostHarness({ mode, extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([fauxAssistantMessage("Analysis only. No implementation contract.")]); await h.session.prompt("explain the project");
 assert.equal(h.faux.state.callCount, 1); assert.equal(h.session.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "csheng-workflow-state"), false);
 assert.deepEqual(h.errors, []);
});

test("host check identity distinguishes actual diagnostics, not call labels or key order", () => {
 assert.equal(hostCheckIdentity("bash", { command: "test", timeout: 5 }, { content: "same" }), hostCheckIdentity("bash", { timeout: 5, command: "test" }, { content: "same" }));
 assert.notEqual(hostCheckIdentity("bash", { command: "test-a" }, { content: "same" }), hostCheckIdentity("bash", { command: "test-b" }, { content: "same" }));
 assert.equal(hostCheckIdentity("bash", { command: "test", timeout: 5 }, { content: "passed in 0.1s", exitCode: 0 }), hostCheckIdentity("bash", { command: "test", timeout: 10 }, { content: "passed in 0.8s", exitCode: 0 }), "timing and unclassified free-form output cannot renew progress");
 assert.notEqual(hostCheckIdentity("bash", { command: "test" }, { exitCode: 1 }), hostCheckIdentity("bash", { command: "test" }, { exitCode: 0 }));
 const managed = (handle: string, episode: number, id: string) => ({ action: "create", status: "succeeded", sessions: [{ handle, episode, role: "worker", state: "idle", reportComplete: true, candidate: { id, status: "prepared", changedPaths: 1, appliedPaths: 0 } }] });
 assert.equal(hostCheckIdentity("csheng_subagent_sessions", { action: "create" }, managed("first", 1, "c1")), hostCheckIdentity("csheng_subagent_sessions", { action: "create" }, managed("second", 2, "c2")), "managed execution IDs are not progress");
 assert.equal(hostCheckIdentity("bash", { command: "x".repeat(70000) }, {}), undefined);
});

test("real host makes three productive continuations on unchanged source and then fulfills", async t => {
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
 const responses = [enroll()];
 for (let i = 1; i <= 4; i++) {
  responses.push(call({ operation: "start", task: "t", scope: ["unchanged-source"] }));
  responses.push(fauxAssistantMessage(fauxToolCall("bash", { command: `printf 'diagnostic-${i}'` } as never)));
  responses.push(call({ operation: "report", summary: `Substantive diagnostic ${i}`, facts: [{ key: "check", kind: "host", check: "same model-authored label", result: "pass" }],
   ...(i === 4 ? { judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ subject, accepted: true, facts: ["A1:check", "A2:check", "A3:check", "check"], rationale: "All four distinct checks verified" })), complete: true } : {}) }));
  responses.push(fauxAssistantMessage(i === 4 ? "complete" : "premature settlement"));
 }
 h.faux.setResponses(responses); await h.session.prompt("implement");
 await waitForTrace(trace, () => state(h).fulfillment === "complete");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 4);
 assert.equal(state(h).continuation.dispatched, 3); assert.equal(state(h).input.generation, 0);
 assert.equal(new Set(state(h).facts.map(f => f.basis.fingerprint)).size, 1, "source never changed");
 assert.equal(new Set(state(h).facts.map(f => f.checkIdentity)).size, 4, "real checks, not prose, established progress");
 assert.equal(h.faux.state.callCount, 17); assert.deepEqual(h.errors, []);
});

test("real host repeated unchanged incomplete settlement suspends without false completion", async t => {
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), fauxAssistantMessage("unfinished"), fauxAssistantMessage("still unfinished"), fauxAssistantMessage("same deficits")]);
 await h.session.prompt("implement");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 3);
 await waitForTrace(trace, () => state(h).continuation.state === "suspended");
 assert.equal(h.faux.state.callCount, 4); assert.equal(state(h).fulfillment, "pending"); assert.equal(state(h).continuation.dispatched, 2); assert.deepEqual(h.errors, []);
});

for (const replace of [false, true]) test(`v2 queued draft ${replace ? "replaced" : "withdrawn"}: only prepared native input aligns`, async t => {
 const trace = createTrace(); const prepared: string[][] = [];
 const observer = (pi: ExtensionAPI) => { pi.on("context", e => { prepared.push(e.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join(""))); }); };
 const h = await createHostHarness({ trace, extensions: [workflow, observer, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.2; echo fixture" } as never)),
  ...(replace ? [call({ operation: "amend", reason: "same goal", authority: "original", alignment: "sent replacement does not change scope" })] : []),
  call({ operation: "close", outcome: "cancelled", reason: "fixture finishes" }), fauxAssistantMessage("cancelled")]);
 const running = h.session.prompt("implement"); await waitForTrace(trace, e => e.event === "tool_start" && e.detail?.toolName === "bash");
 const before = structuredClone(state(h)); await h.session.prompt("withdrawn", { streamingBehavior: "followUp" });
 assert.deepEqual(state(h), before); assert.deepEqual(h.session.clearQueue().followUp, ["withdrawn"]);
 if (replace) await h.session.prompt("replacement", { streamingBehavior: "steer" });
 await running;
 assert.equal(prepared.some(p => p.includes("withdrawn")), false); assert.equal(prepared.some(p => p.includes("replacement")), replace);
 assert.equal(state(h).input.generation, replace ? 1 : 0); assert.equal(state(h).input.unknown, replace);
 assert.equal(state(h).fulfillment, "cancelled"); assert.deepEqual(h.errors, []);
});

for (const commandWait of [false, true]) test(`v2 unavailable continuation is suspended, not fulfillment (${commandWait ? "print" : "unarmed SDK"})`, async t => {
 const h = await createHostHarness({ mode: commandWait ? "print" : "rpc", commandWait, extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), fauxAssistantMessage("unfinished")]); await h.session.prompt("implement");
 assert.equal(state(h).fulfillment, "pending"); assert.equal(state(h).continuation.state, "suspended"); assert.equal(state(h).continuation.dispatched, 0);
});

test("real tool observation captures check-time basis after write; report accepts only explicit subjects", async t => {
 let checkId = "";
 const observer = (pi: ExtensionAPI) => { pi.on("tool_execution_end", e => { if (e.toolName === "read") checkId = e.toolCallId; }); };
 const h = await createHostHarness({ mode: "print", extensions: [workflow, observer] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), call({ operation: "start", task: "t", scope: ["result"], writes: ["result"] }),
  fauxAssistantMessage(fauxToolCall("write", { path: "result", content: "verified" } as never)),
  fauxAssistantMessage(fauxToolCall("read", { path: "result" } as never)),
  () => call({ operation: "report", summary: "Read actual changed result", facts: [{ key: "check", kind: "host", check: "read result", result: "pass", observationId: checkId }], judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ subject, accepted: true, facts: ["check"], rationale: "verified" })), complete: true }),
  fauxAssistantMessage("done")]);
 await h.session.prompt("implement"); assert.equal(state(h).fulfillment, "complete"); assert.ok(checkId); assert.deepEqual(h.errors, []);
});
