import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 const waits: string[] = [];
 const h = await createHostHarness({ mode, extensions: [pi => workflow({ ...pi, sendUserMessage(message, options) {
  if (typeof message === "string" && message.startsWith("/csheng-workflow-wait ")) waits.push(message);
  pi.sendUserMessage(message, options);
 } })] }); t.after(() => h.dispose());
 h.faux.setResponses([fauxAssistantMessage("Analysis only. No implementation contract.")]); await h.session.prompt("explain the project");
 assert.equal(h.faux.state.callCount, 1); assert.equal(h.session.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "csheng-workflow-state"), false);
 assert.deepEqual(waits, []); assert.deepEqual(h.errors, []);
});

for (const terminal of ["complete", "suspended"] as const) test(`ordinary question after ${terminal} has no waiter; mid-run resume can arm`, async t => {
 const waits: string[] = [];
 const h = await createHostHarness({ extensions: [pi => workflow({ ...pi, sendUserMessage(message, options) {
  if (typeof message === "string" && message.startsWith("/csheng-workflow-wait ")) waits.push(message);
  pi.sendUserMessage(message, options);
 } })] }); t.after(() => h.dispose());
 const finish = [call({ operation: "start", task: "t", scope: ["planned"] }), call({ operation: "report", summary: "verified fixture", facts: [{ key: "c", kind: "agent", check: "fixture assertion", result: "pass" }], judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ subject, accepted: true, facts: ["c"], rationale: "fixture" })), complete: true })];
 h.faux.setResponses([enroll(), ...(terminal === "complete" ? finish : [call({ operation: "suspend", reason: "user pause", condition: "user resumes" })]), fauxAssistantMessage("stopped")]);
 await h.session.prompt("implement"); assert.equal(waits.length, 1);
 h.faux.setResponses([fauxAssistantMessage("answer only")]); await h.session.prompt("explain a term"); assert.equal(waits.length, 1);
 if (terminal === "suspended") {
  h.faux.setResponses([call({ operation: "resume", reason: "user resumes", authority: "same scope", alignment: "resume approved work after question" }), ...finish, fauxAssistantMessage("done")]);
  await h.session.prompt("resume implementation"); assert.equal(waits.length, 2); assert.equal(state(h).fulfillment, "complete");
 }
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

test("real host limits repeated automatic dispatch but permits ordinary diagnostic continuation", async t => {
 const trace = createTrace(); const h = await createHostHarness({ trace, extensions: [workflow, createTraceObserver(trace)] }); t.after(() => h.dispose());
 h.faux.setResponses([enroll(), fauxAssistantMessage("unfinished"), fauxAssistantMessage("still unfinished"), fauxAssistantMessage("same deficits")]);
 await h.session.prompt("implement");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 3);
 await waitForTrace(trace, () => state(h).continuation.automaticPaused === true);
 assert.equal(h.faux.state.callCount, 4); assert.equal(state(h).fulfillment, "pending"); assert.equal(state(h).continuation.dispatched, 2);
 assert.equal(state(h).continuation.state, "active");
 h.faux.setResponses([
  call({ operation: "start", task: "t", scope: ["source"], alignment: "continue existing authorized work after the dispatch guard" }),
  fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'identified missing prerequisite'; exit 1" } as never)),
  call({ operation: "report", summary: "useful failed diagnostic", facts: [{ key: "diagnostic", kind: "host", check: "prerequisite diagnosis", result: "fail" }] }),
  fauxAssistantMessage("diagnosis complete, work remains"),
  call({ operation: "start", task: "t", scope: ["source"] }),
  fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'verified repaired boundary'" } as never)),
  call({ operation: "report", summary: "verified", facts: [{ key: "check", kind: "host", check: "repair verification", result: "pass" }],
   judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ subject, accepted: true, facts: ["check"], rationale: "current passing verification" })), complete: true }),
  fauxAssistantMessage("complete"),
 ]);
 await h.session.prompt("Continue the same authorized task with a concrete diagnostic");
 await waitForTrace(trace, () => state(h).fulfillment === "complete");
 await waitForTrace(trace, () => trace.entries.filter(e => e.event === "native:agent_settled").length === 5);
 assert.equal(state(h).continuation.dispatched, 3); assert.equal(state(h).continuation.automaticPaused, undefined);
 assert.equal(state(h).input.generation, 1); assert.ok(state(h).facts.some(f => f.result === "fail")); assert.deepEqual(h.errors, []);
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

test("real host recovery revalidates a completed snapshot before mounting its projection in a new root", async t => {
 const first = await createHostHarness({ mode: "print", extensions: [workflow] }); t.after(() => first.dispose());
 first.faux.setResponses([enroll(), call({ operation: "start", task: "t", scope: ["result"], writes: ["result"] }),
  fauxAssistantMessage(fauxToolCall("write", { path: "result", content: "verified" } as never)),
  fauxAssistantMessage(fauxToolCall("read", { path: "result" } as never)),
  call({ operation: "report", summary: "verified", facts: [{ key: "c", kind: "host", check: "read", result: "pass" }], judgments: ["task:t", "requirement:r", "delivery"].map(subject => ({ subject, facts: ["c"], accepted: true, rationale: "verified" })), complete: true }), fauxAssistantMessage("complete")]);
 await first.session.prompt("implement"); assert.equal(state(first).fulfillment, "complete");
 const restored = await createHostHarness({ mode: "print", sessionManager: first.session.sessionManager, extensions: [workflow], sessionStartReason: "resume" }); t.after(() => restored.dispose());
 assert.notEqual(restored.workDir, first.workDir);
 assert.equal(state(restored).fulfillment, "pending"); assert.equal(state(restored).continuation.state, "suspended");
 assert.deepEqual(restored.errors, []);
});

test("real host writes two external non-Git roots and binds host evidence to their declared scope", async t => {
 const outside = await mkdtemp(join(tmpdir(), "workflow-external-host-"));
 t.after(() => rm(outside, { recursive: true, force: true }));
 const skills = join(outside, "skills", "result"), installation = join(outside, "installation", "result");
 const packageRoot = process.env.CSHENG_WORKFLOW_PROBE_PACKAGE_ROOT;
 let sourcePath: string | undefined;
 const observer = (pi: ExtensionAPI) => { pi.on("session_start", () => { sourcePath = pi.getAllTools().find(tool => tool.name === "csheng_workflow")?.sourceInfo?.path; }); };
 const h = await createHostHarness({ mode: "print", extensions: packageRoot ? [observer] : [workflow, observer], ...(packageRoot ? { extensionPaths: [join(packageRoot, "extensions/workflow/index.ts")] } : {}) }); t.after(() => h.dispose());
 if (packageRoot) assert.ok(sourcePath?.startsWith(`${packageRoot}/`), "actual tool must load from the selected snapshot");
 h.faux.setResponses([enroll(), call({ operation: "start", task: "t", scope: [skills, installation], writes: [skills, installation] }),
  fauxAssistantMessage(fauxToolCall("write", { path: skills, content: "source" } as never)),
  fauxAssistantMessage(fauxToolCall("write", { path: installation, content: "installed" } as never)),
  fauxAssistantMessage(fauxToolCall("read", { path: installation } as never)),
  call({ operation: "report", summary: "Read explicit external installation", facts: [{ key: "check", kind: "host", check: "fixture output", result: "pass" }], judgments: ["task:t", "requirement:r"].map(subject => ({ subject, accepted: true, facts: ["check"], rationale: "verified fixture" })) }),
  call({ operation: "suspend", reason: "fixture will test source drift", condition: "source changed" }), fauxAssistantMessage("verified")]);
 await h.session.prompt("implement across explicitly authorized external roots");
 assert.equal(await readFile(skills, "utf8"), "source"); assert.equal(await readFile(installation, "utf8"), "installed");
 assert.equal(state(h).acceptance.find(item => item.subject === "task:t")?.accepted, true);
 assert.equal(state(h).facts[0]?.kind, "host");
 await writeFile(skills, "changed source");
 h.faux.setResponses([call({ operation: "amend", reason: "inspect existing authority", authority: "original fixture", alignment: "same scope" }), call({ operation: "close", outcome: "completed", reason: "recheck changed root" }), fauxAssistantMessage("not complete")]);
 await h.session.prompt("recheck");
 assert.equal(state(h).fulfillment, "pending");
 assert.notEqual(state(h).acceptance.find(item => item.subject === "task:t")?.accepted, true);
 assert.deepEqual(h.errors, []);
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
