import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow from "../extensions/workflow/index.ts";
import { SUBAGENT_EXECUTION_EVENT } from "../extensions/shared/subagent-execution.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";
const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never));
for (const early of [false, true]) test("async completion " + (early ? "before" : "after") + " receipt neither accepts tasks nor creates duplicate wakes", async t => {
 let send!: () => void;
 const transport = (pi: ExtensionAPI) => {
  pi.registerTool({ name: "csheng_subagent_sessions", label: "Fixture", description: "Synthetic transport", parameters: Type.Object({ action: Type.Literal("create") }),
   async execute(id, _args, _signal, _update, ctx) {
    send = () => pi.events.emit(SUBAGENT_EXECUTION_EVENT, { version: 4, kind: "run-terminal", runId: "run", toolCallId: id, owner: { sessionId: ctx.sessionManager.getSessionId() }, sessions: [] });
    if (early) send();
    return { content: [{ type: "text", text: "accepted" }], details: { schemaVersion: 4, kind: "submission", status: "accepted", runId: "run", requestTelemetry: { version: 1, ownerSessionId: ctx.sessionManager.getSessionId(), admittedTasks: 1 } } };
   } });
 };
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, transport, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call("csheng_workflow", { operation: "set", goal: "Work", tasks: [{ id: "a", title: "Task", status: "doing" }] }),
  call("csheng_subagent_sessions", { action: "create" }), fauxAssistantMessage("Awaiting result"),
  fauxAssistantMessage("One reminder, not acceptance"),
 ]);
 await h.session.prompt("go");
 if (early) await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 2);
 else { assert.equal(h.faux.state.callCount, 3); send(); assert.equal(h.faux.state.callCount, 3, "executor owns the wake"); }
 const snapshot = h.session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "csheng-workflow-state") as { data: { state: { tasks: { status: string }[] } } };
 assert.equal(snapshot.data.state.tasks[0]!.status, "doing"); assert.deepEqual(h.errors, []);
});

test("replaying an old accepted receipt after recovery cannot wait for a nonexistent live run", async t => {
 const transport = (pi: ExtensionAPI) => {
  pi.registerTool({ name: "csheng_subagent_sessions", label: "Fixture", description: "Persisted accepted receipt replay", parameters: Type.Object({ action: Type.Literal("create") }),
   async execute(_id, _args, _signal, _update, ctx) {
    return { content: [{ type: "text", text: "old accepted receipt" }], details: { schemaVersion: 4, kind: "submission", status: "accepted", runId: "prior-process-run",
     sessions: [{ handle: "old", state: "running" }], requestTelemetry: { version: 1, ownerSessionId: ctx.sessionManager.getSessionId(), admittedTasks: null, replayedEpisodes: 1 } } };
   } });
 };
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, transport, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call("csheng_workflow", { operation: "set", goal: "Recovered work", tasks: [{ id: "a", title: "Continue", status: "doing" }] }),
  call("csheng_workflow", { operation: "pause", reason: "Recovered session" }), fauxAssistantMessage("Paused"),
 ]);
 await h.session.prompt("restore tracked work");
 h.faux.setResponses([call("csheng_workflow", { operation: "resume" }), call("csheng_subagent_sessions", { action: "create" }), fauxAssistantMessage("Recorded historical receipt"), fauxAssistantMessage("One useful reminder")]);
 await h.session.prompt("continue current work");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 3);
 assert.equal(h.faux.state.callCount, 7); assert.deepEqual(h.errors, []);
});
