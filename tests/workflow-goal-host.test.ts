import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import loopNotifications from "../extensions/loop-notifications/index.ts";
import workflow from "../extensions/workflow/index.ts";
import type { GoalState } from "../extensions/workflow/goal-contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness, type Trace } from "./fixtures/workflow/host-fixture.ts";
const call = (args: unknown) => fauxAssistantMessage(fauxToolCall("csheng_workflow", args as never));
const start = () => call({ operation: "set", goal: "Useful work", tasks: [{ id: "t", title: "Implement" }] });
const state = (h: HostHarness): GoalState => (h.session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "csheng-workflow-state") as { data: { state: GoalState } }).data.state;
for (const mode of ["tui", "rpc", "print", "json"] as const) test("ordinary " + mode + " work does not create tracking or continuation", async t => {
 const h = await createHostHarness({ mode, extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([fauxAssistantMessage("Answer.")]); await h.session.prompt("explain");
 assert.equal(h.faux.state.callCount, 1);
 assert.equal(h.session.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "csheng-workflow-state"), false);
 assert.deepEqual(h.errors, []);
});
test("main directly marks done, independently of checks, reviews or Skills", async t => {
 const h = await createHostHarness({ extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")]);
 await h.session.prompt("implement");
 assert.equal(state(h).tasks[0]!.status, "done"); assert.equal(h.faux.state.callCount, 3); assert.deepEqual(h.errors, []);
});
test("unchanged task list gets one reminder; new input needs no alignment protocol", async t => {
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, loopNotifications, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), fauxAssistantMessage("Paused accidentally"), fauxAssistantMessage("Still unchanged")]);
 await h.session.prompt("implement");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 2);
 assert.equal(h.faux.state.callCount, 3); assert.equal(state(h).tasks[0]!.status, "todo");
 h.faux.setResponses([call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")]);
 await h.session.prompt("finish the same work"); assert.equal(state(h).tasks[0]!.status, "done"); assert.deepEqual(h.errors, []);
});
test("context contains one bounded current task projection across repeated preparations", async t => {
 const projections: string[][] = [];
 const observer = (pi: ExtensionAPI) => { pi.on("context", event => {
  projections.push(event.messages.flatMap(m => m.role === "custom" && m.customType === "csheng-workflow-tasks" ? [String(m.content)] : []));
 }); };
 const h = await createHostHarness({ mode: "print", extensions: [workflow, observer] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")]);
 await h.session.prompt("implement");
 assert.ok(projections.every(items => items.length <= 1));
 assert.match(projections.at(-1)![0]!, /\[done\] Implement/); assert.deepEqual(h.errors, []);
});
test("blocked tasks do not spin and cancellation remains terminal", async t => {
 const h = await createHostHarness({ extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "blocked", note: "Waiting for user input" }] }), fauxAssistantMessage("Blocked")]);
 await h.session.prompt("implement"); assert.equal(h.faux.state.callCount, 3);
 h.faux.setResponses([call({ operation: "cancel", reason: "User cancellation" }), fauxAssistantMessage("Cancelled")]);
 await h.session.prompt("cancel"); assert.equal(state(h).cancelled, true); assert.equal(state(h).tasks[0]!.status, "cancelled");
 assert.deepEqual(h.errors, []);
});
const transient = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: synthetic transient" });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const extensionFollowUps = (trace: Trace) => trace.entries.filter(entry => entry.event === "input" && entry.detail?.source === "extension");
const workflowCalls = (trace: Trace) => trace.entries.flatMap(entry => entry.event === "workflow-call" && entry.detail ? [entry.detail] : []);
const watchWorkflowCalls = (trace: Trace) => (pi: ExtensionAPI) => {
 pi.on("tool_execution_end", (event, ctx) => {
  if (event.toolName !== "csheng_workflow") return;
  const details = (event.result as { details?: { ok?: boolean } } | undefined)?.details;
  trace.record("workflow-call", { ok: event.isError === false && details?.ok === true, live: ctx.signal?.aborted === false });
 });
};
const holdForAbort = (trace: Trace) => (pi: ExtensionAPI) => {
 pi.registerTool({
  name: "wf_hold", label: "Hold", description: "Fixture gate released when the host aborts the tool signal.",
  parameters: Type.Object({}),
  async execute(_id, _params, signal) {
   trace.record("hold:started", { aborted: signal?.aborted === true });
   await new Promise<void>(resolve => {
    if (!signal || signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, 2000);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
   });
   trace.record("hold:finished", { aborted: signal?.aborted === true });
   return { content: [{ type: "text", text: "released" }], details: { aborted: signal?.aborted === true } };
  },
 });
};
test("one provider retry still accepts update, resume and cancel, and cancelled work stays distinct from done", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, watchWorkflowCalls(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call({ operation: "set", goal: "Useful work", tasks: [{ id: "keep", title: "Keep", status: "doing" }, { id: "drop", title: "Drop" }] }),
  transient(),
  fauxAssistantMessage([
   fauxToolCall("csheng_workflow", { operation: "update", tasks: [{ id: "keep", status: "done" }] }),
   fauxToolCall("csheng_workflow", { operation: "resume" }),
   fauxToolCall("csheng_workflow", { operation: "cancel", reason: "Remaining work is no longer wanted" }),
  ]),
  fauxAssistantMessage("Stopped"),
  fauxAssistantMessage("must-not-run"),
 ]);
 await h.session.prompt("recover tracking");
 const calls = workflowCalls(trace);
 assert.equal(calls.length, 4);
 assert.deepEqual(calls.slice(1), [
  { ok: true, live: true },
  { ok: true, live: true },
  { ok: true, live: true },
 ]);
 const current = state(h);
 assert.equal(current.cancelled, true);
 assert.equal(current.paused, false);
 assert.equal(current.tasks.find(task => task.id === "keep")?.status, "done");
 assert.equal(current.tasks.find(task => task.id === "drop")?.status, "cancelled");
 assert.notEqual(current.tasks[0]!.status, current.tasks[1]!.status);
 assert.equal(h.faux.state.callCount, 4);
 await pause(250);
 assert.equal(h.faux.state.callCount, 4);
 assert.equal(extensionFollowUps(trace).length, 0);
 assert.deepEqual(h.errors, []);
});
test("recovered provider stop leaves unfinished work active and sends one bounded reminder", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, loopNotifications, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call({ operation: "set", goal: "Useful work", tasks: [{ id: "t", title: "Implement", status: "doing" }] }),
  transient(),
  fauxAssistantMessage("Recovered"),
  fauxAssistantMessage("Reminder consumed"),
  fauxAssistantMessage("must-not-run"),
 ]);
 await h.session.prompt("recover and continue");
 const current = state(h);
 assert.equal(current.paused, false);
 assert.equal(current.cancelled, false);
 assert.equal(current.tasks[0]!.status, "doing");
 await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length === 2);
 assert.equal(h.faux.state.callCount, 4);
 assert.equal(extensionFollowUps(trace).length, 1);
 await pause(250);
 assert.equal(h.faux.state.callCount, 4);
 assert.equal(extensionFollowUps(trace).length, 1);
 assert.equal(state(h).paused, false);
 assert.equal(state(h).tasks[0]!.status, "doing");
 assert.deepEqual(h.errors, []);
});
test("user abort and tool-signal abort pause unfinished work without an automatic wake", async t => {
 const userTrace = createTrace();
 const user = await createHostHarness({ trace: userTrace, extensions: [workflow, createTraceObserver(userTrace)], tokensPerSecond: 20 });
 t.after(() => user.dispose());
 user.faux.setResponses([start(), fauxAssistantMessage("streaming ".repeat(80)), fauxAssistantMessage("must-not-run")]);
 const userRun = user.session.prompt("abort the run");
 await waitForTrace(userTrace, entry => entry.event === "tool_end" && entry.detail?.toolName === "csheng_workflow");
 await waitForTrace(userTrace, () => userTrace.entries.filter(entry => entry.event === "message_start" && entry.detail?.role === "assistant").length === 2);
 await user.session.abort();
 await userRun;
 assert.equal(state(user).paused, true);
 assert.equal(state(user).cancelled, false);
 assert.equal(state(user).tasks[0]!.status, "todo");
 assert.equal(user.faux.state.callCount, 2);
 await pause(250);
 assert.equal(user.faux.state.callCount, 2);
 assert.equal(extensionFollowUps(userTrace).length, 0);
 assert.deepEqual(user.errors, []);

 const toolTrace = createTrace();
 const tool = await createHostHarness({ trace: toolTrace, extensions: [workflow, holdForAbort(toolTrace), createTraceObserver(toolTrace)] });
 t.after(() => tool.dispose());
 tool.faux.setResponses([start(), fauxAssistantMessage(fauxToolCall("wf_hold", {})), fauxAssistantMessage("must-not-run")]);
 const toolRun = tool.session.prompt("abort the tool");
 await waitForTrace(toolTrace, entry => entry.event === "hold:started");
 await tool.session.abort();
 await toolRun;
 assert.equal(toolTrace.entries.find(entry => entry.event === "hold:finished")?.detail?.aborted, true);
 assert.equal(state(tool).paused, true);
 assert.equal(state(tool).cancelled, false);
 assert.equal(state(tool).tasks[0]!.status, "todo");
 assert.equal(tool.faux.state.callCount, 2);
 await pause(250);
 assert.equal(tool.faux.state.callCount, 2);
 assert.equal(extensionFollowUps(toolTrace).length, 0);
 assert.deepEqual(tool.errors, []);
});
test("a final unrecovered provider error pauses unfinished work without an automatic wake", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), transient(), transient(), fauxAssistantMessage("must-not-run")]);
 await h.session.prompt("exhaust retry");
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(state(h).paused, true);
 assert.equal(state(h).cancelled, false);
 assert.equal(state(h).tasks[0]!.status, "todo");
 await pause(250);
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(extensionFollowUps(trace).length, 0);
 assert.deepEqual(h.errors, []);
});
