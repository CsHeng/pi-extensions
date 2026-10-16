
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
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContinuationTool, type ContinuationService } from "../extensions/subagents/continuation.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { runChild } from "../extensions/subagents/runner.ts";
import { SUBAGENT_EXECUTION_EVENT, type SubagentExecutionEvent } from "../extensions/shared/subagent-execution.ts";
import type { SessionActionResult, SessionView } from "../extensions/subagents/session-contracts.ts";
import loopNotifications from "../extensions/loop-notifications/index.ts";
import { LOOP_NOTICE_TYPE } from "../extensions/shared/loop-facts.ts";
import workflow from "../extensions/workflow/index.ts";
import type { GoalState } from "../extensions/workflow/goal-contracts.ts";
import nativeFixture from "./fixtures/subagents-native-session.ts";
import { createHostHarness, createTrace, createTraceObserver } from "./fixtures/workflow/host-fixture.ts";
const exec = promisify(execFile);

for (const consume of ["join", "inspect", "close", "mixed"] as const) test(`real host ${consume} consumes terminal notifications without a stale provider turn`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-wake-consumed-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal!: () => void, context!: ExtensionContext, service!: ContinuationService, receipt!: SessionActionResult;
 const gate = new Promise<void>(resolve => { release = resolve; }); const completed = new Promise<void>(resolve => { terminal = resolve; }); const wakes: string[] = []; let providerEvidence = "";
 const h = await createHostHarness({ mode: "rpc", extensions: [loopNotifications, (pi: ExtensionAPI) => {
  service = registerContinuationTool({ ...pi, sendMessage(message, options) {
   if (options?.triggerTurn && message.customType === SUBAGENT_EXECUTION_EVENT) { assert.equal(context.isIdle(), true); wakes.push(String(message.content)); }
   pi.sendMessage(message, options);
  } }, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, ctx) => { context = ctx; });
  pi.on("tool_result", event => { const result = event.details as SessionActionResult; if (event.toolName === "csheng_subagent_sessions" && result.action === "create") receipt = result; });
  pi.events.on(SUBAGENT_EXECUTION_EVENT, event => { if ((event as SubagentExecutionEvent).kind === "run-terminal") terminal(); });
  pi.registerTool({ name: "drain_children", label: "Drain fixture", description: "Release owned fixture children while parent tool holds the turn", parameters: Type.Object({}), async execute() { release(); await completed; return { content: [{ type: "text", text: "terminal" }], details: {} }; } });
 }] });
 t.after(async () => { release(); await service.shutdown(); if (context) for (const view of await service.contextIndex(context)) assert.equal((await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context)).status, "succeeded"); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([
  managed({ action: "create", requestId: "consume", tasks: (consume === "mixed" ? ["one", "two"] : ["one"]).map(id => ({ id, role: "explorer", objective: "inspect", access: [{ permission: "read", scope: "/tmp/scope" }] })) }), tool("drain_children", {}),
  providerContext => { providerEvidence = JSON.stringify(providerContext.messages); return managed(consume === "join" ? { action: "join", runId: receipt.runId } : consume === "close" ? { action: "close", handle: receipt.sessions[0]!.handle, expectedEpisode: 1, disposition: "discard" } : { action: "inspect", handle: receipt.sessions[0]!.handle }); },
  fauxAssistantMessage("parent work finished"), fauxAssistantMessage("unobserved evidence received"),
 ]);
 await h.session.prompt("bounded notification fixture"); await new Promise(resolve => setImmediate(resolve));
 assert.equal(h.faux.state.callCount, 4); assert.deepEqual(wakes, []);
 assert.ok(providerEvidence.includes("Inspect terminal evidence"));
 for (const view of receipt.sessions) assert.ok(providerEvidence.includes(view.handle), "ready sibling facts must reach the ongoing provider request without an extra wake");
 assert.deepEqual(h.errors, []);
});

test("blocked work can resume, yield fully idle, and receive one child terminal without polling", { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-blocked-yield-")); const store = new ManagedSessionStore(base);
 let release!: () => void, ctx!: ExtensionContext, service!: ContinuationService, started = false, terminalWire = "", evidenceWire = "", handle = "", wakes = 0;
 const gate = new Promise<void>(resolve => { release = resolve; }); const trace = createTrace();
 const h = await createHostHarness({ mode: "rpc", trace, extensions: [loopNotifications, workflow, (pi: ExtensionAPI) => {
  service = registerContinuationTool({ ...pi, sendMessage(message, options) {
   if (options?.triggerTurn && message.customType === SUBAGENT_EXECUTION_EVENT) { assert.equal(ctx.isIdle(), true); wakes++; }
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
  tool("csheng_workflow", { operation: "set", goal: "Verify resumed execution", tasks: [{ id: "verify", title: "Verify", status: "blocked", note: "Await user prerequisite" }] }),
  fauxAssistantMessage("Waiting for the user prerequisite"),
 ]);
 await h.session.prompt("Start verification"); assert.equal(h.faux.state.callCount, 2);
 h.faux.setResponses([
  tool("csheng_workflow", { operation: "update", tasks: [{ id: "verify", status: "doing", note: null }] }),
  managed({ action: "create", requestId: "yield", tasks: [{ id: "verify", role: "explorer", objective: "inspect fixture", access: [{ permission: "read", scope: "/tmp/scope" }] }] }),
  fauxAssistantMessage("Execution is pending; this turn can end without completing the task"),
  context => { terminalWire = JSON.stringify(context.messages); return managed({ action: "inspect", handle }); },
  context => { evidenceWire = JSON.stringify(context.messages); return tool("csheng_workflow", { operation: "update", tasks: [{ id: "verify", status: "done" }] }); },
  fauxAssistantMessage("Execution evidence collected"),
 ]);
 await h.session.prompt("Prerequisite resolved; continue");
 await until(() => started && h.faux.state.callCount === 5 && !h.session.isStreaming);
 const state = () => h.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "csheng-workflow-state").at(-1) as { data: { state: GoalState } };
 assert.equal(state().data.state.tasks[0]?.status, "doing"); assert.equal(state().data.state.paused, false); assert.equal(wakes, 0);
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 5, "pending work alone must not keep requesting the provider");
 handle = (await service.contextIndex(ctx))[0]!.handle;
 release(); await until(() => h.faux.state.callCount === 8 && !h.session.isStreaming);
 assert.equal(wakes, 0, "the executor does not wake; the consumer delivers the terminal"); assert.ok(terminalWire.includes("Inspect terminal evidence")); assert.ok(evidenceWire.includes("released child evidence"));
 assert.equal(state().data.state.tasks[0]?.status, "done");
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 8); assert.deepEqual(h.errors, []);
});

for (const boundary of ["settlement", "compaction", "compaction-abort", "compaction-abort-late"] as const) test(`completion waits across a held public ${boundary} boundary`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-wake-boundary-")); const store = new ManagedSessionStore(base);
 let releaseChild!: () => void, releaseBoundary!: () => void, entered = false, terminal = false, holding = false, badWake = false, waits = 0, context!: ExtensionContext, service!: ContinuationService, work: Promise<unknown> | undefined;
 const childGate = new Promise<void>(resolve => { releaseChild = resolve; }), boundaryGate = new Promise<void>(resolve => { releaseBoundary = resolve; });
 let releaseFailure!: () => void, failureEntered = false; const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
 const h = await createHostHarness({ mode: "rpc", settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } }, extensions: [loopNotifications, (pi: ExtensionAPI) => {
  if (boundary === "compaction-abort-late") pi.on("session_compact_failed", async () => { failureEntered = true; holding = true; await failureGate; holding = false; });
  pi.on("input", event => { if (String(event.text ?? "").startsWith("/csheng-loop-notifications-wait ")) waits++; });
  service = registerContinuationTool({ ...pi, sendMessage(message, options) { if (options?.triggerTurn && holding) badWake = true; pi.sendMessage(message, options); } }, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await childGate; options.onChildSettled?.(); return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, ctx) => { context = ctx; }); pi.events.on(SUBAGENT_EXECUTION_EVENT, event => { if ((event as SubagentExecutionEvent).kind === "run-terminal") terminal = true; });
  if (boundary === "settlement") pi.on("agent_settled", async () => { if (!entered) { entered = true; holding = true; await boundaryGate; holding = false; } });
  else pi.on("session_before_compact", async event => { entered = true; holding = true; await boundaryGate; holding = false; return { compaction: { summary: "owned fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }; });
 }] });
 t.after(async () => { releaseChild(); releaseBoundary(); releaseFailure(); await work?.catch(() => {}); await service.shutdown(); if (context) for (const view of await service.contextIndex(context)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([managed({ action: "create", requestId: "boundary", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: "/tmp/scope" }] }] }), fauxAssistantMessage("parent work finished"), fauxAssistantMessage("unobserved result received")]);
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
  pi.on("agent_start", (_event, ctx) => { context = ctx; }); pi.events.on(SUBAGENT_EXECUTION_EVENT, () => { terminal = true; });
 }, createTraceObserver(trace)] });
 t.after(async () => { release(); await h.session.abort(); await service.shutdown(); if (context) for (const view of await service.contextIndex(context)) assert.equal((await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context)).status, "succeeded"); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([managed({ action: "create", requestId: "abort", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: "/tmp/scope" }] }] }), tool("bash", { command: "sleep 30" }), fauxAssistantMessage("must not resume after abort")]);
 const running = h.session.prompt("bounded fixture"); await until(() => trace.entries.some(entry => entry.event === "tool_start" && entry.detail?.toolName === "bash"));
 release(); await until(() => terminal); await new Promise(resolve => setImmediate(resolve)); await h.session.abort(); await running;
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 2); assert.equal(h.session.isStreaming, false); assert.deepEqual(h.errors, []);
});
for (const aggregate of ["failed", "partial"] as const) test(`returned ${aggregate} evidence consumes a delayed notification despite isError`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-failure-consumed-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal!: () => void, ctx!: ExtensionContext, service!: ContinuationService, receipt!: SessionActionResult, returned!: SessionActionResult, isError = false;
 const delayed: SubagentExecutionEvent[] = [];
 const gate = new Promise<void>(resolve => { release = resolve; }), completion = new Promise<void>(resolve => { terminal = resolve; });
 const h = await createHostHarness({ mode: "rpc", extensions: [(pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), onWake: events => { delayed.push(...events); }, runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: options.task.id === "failed" ? "failed" : "succeeded", reportComplete: true, output: "returned failure is evidence", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.on("tool_execution_end", event => { if (event.toolName !== "csheng_subagent_sessions") return; const details = event.result.details as SessionActionResult; if (details.action === "create") receipt = details; if (details.action === "join") { returned = details; isError = event.isError; } });
  pi.events.on(SUBAGENT_EXECUTION_EVENT, event => { if ((event as SubagentExecutionEvent).kind === "run-terminal") terminal(); });
  pi.registerTool({ name: "drain_failure", label: "Drain failure fixture", description: "Release fixture child", parameters: Type.Object({}), async execute() { release(); await completion; return { content: [{ type: "text", text: "terminal" }], details: {} }; } });
 }] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([managed({ action: "create", requestId: "failure", tasks: (aggregate === "partial" ? ["failed", "succeeded"] : ["failed"]).map(id => ({ id, role: "explorer", objective: "inspect", access: [{ permission: "read", scope: "/tmp/scope" }] })) }), tool("drain_failure", {}), () => managed({ action: "join", runId: receipt.runId }), fauxAssistantMessage("failure evidence collected, not accepted")]);
 await h.session.prompt("fixture");
 assert.equal(returned.status, aggregate); assert.equal(isError, true); assert.ok(delayed.length > 0);
 assert.deepEqual(await service.unobservedWake(delayed, ctx), [], "the delivered failure result must fence a later notification");
 assert.equal(h.faux.state.callCount, 4); assert.deepEqual(h.errors, []);
});

test("queued but dropped completion is not acknowledged, and a new input can explicitly collect it", { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-dropped-notice-")); const store = new ManagedSessionStore(base);
 let release!: () => void, ctx!: ExtensionContext, service!: ContinuationService, receipt!: SessionActionResult;
 let terminalEvent!: SubagentExecutionEvent;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const h = await createHostHarness({ mode: "rpc", extensions: [(pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
   options.onChildStarted?.(); await gate; options.onChildSettled?.();
   return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "one execution", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
  } });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.on("tool_execution_end", event => { if (event.toolName === "csheng_subagent_sessions" && (event.result.details as SessionActionResult).action === "create") receipt = event.result.details as SessionActionResult; });
  pi.events.on(SUBAGENT_EXECUTION_EVENT, raw => { const event = raw as SubagentExecutionEvent; if (event.kind === "task-terminal") terminalEvent = event; });
 }] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 h.faux.setResponses([managed({ action: "create", requestId: "dropped", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: "/tmp/scope" }] }] }), fauxAssistantMessage("waiting for a real event")]);
 await h.session.prompt("start fixture"); release(); await until(() => !!terminalEvent);
 assert.equal((await service.unobservedWake([terminalEvent], ctx)).length, 1, "publication alone must not consume terminal evidence");
 assert.equal(h.faux.state.callCount, 2);
 let wire = "";
 h.faux.setResponses([managed({ action: "inspect", handle: receipt.sessions[0]!.handle }), providerContext => { wire = JSON.stringify(providerContext.messages); return fauxAssistantMessage("explicit result collected"); }]);
 await h.session.prompt("collect explicitly; supersede the dropped queue");
 assert.ok(wire.includes("one execution")); assert.ok(!wire.includes("Inspect terminal evidence"), "a superseded queued notice must not reappear from history");
 assert.deepEqual(await service.unobservedWake([terminalEvent], ctx), []);
 assert.equal(h.faux.state.callCount, 4); assert.deepEqual(h.errors, []);
});

for (const order of ["workflow-first", "executor-first"] as const) test(`completion and task renewal reach separate provider turns (${order})`, { timeout: 20000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "async-reminder-merge-")); const store = new ManagedSessionStore(base);
 let release!: () => void, terminal!: () => void, ctx!: ExtensionContext, service!: ContinuationService, released = false, providerWire = "";
 const terminalContents: string[] = [], reminderContents: string[] = [];
 const notifications = (pi: ExtensionAPI) => loopNotifications({ ...pi,
  sendMessage(message, options) {
   if (message.customType === LOOP_NOTICE_TYPE && options?.triggerTurn) terminalContents.push(String(message.content));
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
  pi.events.on(SUBAGENT_EXECUTION_EVENT, event => { if ((event as SubagentExecutionEvent).kind === "run-terminal") terminal(); });
  pi.on("agent_settled", async () => { if (!released) { released = true; release(); await completion; } });
 };
 const h = await createHostHarness({ mode: "rpc", extensions: order === "workflow-first" ? [notifications, workflow, executor] : [executor, workflow, notifications] });
 t.after(async () => { release(); await service.shutdown(); if (ctx) for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await h.dispose(); await rm(base, { recursive: true, force: true }); });
 await exec("git", ["init", "-q", h.workDir]);
 let reminderWire = "";
 h.faux.setResponses([contract({ operation: "set", goal: "independent work", tasks: [{ id: "running", title: "Child", status: "doing" }, { id: "ready", title: "Independent task" }] }), managed({ action: "create", requestId: "merge", tasks: [{ id: "child", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: "/tmp/scope" }] }] }), fauxAssistantMessage("settle with ready work"), providerContext => { providerWire = JSON.stringify(providerContext.messages); return fauxAssistantMessage("terminal evidence received"); }, providerContext => { reminderWire = JSON.stringify(providerContext.messages); return fauxAssistantMessage("independent work resumed"); }]);
 await h.session.prompt("fixture"); await until(() => h.faux.state.callCount === 5 && !h.session.isStreaming);
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(h.faux.state.callCount, 5, "the terminal notice and the later task renewal are separate turns");
 assert.equal(terminalContents.length, 1);
 assert.equal(reminderContents.length, 1);
 assert.ok(providerWire.includes(JSON.stringify(terminalContents[0])), "the terminal notice reaches its provider turn");
 assert.equal(providerWire.includes(JSON.stringify(reminderContents[0])), false, "the terminal turn has no task renewal payload");
 assert.ok(reminderWire.includes(JSON.stringify(reminderContents[0])), "the subsequent turn receives the task renewal payload");
 assert.deepEqual(h.errors, []);
});

const tool = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never));
const managed = (args: unknown) => tool("csheng_subagent_sessions", args);
const contract = (args: unknown) => tool("csheng_workflow", args);
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
 const store = new ManagedSessionStore(base); const events: SubagentExecutionEvent[] = []; const results: SessionActionResult[] = [];
 let service!: ContinuationService, ctx!: ExtensionContext;
 const extension = (pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: options => runChild({ ...options,
   env: { ...process.env, PI_CODING_AGENT_DIR: childAgentDir, CSHENG_ASYNC_GATES: base, CSHENG_ASYNC_TASK: options.task.id },
   invocation: { command: process.execPath, args: [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
  }) });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.events.on(SUBAGENT_EXECUTION_EVENT, event => { events.push(event as SubagentExecutionEvent); });
  pi.on("tool_execution_end", event => { if (event.toolName === "csheng_subagent_sessions") results.push(event.result.details as SessionActionResult); });
 };
 const trace = createTrace();
 const h = await createHostHarness({ mode: "rpc", realSessionFile: true, trace, extensions: [loopNotifications, nativeFixture, workflow, extension, createTraceObserver(trace)] });
 t.after(async () => {
  await service.shutdown();
  if (ctx) for (const view of await service.contextIndex(ctx)) {
   const closed = await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx);
   assert.equal(closed.status, "succeeded");
  }
  assert.equal((await exec("git", ["-C", h.workDir, "worktree", "list", "--porcelain"])).stdout.split("worktree ").length - 1, 1);
  assert.equal((await exec("git", ["-C", h.workDir, "for-each-ref", "--format=%(refname)", "refs/csheng/subagents"])).stdout, "");
  await h.dispose(); await rm(base, { recursive: true, force: true });
 });
 await exec("git", ["init", "-q", h.workDir]); await writeFile(join(h.workDir, "dirty.txt"), "dirty input\n");
 const state = () => (h.session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "csheng-workflow-state") as { data: { state: GoalState } }).data.state;
 const latest = (id: string): SessionView => events.flatMap(event => event.sessions).filter(view => view.result?.id === id).sort((a, b) => b.episode - a.episode)[0]!;
 const apply = (view: SessionView) => managed({ action: "apply", handle: view.handle, expectedEpisode: view.episode, candidateId: view.candidate!.id });
 h.faux.setResponses([
  contract({ operation: "set", goal: "fixture implementation", tasks: [{ id: "t", title: "Source work" }] }),
  contract({ operation: "update", tasks: [{ id: "t", status: "doing" }] }),
  managed({ action: "create", requestId: "pair", tasks: ["fast", "slow"].map(id => ({ id, role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: h.workDir }], model: "subagent-fixture/fixture", thinking: "off" })) }),
  tool("bash", { command: "printf independent > parent-progress" }),
  contract({ operation: "update", tasks: [{ id: "t", note: "Submitted; parent made independent progress" }] }), fauxAssistantMessage("waiting"),
 ]);
 await h.session.prompt("implement fixture");
 await until(() => h.faux.getPendingResponseCount() === 0 && !h.session.isStreaming);
 assert.equal(results[0]?.status, "accepted", JSON.stringify(results[0])); const runId = results[0]!.runId;
 await until(async () => { await access(join(base, "started-fast")); await access(join(base, "started-slow")); return true; });
 assert.equal(await readFile(join(h.workDir, "parent-progress"), "utf8"), "independent"); assert.equal(state().tasks[0]!.status, "doing"); assert.equal(events.length, 0);
 let slowView!: SessionView;
 await until(async () => { const inspected = await service.execute({ action: "inspect", runId }, ctx); slowView = inspected.sessions.find(view => view.handle === results[0]!.sessions[1]!.handle)!; return slowView?.liveActivity?.calls.some(call => call.tool === "bash" && call.status === "running") === true; });
 assert.equal(slowView.state, "running"); assert.equal(slowView.candidate, undefined, "an active writer cannot expose an applicable candidate");
 assert.ok(slowView.liveActivity!.calls.every(call => call.id && call.startedMs !== null));
 let liveWire = "";
 h.faux.setResponses([providerContext => { liveWire = JSON.stringify(providerContext.messages); return apply(latest("fast")); }, fauxAssistantMessage("early apply; sibling still running")]);
 await writeFile(join(base, "release-fast"), "go");
 await until(async () => (await readFile(join(h.workDir, "fast.txt"), "utf8")) === "candidate-1" && h.session.isStreaming === false);
 assert.equal(events.some(event => event.kind === "run-terminal"), false); assert.notEqual(state().tasks[0]!.status, "done");
 assert.ok(liveWire.includes("Current child tool activity")); assert.ok(liveWire.includes(slowView.handle)); assert.ok(liveWire.includes(slowView.liveActivity!.calls[0]!.id), "same live native call must reach the actual provider while its writer is still running");
 const fast = latest("fast"), before = await store.load(fast.handle, { repo: h.workDir, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) });
 h.faux.setResponses([
  contract({ operation: "update", tasks: [{ id: "t", note: "Repair requested" }] }),
  managed({ action: "refresh", handle: fast.handle, expectedEpisode: 1 }),
  managed({ action: "continue", mode: "foreground", episodes: [{ handle: fast.handle, expectedEpisode: 1, requestId: "repair", message: "host-worker-fixture" }] }),
  () => apply(latest("fast")), fauxAssistantMessage("repair applied; still waiting for sibling"),
 ]);
 await h.session.prompt("repair fast task explicitly");
 await until(() => h.faux.getPendingResponseCount() === 0 && !h.session.isStreaming);
 assert.equal(await readFile(join(h.workDir, "fast.txt"), "utf8"), "candidate-2");
 const after = await store.load(fast.handle, { repo: h.workDir, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) });
 assert.equal(after.roots.find(root => root.permission === "write")?.inputs?.gitWorkspace?.path, before.roots.find(root => root.permission === "write")?.inputs?.gitWorkspace?.path); assert.notEqual(after.nativeLeaf, before.nativeLeaf);
 h.faux.setResponses([managed({ action: "join", runId }), () => apply(latest("slow")), contract({ operation: "cancel", reason: "fixture transport proof is not semantic acceptance" }), fauxAssistantMessage("done")]);
 await writeFile(join(base, "release-slow"), "go"); await until(() => state().cancelled === true && h.session.isStreaming === false);
 assert.equal(results.findLast(result => result.action === "join")!.sessions.find(view => view.handle === fast.handle)!.episode, 1);
 assert.equal(await readFile(join(h.workDir, "slow.txt"), "utf8"), "candidate-1"); assert.notEqual(state().tasks[0]!.status, "done"); assert.deepEqual(h.errors, []);
 assert.ok(results.every(result => ["accepted", "succeeded"].includes(result.status)), JSON.stringify(results.map(result => ({ action: result.action, status: result.status, error: result.error }))));
});
