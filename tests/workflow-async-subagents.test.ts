import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow from "../extensions/workflow/index.ts";
import { SUBAGENT_EXECUTION_EVENT, type SubagentExecutionEvent } from "../extensions/shared/subagent-execution.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import type { GoalState } from "../extensions/workflow/goal-contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness } from "./fixtures/workflow/host-fixture.ts";
const call = (args: unknown) => fauxAssistantMessage(fauxToolCall("csheng_workflow", args as never));
const enroll = () => call({ operation: "enroll", goal: "Async source work", delivery: "source", authority: "fixture user", requirements: [{ key: "r", outcome: "result", verification: "host evidence" }], tasks: [{ key: "t", title: "Implement", covers: ["r"] }] });
const start = () => call({ operation: "start", task: "t", scope: ["source"] });
const submit = () => fauxAssistantMessage(fauxToolCall("csheng_subagent_sessions", { action: "create" } as never));
const state = (h: HostHarness): GoalState => (h.session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "csheng-workflow-state") as { data: { state: GoalState } }).data.state;
function transport(early: boolean, finalizationFailed = false) {
 let send!: (wake?: boolean, foreign?: boolean) => void;
 let terminal: SubagentExecutionEvent | undefined;
 const extension = (pi: ExtensionAPI) => {
  pi.registerTool({ name: "csheng_subagent_sessions", label: "fixture transport", description: "offline receipt/event oracle", parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("inspect"), Type.Literal("join")]) }),
   async execute(id, args, _signal, _update, ctx) {
    if (args.action !== "create") return { content: [{ type: "text", text: "historical outcome" }], details: { schemaVersion: 3, action: args.action, status: "succeeded", kind: "execution", runId: "run", sessions: terminal!.sessions } };
    const view = { handle: "handle", episode: 1, role: "worker" as const, state: "queued" as const, reportComplete: false };
    const event: SubagentExecutionEvent = { version: 3, eventId: "terminal", kind: "task-terminal", runId: "run", generation: "generation", owner: { repository: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), branchAnchor: ctx.sessionManager.getLeafId() }, toolCallId: id,
     sessions: [{ ...view, state: finalizationFailed ? "interrupted" : "idle", reportComplete: true, result: { id: "task", role: "worker", status: finalizationFailed ? "failed" : "succeeded", ...(finalizationFailed ? { executionStatus: "succeeded" as const, finalization: { status: "failed" as const, stage: "result-save" as const, code: "result_persistence_failed" } } : {}), output: "unreviewed child result", stderr: "", durationMs: 1, usage: emptyUsage(), changedPaths: finalizationFailed ? [] : ["dynamic/new-file"], convergence: "not-applied" } }],
    };
    terminal = event;
    send = (wake = false, foreign = false) => {
     const value = foreign ? { ...event, eventId: "foreign", owner: { ...event.owner, sessionId: "different-owner" } } : event;
     pi.appendEntry(SUBAGENT_EXECUTION_EVENT, value); pi.events.emit(SUBAGENT_EXECUTION_EVENT, value);
     if (wake) pi.sendMessage({ customType: SUBAGENT_EXECUTION_EVENT, content: "Terminal execution evidence is ready; decide explicitly.", display: false, details: { eventIds: [value.eventId] } }, { triggerTurn: true, deliverAs: "followUp" });
    };
    if (early) { send(); send(); }
    return { content: [{ type: "text", text: "accepted, not completed" }], details: { schemaVersion: 3, action: "create", kind: "submission", status: "accepted", runId: "run", sessions: [view] } };
   },
  });
 };
 return { extension, send: (wake = false, foreign = false) => send(wake, foreign) };
}

test("successful child execution with failed finalization cannot certify workflow completion", async t => {
 const fake = transport(true, true), trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, fake.extension, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), start(), submit(), call({ operation: "report", summary: "Child ran but finalization failed", facts: [{ key: "check", kind: "host", check: "terminal outcome", result: "pass", observationId: "terminal" }], judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ subject, accepted: true, facts: ["check"], rationale: "Cannot certify failed finalization" })), complete: true }), call({ operation: "close", outcome: "cancelled", reason: "fixture ends" }), fauxAssistantMessage("done")]);
 await h.session.prompt("implement");
 assert.equal(state(h).facts[0]?.usable, false); assert.equal(state(h).acceptance.length, 0); assert.equal(state(h).fulfillment, "cancelled"); assert.deepEqual(h.errors, []);
});

test("late terminal evidence remains bound to dispatch attempt; waiting neither spins nor accepts and only executor wakes", async t => {
 const trace = createTrace(), fake = transport(false);
 const h = await createHostHarness({ trace, extensions: [workflow, fake.extension, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), start(), submit(), call({ operation: "report", attempt: "A1", summary: "Submission is pending, not verified" }), start(), fauxAssistantMessage("Waiting; no independent ready work."),
  call({ operation: "report", attempt: "A2", summary: "Check that late result cannot prove newer attempt", facts: [{ key: "late", kind: "host", check: "child outcome", result: "pass", observationId: "terminal" }] }),
  call({ operation: "report", attempt: "A1", summary: "Original dispatch evidence is available but not accepted", facts: [{ key: "original", kind: "host", check: "child outcome", result: "pass", observationId: "terminal" }] }),
  call({ operation: "close", outcome: "cancelled", reason: "fixture ends without semantic acceptance" }), fauxAssistantMessage("done")]);
 await h.session.prompt("implement"); await waitForTrace(trace, () => state(h).continuation.state === "waiting");
 assert.equal(h.faux.state.callCount, 6); assert.equal(state(h).continuation.dispatched, 0); assert.equal(state(h).continuation.repeat, 0); assert.equal(state(h).fulfillment, "pending"); assert.deepEqual(state(h).executionPending, ["run"]);
 const bindings = h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "csheng-workflow-execution-binding"); assert.equal(bindings.length, 1);
 fake.send(false, true); assert.equal(state(h).continuation.state, "waiting", "another owner cannot resolve waiting");
 fake.send(true);
 await waitForTrace(trace, () => state(h).fulfillment === "cancelled"); await waitForTrace(trace, () => h.faux.state.callCount === 10);
 assert.equal(state(h).facts.find(fact => fact.id === "A2:late")?.usable, false);
 assert.equal(state(h).facts.find(fact => fact.id === "A1:original")?.usable, true);
 assert.equal(state(h).input.generation, 0, "trusted transport is not new user intent"); assert.equal(state(h).continuation.dispatched, 0); assert.deepEqual(state(h).executionPending, []); assert.deepEqual(h.errors, []);
});

test("execution-bearing inspect and join cannot promote historical results into a newer attempt", async t => {
 const fake = transport(true), trace = createTrace(); let queryId = "";
 const observer = (pi: ExtensionAPI) => { pi.on("tool_execution_end", event => { if (event.toolName === "csheng_subagent_sessions") queryId = event.toolCallId; }); };
 const h = await createHostHarness({ trace, extensions: [workflow, fake.extension, observer, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), start(), submit(), call({ operation: "report", summary: "Original dispatch finished" }), start(),
  fauxAssistantMessage(fauxToolCall("csheng_subagent_sessions", { action: "inspect" } as never)),
  () => call({ operation: "report", attempt: "A2", summary: "Inspection is not re-execution", facts: [{ key: "inspect", kind: "host", check: "old result", result: "pass", observationId: queryId }] }),
  fauxAssistantMessage(fauxToolCall("csheng_subagent_sessions", { action: "join" } as never)),
  () => call({ operation: "report", attempt: "A2", summary: "Joining is not re-execution", facts: [{ key: "join", kind: "host", check: "old result", result: "pass", observationId: queryId }] }),
  call({ operation: "close", outcome: "cancelled", reason: "fixture only" }), fauxAssistantMessage("done")]);
 await h.session.prompt("implement"); assert.equal(state(h).facts.length, 2); assert.ok(state(h).facts.every(fact => !fact.usable)); assert.deepEqual(h.errors, []);
});

test("execution query captures cannot cross close and re-enrollment with reused A1 and generation zero", async t => {
 const fake = transport(true), trace = createTrace(); let queryId = "";
 const observer = (pi: ExtensionAPI) => { pi.on("tool_execution_end", event => { if (event.toolName === "csheng_subagent_sessions") queryId = event.toolCallId; }); };
 const h = await createHostHarness({ trace, extensions: [workflow, fake.extension, observer, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), start(), submit(), call({ operation: "close", outcome: "cancelled", reason: "end original contract" }), enroll(), start(),
  fauxAssistantMessage(fauxToolCall("csheng_subagent_sessions", { action: "join" } as never)),
  () => call({ operation: "report", attempt: "A1", summary: "Different contract, not new execution", facts: [{ key: "old", kind: "host", check: "old result", result: "pass", observationId: queryId }] }),
  call({ operation: "close", outcome: "cancelled", reason: "fixture only" }), fauxAssistantMessage("done")]);
 await h.session.prompt("implement"); assert.equal(state(h).facts.length, 1); assert.equal(state(h).facts[0]!.usable, false); assert.deepEqual(h.errors, []);
});

test("new aligned input does not strand old terminal bookkeeping or relabel its evidence generation", async t => {
 const fake = transport(false), trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, fake.extension, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), start(), submit(), fauxAssistantMessage("waiting")]);
 await h.session.prompt("implement"); await waitForTrace(trace, () => state(h).continuation.state === "waiting");
 h.faux.setResponses([call({ operation: "amend", reason: "clarification", authority: "same scope", alignment: "No scope or authority change" }), fauxAssistantMessage("still waiting")]);
 await h.session.prompt("same scope, preserve pending child"); assert.equal(state(h).input.generation, 1); assert.deepEqual(state(h).executionPending, ["run"]);
 h.faux.setResponses([call({ operation: "report", attempt: "A1", summary: "Old dispatch remains old evidence", facts: [{ key: "old", kind: "host", check: "original outcome", result: "pass", observationId: "terminal" }] }), call({ operation: "close", outcome: "cancelled", reason: "fixture only" }), fauxAssistantMessage("done")]);
 fake.send(true); await waitForTrace(trace, () => state(h).fulfillment === "cancelled");
 assert.deepEqual(state(h).executionPending, []); assert.equal(state(h).facts[0]?.generation, 0); assert.deepEqual(h.errors, []);
});

test("terminal-before-receipt and duplicate events reconcile without rebinding, polling or acceptance", async t => {
 const fake = transport(true), trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, fake.extension, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), start(), submit(), call({ operation: "report", summary: "Original terminal observation", facts: [{ key: "check", kind: "host", check: "terminal", result: "pass", observationId: "terminal" }] }), call({ operation: "close", outcome: "cancelled", reason: "no automatic acceptance" }), fauxAssistantMessage("done")]);
 await h.session.prompt("implement"); assert.equal(state(h).facts.length, 1); assert.equal(state(h).facts[0]!.usable, true); assert.deepEqual(state(h).executionPending, undefined); assert.equal(state(h).continuation.dispatched, 0); assert.equal(state(h).acceptance.length, 0); assert.equal(state(h).input.generation, 0); assert.deepEqual(h.errors, []);
});
