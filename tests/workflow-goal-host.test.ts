import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow from "../extensions/workflow/index.ts";
import type { GoalState } from "../extensions/workflow/goal-contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace, type HostHarness } from "./fixtures/workflow/host-fixture.ts";
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
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
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
