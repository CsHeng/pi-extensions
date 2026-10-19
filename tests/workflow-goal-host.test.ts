import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
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
for (const mode of ["tui", "rpc"] as const) test(mode + " design awaiting confirmation is not continued by todo/doing tracking or new input", async t => {
 const trace = createTrace(); const h = await createHostHarness({ mode, trace, extensions: [workflow, loopNotifications, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), fauxAssistantMessage("Review this design before I implement it."), fauxAssistantMessage("must-not-run")]);
 await h.session.prompt("discuss the design, do not implement before confirmation");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 1);
 await new Promise(resolve => setTimeout(resolve, 100));
 assert.equal(h.faux.state.callCount, 2); assert.equal(state(h).tasks[0]!.status, "todo");
 assert.equal(extensionFollowUps(trace).length, 0);
 h.faux.setResponses([call({ operation: "update", tasks: [{ id: "t", status: "doing", title: "Revise design" }] }), fauxAssistantMessage("Here is the revised design; please confirm."), fauxAssistantMessage("must-not-run")]);
 await h.session.prompt("revise the design; still do not implement");
 await new Promise(resolve => setTimeout(resolve, 100));
 assert.equal(h.faux.state.callCount, 4); assert.equal(state(h).tasks[0]!.status, "doing");
 assert.equal(extensionFollowUps(trace).length, 0);
 h.faux.setResponses([call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")]);
 await h.session.prompt("now implement the agreed design"); assert.equal(state(h).tasks[0]!.status, "done"); assert.deepEqual(h.errors, []);
});
const noop = () => fauxAssistantMessage(fauxToolCall("wf_noop", {}));
const noopTool = (pi: ExtensionAPI) => { pi.registerTool({
 name: "wf_noop", label: "Noop", description: "Ordinary fixture tool.", parameters: Type.Object({}),
 async execute() { return { content: [{ type: "text", text: "Ordinary result" }], details: {} }; },
}); };
const capture = (inputs: TranscriptContext[], response: AssistantMessage) => (context: TranscriptContext) => {
 inputs.push(structuredClone(context)); return response;
};
const appendOnly = (before: TranscriptContext, after: TranscriptContext) => {
 assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, "the provider's complete previous input remains an unchanged prefix, including prompt and tools");
};
const snapshotEntries = (h: HostHarness) => h.session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "csheng-workflow-tasks");
const inputText = (context: TranscriptContext) => JSON.stringify(context.messages);
const fixedCompaction = (pi: ExtensionAPI) => { pi.on("session_before_compact", (event, ctx) => ({ compaction: {
 summary: "Synthetic background summary without the task list.", firstKeptEntryId: ctx.sessionManager.getLeafId()!, tokensBefore: event.preparation.tokensBefore,
} })); };
test("ordinary task receipts and tools preserve the full provider input prefix without snapshots", async t => {
 const inputs: TranscriptContext[] = [];
 const h = await createHostHarness({ mode: "print", extensions: [workflow, noopTool] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "doing" }] }), noop(), fauxAssistantMessage("In progress")].map(response => capture(inputs, response)));
 await h.session.prompt("implement");
 for (let i = 1; i < inputs.length; i++) appendOnly(inputs[i - 1]!, inputs[i]!);
 assert.equal(snapshotEntries(h).length, 0); assert.deepEqual(h.errors, []);
});
test("recovery snapshot survives provider retries and ordinary tools, then remains historical after resume", async t => {
 const h = await createHostHarness({ mode: "print", extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), fauxAssistantMessage("In progress")]); await h.session.prompt("implement");
 const recovered = await createHostHarness({ mode: "print", sessionManager: h.session.sessionManager, extensions: [workflow, noopTool] }); t.after(() => recovered.dispose());
 assert.equal(recovered.faux.state.callCount, 0, "recovery never starts a task-only turn");
 assert.equal(snapshotEntries(recovered).length, 1);
 const inputs: TranscriptContext[] = [];
 recovered.faux.setResponses([transient(), noop(), fauxAssistantMessage("Investigated")].map(response => capture(inputs, response)));
 await recovered.session.prompt("investigate before resuming");
 assert.equal(inputs.length, 3);
 for (const input of inputs) { assert.match(inputText(input), /\(paused\)/); assert.match(inputText(input), /\[todo\] Implement/); }
 appendOnly(inputs[0]!, inputs[1]!); appendOnly(inputs[1]!, inputs[2]!);
 recovered.faux.setResponses([call({ operation: "resume" }), fauxAssistantMessage("Resumed")].map(response => capture(inputs, response)));
 await recovered.session.prompt("resume");
 appendOnly(inputs[2]!, inputs[3]!); appendOnly(inputs[3]!, inputs[4]!);
 assert.equal(state(recovered).paused, false); assert.equal(snapshotEntries(recovered).length, 1);
 assert.deepEqual(h.errors, []); assert.deepEqual(recovered.errors, []);
});
for (const reason of ["manual", "threshold", "overflow"] as const) test(reason + " compaction preserves a native task snapshot across following tool requests without an extra wake", async t => {
 let h: HostHarness;
 const compactOnce = (pi: ExtensionAPI) => { pi.on("session_compact", () => h.session.setAutoCompactionEnabled(false)); };
 h = await createHostHarness({ mode: "print", extensions: [workflow, noopTool, fixedCompaction, compactOnce], settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: reason === "threshold" ? 1_000_000 : 1024 } } }); t.after(() => h.dispose());
 h.faux.setResponses([start(), fauxAssistantMessage("Ready")]); await h.session.prompt("record work");
 const inputs: TranscriptContext[] = [];
 if (reason === "manual") {
  await h.session.compact();
 } else {
  if (reason === "overflow") h.session.setAutoCompactionEnabled(true);
  const boundary = reason === "overflow" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }) : fauxAssistantMessage("Ready");
  h.faux.setResponses(reason === "overflow" ? [boundary, capture(inputs, noop()), capture(inputs, fauxAssistantMessage("Recovered"))] : [() => {
   // Enable only once this request starts, exercising post-run threshold compaction
   // followed by settlement rather than pre-prompt compaction.
   h.session.setAutoCompactionEnabled(true); return boundary;
  }]);
  await h.session.prompt("reach compaction boundary");
  h.session.setAutoCompactionEnabled(false);
 }
 assert.equal(h.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 1);
 if (reason !== "overflow") {
  assert.equal(h.faux.state.callCount, reason === "manual" ? 2 : 3, "snapshot does not wake an idle or threshold-compacted host");
  h.faux.setResponses([noop(), fauxAssistantMessage("Continued")].map(response => capture(inputs, response)));
  await h.session.prompt("inspect first, then continue");
 }
 assert.equal(inputs.length, 2);
 for (const input of inputs) assert.match(inputText(input), /\[todo\] Implement/);
 appendOnly(inputs[0]!, inputs[1]!);
 assert.equal(snapshotEntries(h).length, 1); assert.equal(state(h).paused, false);
 assert.deepEqual(h.errors, []);
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
test("recovered provider stop leaves unfinished work active without a task-only wake", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, loopNotifications, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call({ operation: "set", goal: "Useful work", tasks: [{ id: "t", title: "Implement", status: "doing" }] }),
  transient(),
  fauxAssistantMessage("Recovered"),
  fauxAssistantMessage("must-not-run"),
 ]);
 await h.session.prompt("recover and continue");
 const current = state(h);
 assert.equal(current.paused, false);
 assert.equal(current.cancelled, false);
 assert.equal(current.tasks[0]!.status, "doing");
 await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length === 1);
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(extensionFollowUps(trace).length, 0);
 await pause(250);
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(extensionFollowUps(trace).length, 0);
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
 assert.equal(snapshotEntries(user).length, 1);
 const userInputs: TranscriptContext[] = [];
 user.faux.setResponses([capture(userInputs, fauxAssistantMessage("Continuing"))]); await user.session.prompt("continue");
 assert.match(inputText(userInputs[0]!), /\(paused\)/);
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
 assert.equal(snapshotEntries(tool).length, 1);
 const toolInputs: TranscriptContext[] = [];
 tool.faux.setResponses([capture(toolInputs, fauxAssistantMessage("Continuing"))]); await tool.session.prompt("continue");
 assert.match(inputText(toolInputs[0]!), /\(paused\)/);
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
 assert.equal(snapshotEntries(h).length, 1);
 const inputs: TranscriptContext[] = [];
 h.faux.setResponses([capture(inputs, fauxAssistantMessage("Investigating"))]); await h.session.prompt("continue");
 assert.match(inputText(inputs[0]!), /\(paused\)/);
 // A repeated settlement without a new state change must not append another notice.
 await h.session.extensionRunner?.emit({ type: "agent_settled", aborted: false });
 assert.equal(snapshotEntries(h).length, 1);
 h.faux.setResponses([call({ operation: "resume" }), fauxAssistantMessage("Resumed")].map(response => capture(inputs, response)));
 await h.session.prompt("resume the paused task list");
 appendOnly(inputs[0]!, inputs[1]!); appendOnly(inputs[1]!, inputs[2]!);
 assert.equal(state(h).paused, false); assert.equal(snapshotEntries(h).length, 1);
 assert.deepEqual(h.errors, []);
});
