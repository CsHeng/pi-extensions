import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import loopNotifications from "../extensions/job-notifications/index.ts";
import workflow from "../extensions/tasklist/index.ts";
import { LOOP_FACTS_EVENT, type LoopFacts } from "../extensions/shared/loop-facts.ts";
import type { TasklistState } from "../extensions/tasklist/goal-contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness, type Trace } from "./fixtures/workflow/host-fixture.ts";
const call = (args: unknown) => fauxAssistantMessage(fauxToolCall("tasklist", args as never));
const start = () => call({ operation: "set", title: "Useful work", tasks: [{ id: "t", title: "Implement" }] });
const state = (h: HostHarness): TasklistState => (h.session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "csheng-workflow-state") as { data: { state: TasklistState } }).data.state;
for (const mode of ["tui", "rpc", "print", "json"] as const) test("ordinary " + mode + " work does not create a tasklist or continuation", async t => {
 const h = await createHostHarness({ mode, extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([fauxAssistantMessage("Answer.")]); await h.session.prompt("explain");
 assert.equal(h.faux.state.callCount, 1);
 assert.equal(h.session.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "csheng-workflow-state"), false);
 assert.deepEqual(h.errors, []);
});
test("main directly marks done through the passive tasklist, independently of checks, reviews or Skills", async t => {
 const h = await createHostHarness({ extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")]);
 await h.session.prompt("implement");
 assert.equal(state(h).tasks[0]!.status, "done"); assert.equal(h.faux.state.callCount, 3); assert.deepEqual(h.errors, []);
});
for (const mode of ["tui", "rpc"] as const) test(mode + " design awaiting confirmation is not continued by todo/doing tasklist items or new input", async t => {
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
test("tasklist facts are published passively with the list snapshot and no producer-side delivery decision", async t => {
 const published: LoopFacts[] = [];
 const record = (pi: ExtensionAPI) => { pi.events.on(LOOP_FACTS_EVENT, (data: unknown) => published.push(structuredClone(data as LoopFacts))); };
 const trace = createTrace();
 const h = await createHostHarness({ mode: "print", trace, extensions: [record, workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "blocked", note: "Needs the real input" }] }), fauxAssistantMessage("Waiting")]);
 await h.session.prompt("record blocking work");
 const latest = published.at(-1)!;
 assert.equal(latest.producer, "workflow");
 assert.equal(latest.availability, "ready");
 assert.equal(latest.executions.length, 0);
 assert.equal(latest.tasks?.goal, "Useful work", "the shared fact shape keeps reporting the list title as goal");
 assert.equal(latest.tasks?.paused, false);
 assert.equal(latest.tasks?.cancelled, false);
 assert.deepEqual(latest.tasks?.tasks, [{ id: "t", title: "Implement", status: "blocked" }]);
 assert.equal(published.length >= 2, true, "publication does not depend on Agent, Bash or notification state");
 // The blocked, unfinished list published no wake and started no competing turn.
 await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length === 1);
 await pause(100);
 assert.equal(h.faux.state.callCount, 3, "the blocked list starts no competing turn");
 assert.equal(extensionFollowUps(trace).length, 0);
 assert.deepEqual(h.errors, []);
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
const snapshotEntries = (h: HostHarness): Array<{ content: unknown }> => h.session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "csheng-workflow-tasks") as unknown as Array<{ content: unknown }>;
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
test("restored tasklist is usable data at recovery time without a resume call", async t => {
 const h = await createHostHarness({ mode: "print", extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), fauxAssistantMessage("In progress")]); await h.session.prompt("implement");
 const recovered = await createHostHarness({ mode: "print", sessionManager: h.session.sessionManager, extensions: [workflow, noopTool] }); t.after(() => recovered.dispose());
 assert.equal(recovered.faux.state.callCount, 0, "recovery never starts a task-only turn");
 assert.equal(snapshotEntries(recovered).length, 1);
 assert.equal(state(recovered).tasks[0]!.status, "todo", "recovery does not invent a pause or a completion");
 const inputs: TranscriptContext[] = [];
 recovered.faux.setResponses([transient(), noop(), fauxAssistantMessage("Investigated")].map(response => capture(inputs, response)));
 await recovered.session.prompt("investigate the restored list");
 assert.equal(inputs.length, 3);
 for (const input of inputs) { assert.match(inputText(input), /Tasklist: Useful work \(1 todo\)/); assert.match(inputText(input), /\[todo\] Implement/); }
 appendOnly(inputs[0]!, inputs[1]!); appendOnly(inputs[1]!, inputs[2]!);
 recovered.faux.setResponses([call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")].map(response => capture(inputs, response)));
 await recovered.session.prompt("finish the restored work");
 appendOnly(inputs[2]!, inputs[3]!); appendOnly(inputs[3]!, inputs[4]!);
 assert.equal(state(recovered).tasks[0]!.status, "done"); assert.equal(snapshotEntries(recovered).length, 1);
 assert.deepEqual(h.errors, []); assert.deepEqual(recovered.errors, []);
});
const recordedStates = (states: unknown[]) => (pi: ExtensionAPI) => {
 pi.on("tool_execution_end", event => {
  if (event.toolName === "tasklist") states.push((event.result as { details?: { view?: { state?: unknown } } } | undefined)?.details?.view?.state);
 });
};
test("a legacy paused snapshot becomes usable tasklist data at host recovery without a resume step or rewrite", async t => {
 const seeded = SessionManager.inMemory(process.cwd());
 seeded.appendCustomEntry("csheng-workflow-state", { schemaVersion: 5, state: {
  version: 5, revision: 3, goal: "Legacy list", paused: true, cancelled: false, reason: "Recovered task list; use resume when continuing.",
  tasks: [{ id: "kept", title: "Legacy done", status: "done" }, { id: "open", title: "Legacy open", status: "doing", note: "keep this note" }],
 } });
 const trace = createTrace();
 const states: unknown[] = [];
 const h = await createHostHarness({ mode: "print", trace, sessionManager: seeded, extensions: [workflow, recordedStates(states), watchTasklistCalls(trace), createTraceObserver(trace)] });
 t.after(() => h.dispose());
 const entries = (): Array<{ data: unknown }> => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "csheng-workflow-state") as unknown as Array<{ data: unknown }>;
 assert.equal(entries().length, 1, "recovery writes nothing");
 const snapshots = snapshotEntries(h);
 assert.equal(snapshots.length, 1);
 assert.match(JSON.stringify(snapshots[0]!.content), /Tasklist: Legacy list \(1 doing · 1 done\)/);
 assert.match(JSON.stringify(snapshots[0]!.content), /keep this note/);
 assert.doesNotMatch(JSON.stringify(snapshots[0]!.content), /paused|resume|Recovered task list/);
 const inputs: TranscriptContext[] = [];
 h.faux.setResponses([call({ operation: "inspect" }), call({ operation: "update", tasks: [{ id: "open", status: "done" }] }), fauxAssistantMessage("Done")].map(response => capture(inputs, response)));
 await h.session.prompt("continue the restored list");
 const restored = states[0] as TasklistState;
 assert.deepEqual(Object.keys(restored).sort(), ["revision", "tasks", "title", "version"]);
 assert.equal(restored.title, "Legacy list");
 assert.equal(restored.revision, 3);
 assert.deepEqual(restored.tasks.map(task => [task.id, task.status, task.note]), [["kept", "done", undefined], ["open", "doing", "keep this note"]]);
 assert.equal(entries().length, 2, "only the explicit edit writes the current form");
 const written = entries().at(-1)!.data as { schemaVersion: number; state: TasklistState };
 assert.equal(written.schemaVersion, 6);
 assert.equal(written.state.title, "Legacy list");
 assert.equal(written.state.revision, 4);
 assert.equal((entries()[0]!.data as { state: { paused: boolean } }).state.paused, true, "the historical entry keeps its original fields");
 assert.deepEqual(tasklistCalls(trace).map(call => call.ok), [true, true]);
 assert.equal((states[1] as TasklistState).tasks[1]!.status, "done");
 appendOnly(inputs[0]!, inputs[1]!); appendOnly(inputs[1]!, inputs[2]!);
 assert.deepEqual(h.errors, []);
});
test("host recovery reports an unsupported snapshot as an error instead of an empty list", async t => {
 const seeded = SessionManager.inMemory(process.cwd());
 seeded.appendCustomEntry("csheng-workflow-state", { schemaVersion: 2, state: { goal: "old tracking contract" } });
 const trace = createTrace();
 const states: unknown[] = [];
 const h = await createHostHarness({ mode: "print", trace, sessionManager: seeded, extensions: [workflow, recordedStates(states), watchTasklistCalls(trace), createTraceObserver(trace)] });
 t.after(() => h.dispose());
 const entries = (): Array<{ data: unknown }> => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "csheng-workflow-state") as unknown as Array<{ data: unknown }>;
 const snapshots = snapshotEntries(h);
 assert.equal(snapshots.length, 1);
 assert.match(JSON.stringify(snapshots[0]!.content), /unsupported/i);
 assert.match(JSON.stringify(snapshots[0]!.content), /schema version 2/);
 const inputs: TranscriptContext[] = [];
 h.faux.setResponses([call({ operation: "inspect" }), fauxAssistantMessage("Reported")].map(response => capture(inputs, response)));
 await h.session.prompt("inspect the old list");
 assert.deepEqual(tasklistCalls(trace), [{ ok: false, live: true }]);
 assert.equal(states[0], undefined, "inspect reports no state rather than an empty list");
 assert.match(JSON.stringify(inputs[1]!.messages), /unsupported/i);
 assert.equal(entries().length, 1, "unsupported history is left as written");
 assert.deepEqual(entries()[0]!.data, { schemaVersion: 2, state: { goal: "old tracking contract" } });
 assert.deepEqual(h.errors, []);
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
 assert.equal(snapshotEntries(h).length, 1); assert.equal(state(h).tasks[0]!.status, "todo");
 assert.deepEqual(h.errors, []);
});
test("blocked items do not spin and cancel stays terminal data", async t => {
 const h = await createHostHarness({ extensions: [workflow] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), call({ operation: "update", tasks: [{ id: "t", status: "blocked", note: "Waiting for user input" }] }), fauxAssistantMessage("Blocked")]);
 await h.session.prompt("implement"); assert.equal(h.faux.state.callCount, 3);
 h.faux.setResponses([call({ operation: "cancel" }), fauxAssistantMessage("Cancelled")]);
 await h.session.prompt("cancel"); assert.equal(state(h).tasks[0]!.status, "cancelled");
 assert.deepEqual(h.errors, []);
});
const transient = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: synthetic transient" });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const extensionFollowUps = (trace: Trace) => trace.entries.filter(entry => entry.event === "input" && entry.detail?.source === "extension");
const tasklistCalls = (trace: Trace) => trace.entries.flatMap(entry => entry.event === "tasklist-call" && entry.detail ? [entry.detail] : []);
const watchTasklistCalls = (trace: Trace) => (pi: ExtensionAPI) => {
 pi.on("tool_execution_end", (event, ctx) => {
  if (event.toolName !== "tasklist") return;
  const details = (event.result as { details?: { ok?: boolean } } | undefined)?.details;
  trace.record("tasklist-call", { ok: event.isError === false && details?.ok === true, live: ctx.signal?.aborted === false });
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
test("one provider retry still accepts edits, rejects a removed control operation and keeps cancelled work distinct from done", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, watchTasklistCalls(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call({ operation: "set", title: "Useful work", tasks: [{ id: "keep", title: "Keep", status: "doing" }, { id: "drop", title: "Drop" }] }),
  transient(),
  fauxAssistantMessage([
   fauxToolCall("tasklist", { operation: "update", tasks: [{ id: "keep", status: "done" }] }),
   fauxToolCall("tasklist", { operation: "pause", reason: "removed control operation" }),
   fauxToolCall("tasklist", { operation: "cancel" }),
  ]),
  fauxAssistantMessage("Stopped"),
  fauxAssistantMessage("must-not-run"),
 ]);
 await h.session.prompt("recover the tasklist");
 const calls = tasklistCalls(trace);
 assert.equal(calls.length, 4);
 assert.equal(calls.filter(call => call.ok === true).length, 3, "attached retries still accept edits and cancellation");
 assert.deepEqual(calls.filter(call => call.ok === false), [{ ok: false, live: true }], "the removed control operation is rejected instead of mutating state");
 const current = state(h);
 assert.equal(current.tasks.find(task => task.id === "keep")?.status, "done");
 assert.equal(current.tasks.find(task => task.id === "drop")?.status, "cancelled");
 assert.notEqual(current.tasks[0]!.status, current.tasks[1]!.status);
 assert.equal(h.faux.state.callCount, 4);
 await pause(250);
 assert.equal(h.faux.state.callCount, 4);
 assert.equal(extensionFollowUps(trace).length, 0);
 assert.deepEqual(h.errors, []);
});
test("an interrupted provider run leaves unfinished items untouched without a task-only wake", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, loopNotifications, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call({ operation: "set", title: "Useful work", tasks: [{ id: "t", title: "Implement", status: "doing" }] }),
  transient(),
  fauxAssistantMessage("Recovered"),
  fauxAssistantMessage("must-not-run"),
 ]);
 await h.session.prompt("recover and continue");
 const current = state(h);
 assert.equal(current.tasks[0]!.status, "doing");
 await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length === 1);
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(extensionFollowUps(trace).length, 0);
 await pause(250);
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(extensionFollowUps(trace).length, 0);
 assert.equal(state(h).tasks[0]!.status, "doing");
 assert.deepEqual(h.errors, []);
});
test("user abort and tool-signal abort neither mutate the list nor append a notice", async t => {
 const userTrace = createTrace();
 const user = await createHostHarness({ trace: userTrace, extensions: [workflow, createTraceObserver(userTrace)], tokensPerSecond: 20 });
 t.after(() => user.dispose());
 user.faux.setResponses([start(), fauxAssistantMessage("streaming ".repeat(80)), fauxAssistantMessage("must-not-run")]);
 const userRun = user.session.prompt("abort the run");
 await waitForTrace(userTrace, entry => entry.event === "tool_end" && entry.detail?.toolName === "tasklist");
 await waitForTrace(userTrace, () => userTrace.entries.filter(entry => entry.event === "message_start" && entry.detail?.role === "assistant").length === 2);
 await user.session.abort();
 await userRun;
 assert.equal(state(user).tasks[0]!.status, "todo");
 assert.equal(user.faux.state.callCount, 2);
 await pause(250);
 assert.equal(user.faux.state.callCount, 2);
 assert.equal(extensionFollowUps(userTrace).length, 0);
 assert.equal(snapshotEntries(user).length, 0, "an interruption is not a tasklist event");
 const userInputs: TranscriptContext[] = [];
 user.faux.setResponses([capture(userInputs, fauxAssistantMessage("Continuing"))]); await user.session.prompt("continue");
 assert.match(inputText(userInputs[0]!), /\[todo\] Implement/);
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
 assert.equal(state(tool).tasks[0]!.status, "todo");
 assert.equal(tool.faux.state.callCount, 2);
 await pause(250);
 assert.equal(tool.faux.state.callCount, 2);
 assert.equal(extensionFollowUps(toolTrace).length, 0);
 assert.equal(snapshotEntries(tool).length, 0);
 assert.deepEqual(tool.errors, []);
});
test("a final unrecovered provider error leaves unfinished items editable without an automatic wake", async t => {
 const trace = createTrace();
 const h = await createHostHarness({ trace, extensions: [workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([start(), transient(), transient(), fauxAssistantMessage("must-not-run")]);
 await h.session.prompt("exhaust retry");
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(state(h).tasks[0]!.status, "todo");
 await pause(250);
 assert.equal(h.faux.state.callCount, 3);
 assert.equal(extensionFollowUps(trace).length, 0);
 assert.equal(snapshotEntries(h).length, 0);
 const inputs: TranscriptContext[] = [];
 h.faux.setResponses([capture(inputs, fauxAssistantMessage("Investigating"))]); await h.session.prompt("continue");
 assert.match(inputText(inputs[0]!), /\[todo\] Implement/);
 // A repeated settlement without a new state change must not append or mutate anything.
 await h.session.extensionRunner?.emit({ type: "agent_settled", aborted: false });
 assert.equal(snapshotEntries(h).length, 0);
 h.faux.setResponses([call({ operation: "update", tasks: [{ id: "t", status: "done" }] }), fauxAssistantMessage("Done")].map(response => capture(inputs, response)));
 await h.session.prompt("finish the recovered work");
 appendOnly(inputs[0]!, inputs[1]!); appendOnly(inputs[1]!, inputs[2]!);
 assert.equal(state(h).tasks[0]!.status, "done"); assert.equal(snapshotEntries(h).length, 0);
 assert.deepEqual(h.errors, []);
});
