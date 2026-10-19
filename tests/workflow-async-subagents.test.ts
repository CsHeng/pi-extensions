import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import loopNotifications from "../extensions/loop-notifications/index.ts";
import workflow from "../extensions/workflow/index.ts";
import { LOOP_FACTS_EVENT, LOOP_SNAPSHOT_REQUEST, type LoopFacts } from "../extensions/shared/loop-facts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";
const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never));
for (const early of [false, true]) test("async completion " + (early ? "before" : "after") + " receipt neither accepts tasks nor creates duplicate wakes", async t => {
 let send!: () => void;
 const running: LoopFacts = { version: 1, producer: "subagents", availability: "ready", sessionId: null, branchAnchor: null, generation: "live", executions: [{ id: "run", phase: "running", status: "running", exitCode: null, summary: "", disposition: "pending" }] };
 const transport = (pi: ExtensionAPI) => {
  const publish = () => pi.events.emit(LOOP_FACTS_EVENT, running);
  pi.events.on(LOOP_SNAPSHOT_REQUEST, (raw: unknown) => (raw as { accept?: (facts: LoopFacts) => void }).accept?.(running));
  pi.registerTool({ name: "csheng_subagent_sessions", label: "Fixture", description: "Synthetic transport", parameters: Type.Object({ action: Type.Literal("create") }),
   async execute() {
    publish();
    send = publish;
    return { content: [{ type: "text", text: "accepted" }], details: { schemaVersion: 4, kind: "submission", status: "accepted", runId: "run", requestTelemetry: { version: 1, ownerSessionId: "session", admittedTasks: 1 } } };
   } });
 };
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [early ? loopNotifications : workflow, early ? workflow : loopNotifications, transport, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call("csheng_workflow", { operation: "set", goal: "Work", tasks: [{ id: "a", title: "Task", status: "doing" }] }),
  call("csheng_subagent_sessions", { action: "create" }), fauxAssistantMessage("Awaiting result"),
  fauxAssistantMessage("must-not-remind"),
 ]);
 await h.session.prompt("go");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 1);
 assert.equal(h.faux.state.callCount, 3, "a pending run vetoes a task-only reminder");
 send(); assert.equal(h.faux.state.callCount, 3, "republishing the same running fact is not a task reminder");
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
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, loopNotifications, transport, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([
  call("csheng_workflow", { operation: "set", goal: "Recovered work", tasks: [{ id: "a", title: "Continue", status: "doing" }] }),
  call("csheng_workflow", { operation: "pause", reason: "Recovered session" }), fauxAssistantMessage("Paused"),
 ]);
 await h.session.prompt("restore tracked work");
 h.faux.setResponses([call("csheng_workflow", { operation: "resume" }), call("csheng_subagent_sessions", { action: "create" }), fauxAssistantMessage("Recorded historical receipt"), fauxAssistantMessage("must-not-run")]);
 await h.session.prompt("continue current work");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 2);
 await new Promise(resolve => setTimeout(resolve, 100));
 assert.equal(h.faux.state.callCount, 6); assert.deepEqual(h.errors, []);
});
