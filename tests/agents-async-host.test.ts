
import { before as ensureScopeBefore } from "node:test";
import { mkdir as ensureScopeMkdir } from "node:fs/promises";
ensureScopeBefore(async () => { await ensureScopeMkdir("/tmp/scope", { recursive: true }); await ensureScopeMkdir("/tmp/src", { recursive: true }); });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContinuationTool, ContinuationService, NOTICE_EXCERPT_LIMIT } from "../extensions/agents/continuation.ts";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { emptyUsage } from "../extensions/agents/contracts.ts";
import { defaultConfig } from "../extensions/agents/config.ts";
import { runChild } from "../extensions/agents/runner.ts";
import { AGENT_EXECUTION_EVENT, type AgentExecutionEvent } from "../extensions/shared/agent-execution.ts";
import type { SessionView } from "../extensions/agents/session-contracts.ts";
import noticesExtension from "../extensions/notices/index.ts";
import { NOTICE_TYPE } from "../extensions/shared/execution-facts.ts";
import tasklistExtension from "../extensions/tasklist/index.ts";
import type { TasklistState } from "../extensions/tasklist/contracts.ts";
import nativeFixture from "./fixtures/agents-native-session.ts";
import { createHostHarness, createTrace, createTraceObserver } from "./fixtures/host-fixture.ts";
const exec = promisify(execFile);

test("terminal facts carry a bounded result and omit observed summaries", () => {
 const service = new ContinuationService();
 const view = { handle: "handle1", episode: 2, result: { status: "succeeded", changedPaths: ["private/a", "private/b"], output: `${"Earlier sentence. ".repeat(150)}Closing sentence about src/example.ts.` }, candidate: { id: "candidate1", changedPaths: ["private/a", "private/b"] } };
 const record = { handle: "handle1", episode: 2, state: "idle", task: { id: "task1" } };
 const internals = service as unknown as { supervisor: unknown; bindings: Map<string, unknown>; observedEpisodes: Map<string, number> };
 internals.supervisor = { inspect: () => [{ runId: "run1", phase: "running", tasks: [{ taskId: "handle1", phase: "succeeded" }] }] };
 internals.bindings.set("run1", { initiator: { kind: "main" }, records: [record], views: new Map([["handle1", view]]) });
 const fact = () => service.executionFacts("session", null).executions.find(item => item.id === "run1:handle1")!;
 const summary = fact().summary;
 assert.match(summary, /Agent task1.*turn succeeded; status succeeded; isolated candidate ready \(2 changed paths\)/);
 assert.ok(summary.includes("[earlier output truncated] ")); assert.ok(summary.includes("Closing sentence about src/example.ts."), "the child's own report tail is carried verbatim");
 assert.ok(!summary.includes("private/a"), "changed paths are counted, not enumerated");
 const excerpt = summary.split("Closing summary: ")[1]!.split(" Full report:")[0]!;
 assert.match(summary, /Full report: list_agents with name task1\. A finished turn is not acceptance\.$/);
 assert.doesNotMatch(summary, /handle1|candidate1|expectedEpisode/);
 assert.ok(excerpt.length <= NOTICE_EXCERPT_LIMIT);
 internals.observedEpisodes.set("handle1", 2);
 assert.equal(fact().summary, ""); assert.equal(fact().disposition, "observed");
});

test("terminal notices wait for the current result while a sibling can publish", () => {
 const service = new ContinuationService();
 const internals = service as unknown as { supervisor: unknown; bindings: Map<string, unknown> };
 const run = { runId: "run1", phase: "running", tasks: [{ taskId: "handle1", phase: "completed" }, { taskId: "handle2", phase: "completed" }] };
 const views = new Map<string, unknown>([
  ["handle1", { handle: "handle1", episode: 1, result: { status: "succeeded", output: "previous episode", changedPaths: [] } }],
  ["handle2", { handle: "handle2", episode: 1, result: { status: "succeeded", output: "sibling closing report", changedPaths: [] } }],
 ]);
 internals.supervisor = { inspect: () => [run] };
 internals.bindings.set("run1", { initiator: { kind: "main" }, records: [{ handle: "handle1", episode: 2, task: { id: "task1" } }, { handle: "handle2", episode: 1, task: { id: "task2" } }], views });
 const facts = () => service.executionFacts("session", null).executions;
 const pending = facts().find(item => item.id === "run1:handle1")!;
 assert.equal(pending.phase, "running"); assert.equal(pending.status, "publishing"); assert.equal(pending.summary, "");
 assert.match(facts().find(item => item.id === "run1:handle2")!.summary, /sibling closing report/);
 views.set("handle1", { handle: "handle1", episode: 2, result: { status: "succeeded", output: "current closing report", changedPaths: ["src/a.ts"] }, candidate: { id: "candidate2", changedPaths: ["src/a.ts"] } });
 const ready = facts().find(item => item.id === "run1:handle1")!;
 assert.equal(ready.phase, "terminal"); assert.match(ready.summary, /isolated candidate ready \(1 changed paths\)/); assert.match(ready.summary, /current closing report/); assert.ok(!ready.summary.includes("previous episode"));
 run.phase = "failed"; views.delete("handle1");
 const unavailable = facts().find(item => item.id === "run1:handle1")!;
 assert.equal(unavailable.phase, "terminal"); assert.match(unavailable.summary, /result unavailable/);
});

for (const consume of ["wait", "list", "release", "mixed"] as const) test(`real host ${consume} consumes terminal notifications without a stale provider turn`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-wake-consumed-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal!: () => void, context!: ExtensionContext, service!: ContinuationService;
 const names = consume === "mixed" ? ["one", "two"] : ["one"];
 const gate = new Promise<void>(resolve => { release = resolve; }); const completed = new Promise<void>(resolve => { terminal = resolve; }); const wakes: string[] = []; let providerEvidence = "";
 const h = await createHostHarness({ mode: "rpc", extensions: [noticesExtension, (pi: ExtensionAPI) => {
  service = registerContinuationTool({ ...pi, sendMessage(message, options) {
   if (options?.triggerTurn && message.customType === AGENT_EXECUTION_EVENT) { assert.equal(context.isIdle(), true); wakes.push(String(message.content)); }
   pi.sendMessage(message, options);
  } }, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, ctx) => { context = ctx; });
  let remaining = names.length;
  pi.events.on(AGENT_EXECUTION_EVENT, event => { if ((event as AgentExecutionEvent).kind === "run-terminal" && --remaining === 0) terminal(); });
  pi.registerTool({ name: "drain_children", label: "Drain fixture", description: "Release owned fixture children while parent tool holds the turn", parameters: Type.Object({}), async execute() { release(); await completed; return { content: [{ type: "text", text: "terminal" }], details: {} }; } });
 }] });
 t.after(async () => { release(); await service.shutdown(); if (context) for (const view of await service.contextIndex(context)) assert.equal((await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context)).status, "succeeded"); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([
  invoke(names), tool("drain_children", {}),
  providerContext => { providerEvidence = JSON.stringify(providerContext.messages); return consume === "wait" ? tool("wait_agents", { names }) : consume === "release" ? tool("release_agent", { name: "one", disposition: "discard" }) : tool("list_agents", { name: "one" }); },
  fauxAssistantMessage("parent work finished"), fauxAssistantMessage("unobserved evidence received"),
 ]);
 await h.session.prompt("bounded notification fixture"); await new Promise(resolve => setImmediate(resolve));
 assert.equal(h.faux.state.callCount, 4); assert.deepEqual(wakes, []);
 assert.ok(providerEvidence.includes("Full report: list_agents"));
 for (const name of names) assert.ok(providerEvidence.includes(`list_agents with name ${name}`), "ready sibling facts must reach the ongoing provider request without an extra wake");
 assert.deepEqual(h.errors, []);
});

test("blocked work can resume, yield fully idle, and receive one child terminal without polling", { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-blocked-yield-")); const store = new ManagedSessionStore(base);
 let release!: () => void, ctx!: ExtensionContext, service!: ContinuationService, started = false, terminalWire = "", evidenceWire = "", wakes = 0;
 const gate = new Promise<void>(resolve => { release = resolve; }); const trace = createTrace();
 const h = await createHostHarness({ mode: "rpc", trace, extensions: [noticesExtension, tasklistExtension, (pi: ExtensionAPI) => {
  service = registerContinuationTool({ ...pi, sendMessage(message, options) {
   if (options?.triggerTurn && message.customType === AGENT_EXECUTION_EVENT) { assert.equal(ctx.isIdle(), true); wakes++; }
   pi.sendMessage(message, options);
  } }, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); started = true; await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "released child evidence", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, context) => { ctx = context; });
 }, createTraceObserver(trace)] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([
  tool("tasklist", { operation: "set", title: "Verify resumed execution", tasks: [{ id: "verify", title: "Verify", status: "blocked", note: "Await user prerequisite" }] }),
  fauxAssistantMessage("Waiting for the user prerequisite"),
 ]);
 await h.session.prompt("Start verification"); assert.equal(h.faux.state.callCount, 2);
 h.faux.setResponses([
  tool("tasklist", { operation: "update", tasks: [{ id: "verify", status: "doing", note: null }] }),
  invoke(["verify"]),
  fauxAssistantMessage("Execution is pending; this turn can end without completing the task"),
  context => { terminalWire = JSON.stringify(context.messages); return tool("list_agents", { name: "verify" }); },
  context => { evidenceWire = JSON.stringify(context.messages); return tool("tasklist", { operation: "update", tasks: [{ id: "verify", status: "done" }] }); },
  fauxAssistantMessage("Execution evidence collected"),
 ]);
 await h.session.prompt("Prerequisite resolved; continue");
 await until(() => started && h.faux.state.callCount === 5 && !h.session.isStreaming);
 const state = () => h.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "tasklist.state").at(-1) as { data: { state: TasklistState } };
 assert.equal(state().data.state.tasks[0]?.status, "doing"); assert.equal("paused" in state().data.state, false); assert.equal(wakes, 0);
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 5, "pending work alone must not keep requesting the provider");
 release(); await until(() => h.faux.state.callCount === 8 && !h.session.isStreaming);
 assert.equal(wakes, 0, "the executor does not wake; the consumer delivers the terminal"); assert.ok(terminalWire.includes("Full report: list_agents")); assert.ok(evidenceWire.includes("released child evidence"));
 assert.equal(state().data.state.tasks[0]?.status, "done");
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 8); assert.deepEqual(h.errors, []);
});

for (const boundary of ["settlement", "compaction", "compaction-abort", "compaction-abort-late"] as const) test(`completion waits across a held public ${boundary} boundary`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-wake-boundary-")); const store = new ManagedSessionStore(base);
 let releaseChild!: () => void, releaseBoundary!: () => void, entered = false, terminal = false, holding = false, badWake = false, waits = 0, context!: ExtensionContext, service!: ContinuationService, work: Promise<unknown> | undefined;
 const childGate = new Promise<void>(resolve => { releaseChild = resolve; }), boundaryGate = new Promise<void>(resolve => { releaseBoundary = resolve; });
 let releaseFailure!: () => void, failureEntered = false; const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
 const h = await createHostHarness({ mode: "rpc", settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } }, extensions: [noticesExtension, (pi: ExtensionAPI) => {
  if (boundary === "compaction-abort-late") pi.on("session_compact_failed", async () => { failureEntered = true; holding = true; await failureGate; holding = false; });
  pi.on("input", event => { if (String(event.text ?? "").startsWith("/notices-wait ")) waits++; });
  service = registerContinuationTool({ ...pi, sendMessage(message, options) { if (options?.triggerTurn && holding) badWake = true; pi.sendMessage(message, options); } }, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await childGate; options.onChildSettled?.(); return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, ctx) => { context = ctx; }); pi.events.on(AGENT_EXECUTION_EVENT, event => { if ((event as AgentExecutionEvent).kind === "run-terminal") terminal = true; });
  if (boundary === "settlement") pi.on("agent_settled", async () => { if (!entered) { entered = true; holding = true; await boundaryGate; holding = false; } });
  else pi.on("session_before_compact", async event => { entered = true; holding = true; await boundaryGate; holding = false; return { compaction: { summary: "owned fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }; });
 }] });
 t.after(async () => { releaseChild(); releaseBoundary(); releaseFailure(); await work?.catch(() => {}); await service.shutdown(); if (context) for (const view of await service.contextIndex(context)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([invoke(["scan"]), fauxAssistantMessage("parent work finished"), fauxAssistantMessage("unobserved result received")]);
 work = h.session.prompt("bounded fixture");
 if (boundary !== "settlement") { await work; work = h.session.compact("owned fixture only"); }
 await until(() => entered);
 if (boundary === "compaction-abort-late") {
  const rejected = assert.rejects(work, /cancel/i); const aborting = h.session.abort(); releaseBoundary(); await until(() => failureEntered);
  releaseChild(); await until(() => terminal); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(badWake, false); assert.equal(h.faux.state.callCount, 2);
  releaseFailure(); await rejected; await aborting; assert.deepEqual(h.errors, []); return;
 }
 releaseChild(); await until(() => terminal); assert.equal(badWake, false); assert.equal(h.faux.state.callCount, 2);
 if (boundary === "compaction-abort") { const aborting = h.session.abort(); releaseBoundary(); await assert.rejects(work, /cancel/i); await aborting; await new Promise(resolve => setImmediate(resolve)); assert.equal(h.faux.state.callCount, 2); }
 else { releaseBoundary(); await work; await until(() => h.faux.state.callCount === 3 && !h.session.isStreaming); }
 assert.equal(badWake, false); assert.deepEqual(h.errors, []);
});

test("a completion queued behind a parent tool cannot restart an aborted real host", { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-host-abort-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal = false, context!: ExtensionContext, service!: ContinuationService;
 const gate = new Promise<void>(resolve => { release = resolve; }); const trace = createTrace();
 const h = await createHostHarness({ mode: "rpc", trace, extensions: [(pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, ctx) => { context = ctx; }); pi.events.on(AGENT_EXECUTION_EVENT, () => { terminal = true; });
 }, createTraceObserver(trace)] });
 t.after(async () => { release(); await h.session.abort(); await service.shutdown(); if (context) for (const view of await service.contextIndex(context)) assert.equal((await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context)).status, "succeeded"); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([invoke(["scan"]), tool("bash", { command: "sleep 30" }), fauxAssistantMessage("must not resume after abort")]);
 const running = h.session.prompt("bounded fixture"); await until(() => trace.entries.some(entry => entry.event === "tool_start" && entry.detail?.toolName === "bash"));
 release(); await until(() => terminal); await new Promise(resolve => setImmediate(resolve)); await h.session.abort(); await running;
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 2); assert.equal(h.session.isStreaming, false); assert.deepEqual(h.errors, []);
});
for (const aggregate of ["failed", "partial"] as const) test(`waiting for ${aggregate} child evidence consumes delayed notifications`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-failure-consumed-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal!: () => void, ctx!: ExtensionContext, service!: ContinuationService, returned = "", isError = false;
 const names = aggregate === "partial" ? ["failed", "succeeded"] : ["failed"];
 const delayed: AgentExecutionEvent[] = [];
 const gate = new Promise<void>(resolve => { release = resolve; }), completion = new Promise<void>(resolve => { terminal = resolve; });
 const h = await createHostHarness({ mode: "rpc", extensions: [(pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), onWake: events => { delayed.push(...events); }, runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: options.task.id === "failed" ? "failed" : "succeeded", reportComplete: true, output: "returned failure is evidence", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.on("tool_execution_end", event => { if (event.toolName === "wait_agents") { returned = event.result.content.map((part: { type: string; text?: string }) => part.type === "text" ? part.text : "").join(""); isError = event.isError; } });
  let remaining = names.length;
  pi.events.on(AGENT_EXECUTION_EVENT, event => { if ((event as AgentExecutionEvent).kind === "run-terminal" && --remaining === 0) terminal(); });
  pi.registerTool({ name: "drain_failure", label: "Drain failure fixture", description: "Release fixture child", parameters: Type.Object({}), async execute() { release(); await completion; return { content: [{ type: "text", text: "terminal" }], details: {} }; } });
 }] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([invoke(names), tool("drain_failure", {}), tool("wait_agents", { names }), fauxAssistantMessage("failure evidence collected, not accepted")]);
 await h.session.prompt("fixture");
 assert.match(returned, /failed: turn failed/);
 if (aggregate === "partial") assert.match(returned, /succeeded: turn succeeded/);
 assert.equal(isError, false, "reporting failure is a successful wait operation"); assert.ok(delayed.length > 0);
 assert.deepEqual(await service.unobservedWake(delayed, ctx), [], "the delivered failure result must fence a later notification");
 assert.equal(h.faux.state.callCount, 4); assert.deepEqual(h.errors, []);
});

test("queued but dropped completion is not acknowledged, and a new input can explicitly collect it", { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-dropped-notice-")); const store = new ManagedSessionStore(base);
 let release!: () => void, ctx!: ExtensionContext, service!: ContinuationService;
 let terminalEvent!: AgentExecutionEvent;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const h = await createHostHarness({ mode: "rpc", extensions: [(pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "one execution", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, context) => { ctx = context; });

  pi.events.on(AGENT_EXECUTION_EVENT, raw => { const event = raw as AgentExecutionEvent; if (event.kind === "task-terminal") terminalEvent = event; });
 }] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([invoke(["scan"]), fauxAssistantMessage("waiting for a real event")]);
 await h.session.prompt("start fixture"); release(); await until(() => !!terminalEvent);
 assert.equal((await service.unobservedWake([terminalEvent], ctx)).length, 1, "publication alone must not consume terminal evidence");
 assert.equal(h.faux.state.callCount, 2);
 let wire = "";
 h.faux.setResponses([tool("list_agents", { name: "scan" }), providerContext => { wire = JSON.stringify(providerContext.messages); return fauxAssistantMessage("explicit result collected"); }]);
 await h.session.prompt("collect explicitly; supersede the dropped queue");
 assert.ok(wire.includes("one execution")); assert.ok(!wire.includes("Full report: list_agents"), "a superseded queued notice must not reappear from history");
 assert.deepEqual(await service.unobservedWake([terminalEvent], ctx), []);
 assert.equal(h.faux.state.callCount, 4); assert.deepEqual(h.errors, []);
});

for (const order of ["tasklist-first", "executor-first"] as const) test(`completion reaches one provider turn without task-only renewal (${order})`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-completion-only-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal!: () => void, ctx!: ExtensionContext, service!: ContinuationService, released = false, providerWire = "";
 const terminalContents: string[] = [], reminderContents: string[] = [];
 const notifications = (pi: ExtensionAPI) => noticesExtension({ ...pi,
  sendMessage(message, options) {
   if (message.customType === NOTICE_TYPE && options?.triggerTurn) terminalContents.push(String(message.content));
   return pi.sendMessage(message, options);
  },
  sendUserMessage(content, options) {
   if (options?.deliverAs === "followUp") {
    assert.equal(typeof content, "string"); reminderContents.push(content as string);
   }
   pi.sendUserMessage(content, options);
  },
 });
 const gate = new Promise<void>(resolve => { release = resolve; }), completion = new Promise<void>(resolve => { terminal = resolve; });
 const executor = (pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.events.on(AGENT_EXECUTION_EVENT, event => { if ((event as AgentExecutionEvent).kind === "run-terminal") terminal(); });
  pi.on("agent_settled", async () => { if (!released) { released = true; release(); await completion; } });
 };
 const h = await createHostHarness({ mode: "rpc", extensions: order === "tasklist-first" ? [notifications, tasklistExtension, executor] : [executor, tasklistExtension, notifications] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([contract({ operation: "set", title: "independent work", tasks: [{ id: "running", title: "Child", status: "doing" }, { id: "ready", title: "Independent task" }] }), invoke(["child"]), fauxAssistantMessage("settle with ready work"), providerContext => { providerWire = JSON.stringify(providerContext.messages); return fauxAssistantMessage("terminal evidence received"); }, fauxAssistantMessage("must-not-run")]);
 await h.session.prompt("fixture"); await until(() => h.faux.state.callCount === 4 && !h.session.isStreaming);
 await new Promise(resolve => setTimeout(resolve, 100));
 assert.equal(h.faux.state.callCount, 4, "the terminal notice starts one turn, not a later task-only renewal");
 assert.equal(terminalContents.length, 1);
 assert.equal(reminderContents.length, 0);
 assert.ok(providerWire.includes(JSON.stringify(terminalContents[0])), "the terminal notice reaches its provider turn");
 assert.deepEqual(h.errors, []);
});

const tool = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never));
const invoke = (names: readonly string[]) => fauxAssistantMessage(names.map(name => fauxToolCall("invoke_agent", { name, role: "explorer", prompt: "Inspect the fixture", access: [{ permission: "read", scope: "/tmp/scope" }] })));
const contract = (args: unknown) => tool("tasklist", args);
async function until(check: () => boolean | Promise<boolean>) {
 const deadline = Date.now() + 15000;
 while (Date.now() < deadline) { try { if (await check()) return; } catch { /* owned fixture marker not written yet */ } await new Promise(resolve => setTimeout(resolve, 10)); }
 assert.fail("bounded offline host scenario did not reach its checkpoint");
}

test("real RPC-mode Pi parent and native children overlap, wake, apply early and repair without rebinding a sibling run", { timeout: 45000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-native-host-"));
 // Native children now load the configured catalog; keep it disposable and empty so the
 // offline fixture can never pick up the real user's extensions or MCP servers.
 const childAgentDir = join(base, "child-agent");
 await mkdir(childAgentDir, { recursive: true });
 const store = new ManagedSessionStore(base); const events: AgentExecutionEvent[] = []; const results: Array<{ tool: string; isError: boolean; text: string }> = [];
 let service!: ContinuationService, ctx!: ExtensionContext;
 const extension = (pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: options => runChild({ ...options,
   env: { ...process.env, PI_CODING_AGENT_DIR: childAgentDir, PI_EXTENSIONS_ASYNC_GATES: base, PI_EXTENSIONS_ASYNC_TASK: options.task.id },
   invocation: { command: process.execPath, args: [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("fixtures/agents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
  }) });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.events.on(AGENT_EXECUTION_EVENT, event => { events.push(event as AgentExecutionEvent); });
  pi.on("tool_execution_end", event => { if (["invoke_agent", "wait_agents", "message_agent", "agent_candidate"].includes(event.toolName)) results.push({ tool: event.toolName, isError: event.isError, text: JSON.stringify(event.result.content) }); });
 };
 const trace = createTrace();
 const h = await createHostHarness({ mode: "rpc", realSessionFile: true, trace, extensions: [noticesExtension, nativeFixture, tasklistExtension, extension, createTraceObserver(trace)] });
 t.after(async () => {
  await service.shutdown();
  if (ctx) for (const view of await service.contextIndex(ctx)) {
   const closed = await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx);
   assert.equal(closed.status, "succeeded");
  }
  assert.equal((await exec("git", ["-C", h.workDir, "worktree", "list", "--porcelain"])).stdout.split("worktree ").length - 1, 1);
  assert.equal((await exec("git", ["-C", h.workDir, "for-each-ref", "--format=%(refname)", "refs/pi-extensions/agents"])).stdout, "");
  await h.dispose(); await rm(base, { recursive: true, force: true });
 });
 await exec("git", ["init", "-q", h.workDir]); await writeFile(join(h.workDir, "dirty.txt"), "dirty input\n");
 const state = () => (h.session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "tasklist.state") as { data: { state: TasklistState } }).data.state;
 const latest = (id: string): SessionView => events.flatMap(event => event.sessions).filter(view => view.result?.label === id).sort((a, b) => b.episode - a.episode)[0]!;
 const apply = (name: string) => tool("agent_candidate", { name, action: "apply" });
 h.faux.setResponses([
  contract({ operation: "set", title: "fixture implementation", tasks: [{ id: "t", title: "Source work" }] }),
  contract({ operation: "update", tasks: [{ id: "t", status: "doing" }] }),
  fauxAssistantMessage(["fast", "slow"].map(name => fauxToolCall("invoke_agent", { name, role: "worker", prompt: "host-worker-fixture", access: [{ permission: "write", scope: h.workDir }], workspace: "isolated", model: "agent-fixture/fixture", thinking: "off" }))),
  tool("bash", { command: "printf independent > parent-progress" }),
  contract({ operation: "update", tasks: [{ id: "t", note: "Submitted; parent made independent progress" }] }), fauxAssistantMessage("waiting"),
 ]);
 await h.session.prompt("implement fixture");
 await until(() => h.faux.getPendingResponseCount() === 0 && !h.session.isStreaming);
 assert.deepEqual(results.slice(0, 2).map(({ tool, isError }) => ({ tool, isError })), [{ tool: "invoke_agent", isError: false }, { tool: "invoke_agent", isError: false }]);
 await until(async () => { await access(join(base, "started-fast")); await access(join(base, "started-slow")); return true; });
 assert.equal(await readFile(join(h.workDir, "parent-progress"), "utf8"), "independent"); assert.equal(state().tasks[0]!.status, "doing"); assert.equal(events.length, 0);
 let slowView!: SessionView;
 await until(async () => { const inspected = await service.execute({ action: "inspect" }, ctx); slowView = inspected.sessions.find(view => view.label === "slow")!; return slowView?.liveActivity?.calls.some(call => call.tool === "bash" && call.status === "running") === true; });
 assert.equal(slowView.state, "running"); assert.equal(slowView.candidate, undefined, "an active writer cannot expose an applicable candidate");
 assert.ok(slowView.liveActivity!.calls.every(call => call.id && call.startedMs !== null));
 const liveInputs: TranscriptContext[] = [];
 h.faux.setResponses([
  tool("bash", { command: "printf first > parent-progress" }),
  providerContext => { liveInputs.push(structuredClone(providerContext)); return tool("bash", { command: "printf second > parent-progress" }); },
  providerContext => { liveInputs.push(structuredClone(providerContext)); return fauxAssistantMessage("independent work; children still running"); },
 ]);
 await h.session.prompt("continue independent work while both children remain active");
 assert.equal(liveInputs.length, 2);
 assert.deepEqual(liveInputs[1]!.messages.slice(0, liveInputs[0]!.messages.length), liveInputs[0]!.messages, "ordinary tool turns with an active tasklist and live children preserve the complete previous provider input prefix");
 assert.equal(JSON.stringify(liveInputs).includes("Current child tool activity"), false);
 let liveWire = "";
 h.faux.setResponses([providerContext => { liveWire = JSON.stringify(providerContext.messages); return apply("fast"); }, fauxAssistantMessage("early apply; sibling still running")]);
 await writeFile(join(base, "release-fast"), "go");
 await until(async () => (await readFile(join(h.workDir, "fast.txt"), "utf8")) === "candidate-1" && h.session.isStreaming === false);
 assert.equal(events.some(event => event.kind === "task-terminal" && event.sessions.some(view => view.label === "slow")), false); assert.notEqual(state().tasks[0]!.status, "done");
 assert.equal(liveWire.includes("Current child tool activity"), false, "running sibling must not inject volatile live activity into parent provider context");
 const fast = latest("fast"), before = await store.load(fast.handle, { repo: h.workDir, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) });
 h.faux.setResponses([
  contract({ operation: "update", tasks: [{ id: "t", note: "Repair requested" }] }),
  tool("agent_candidate", { name: "fast", action: "refresh" }),
  tool("message_agent", { to: "fast", message: "host-worker-fixture" }),
  tool("wait_agents", { names: ["fast"], waitSeconds: 15 }), apply("fast"), fauxAssistantMessage("repair applied; still waiting for sibling"),
 ]);
 await h.session.prompt("repair fast task explicitly");
 await until(() => h.faux.getPendingResponseCount() === 0 && !h.session.isStreaming);
 assert.equal(await readFile(join(h.workDir, "fast.txt"), "utf8"), "candidate-2", JSON.stringify(results.slice(-4)));
 const after = await store.load(fast.handle, { repo: h.workDir, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) });
 assert.equal(after.roots.find(root => root.permission === "write")?.inputs?.gitWorkspace?.path, before.roots.find(root => root.permission === "write")?.inputs?.gitWorkspace?.path); assert.notEqual(after.nativeLeaf, before.nativeLeaf);
 h.faux.setResponses([tool("wait_agents", { names: ["slow"] }), apply("slow"), contract({ operation: "cancel" }), fauxAssistantMessage("done")]);
 await writeFile(join(base, "release-slow"), "go"); await until(() => state().tasks.every(task => task.status === "cancelled") && h.session.isStreaming === false);
 assert.equal(latest("slow").episode, 1, "repairing fast never rebinds the sibling turn");
 assert.equal(await readFile(join(h.workDir, "slow.txt"), "utf8"), "candidate-1"); assert.notEqual(state().tasks[0]!.status, "done"); assert.deepEqual(h.errors, []);
 assert.ok(results.every(result => !result.isError), JSON.stringify(results));
});
