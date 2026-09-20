import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContinuationTool, type ContinuationService } from "../extensions/subagents/continuation.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { runChild } from "../extensions/subagents/runner.ts";
import { SUBAGENT_EXECUTION_EVENT, type SubagentExecutionEvent } from "../extensions/shared/subagent-execution.ts";
import type { SessionActionResult, SessionView } from "../extensions/subagents/session-contracts.ts";
import workflow from "../extensions/workflow/index.ts";
import type { GoalState } from "../extensions/workflow/goal-contracts.ts";
import nativeFixture from "./fixtures/subagents-native-session.ts";
import { createHostHarness, createTrace, createTraceObserver } from "./fixtures/workflow/host-fixture.ts";
const exec = promisify(execFile);

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
 h.faux.setResponses([managed({ action: "create", requestId: "abort", tasks: [{ id: "scan", role: "explorer", objective: "inspect", scope: ["."] }] }), tool("bash", { command: "sleep 30" }), fauxAssistantMessage("must not resume after abort")]);
 const running = h.session.prompt("bounded fixture"); await until(() => trace.entries.some(entry => entry.event === "tool_start" && entry.detail?.toolName === "bash"));
 release(); await until(() => terminal); await new Promise(resolve => setImmediate(resolve)); await h.session.abort(); await running;
 await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.faux.state.callCount, 2); assert.equal(h.session.isStreaming, false); assert.deepEqual(h.errors, []);
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
 const store = new ManagedSessionStore(base); const events: SubagentExecutionEvent[] = []; const results: SessionActionResult[] = [];
 let service!: ContinuationService, ctx!: ExtensionContext;
 const extension = (pi: ExtensionAPI) => {
  service = registerContinuationTool(pi, { store, loadConfig: async () => ({ config: defaultConfig() }), runChild: options => runChild({ ...options,
   env: { ...process.env, CSHENG_ASYNC_GATES: base, CSHENG_ASYNC_TASK: options.task.id },
   invocation: { command: process.execPath, args: [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
  }) });
  pi.on("agent_start", (_event, context) => { ctx = context; });
  pi.events.on(SUBAGENT_EXECUTION_EVENT, event => { events.push(event as SubagentExecutionEvent); });
  pi.on("tool_execution_end", event => { if (event.toolName === "csheng_subagent_sessions") results.push(event.result.details as SessionActionResult); });
 };
 const trace = createTrace();
 const h = await createHostHarness({ mode: "rpc", realSessionFile: true, trace, extensions: [nativeFixture, workflow, extension, createTraceObserver(trace)] });
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
  contract({ operation: "enroll", goal: "fixture implementation", delivery: "local source", authority: "offline fixture", requirements: [{ key: "r", outcome: "reviewed source", verification: "parent check" }], tasks: [{ key: "t", title: "Source work", covers: ["r"] }] }),
  contract({ operation: "start", task: "t", scope: ["dirty.txt"] }),
  managed({ action: "create", requestId: "pair", tasks: ["fast", "slow"].map(id => ({ id, role: "worker", objective: "host-worker-fixture", scope: ["."], model: "subagent-fixture/fixture", thinking: "off" })) }),
  tool("bash", { command: "printf independent > parent-progress" }),
  contract({ operation: "report", attempt: "A1", summary: "Submitted; parent made independent progress, not accepted" }), fauxAssistantMessage("waiting"),
 ]);
 await h.session.prompt("implement fixture");
 assert.equal(results[0]?.status, "accepted", JSON.stringify(results[0])); const runId = results[0]!.runId;
 await until(async () => { await access(join(base, "started-fast")); await access(join(base, "started-slow")); return true; });
 assert.equal(await readFile(join(h.workDir, "parent-progress"), "utf8"), "independent"); assert.equal(state().continuation.state, "waiting"); assert.equal(events.length, 0);
 h.faux.setResponses([() => apply(latest("fast")), fauxAssistantMessage("early apply; sibling still running")]);
 await writeFile(join(base, "release-fast"), "go");
 await until(async () => (await readFile(join(h.workDir, "fast.txt"), "utf8")) === "candidate-1" && h.session.isStreaming === false);
 assert.equal(events.some(event => event.kind === "run-terminal"), false); assert.equal(state().acceptance.length, 0);
 const fast = latest("fast"), before = await store.load(fast.handle, { repo: h.workDir, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) });
 h.faux.setResponses([
  contract({ operation: "amend", alignment: "Same fixture authority; explicit repair requested", reason: "repair", authority: "offline fixture" }),
  managed({ action: "refresh", handle: fast.handle, expectedEpisode: 1 }),
  managed({ action: "continue", mode: "foreground", episodes: [{ handle: fast.handle, expectedEpisode: 1, requestId: "repair", message: "host-worker-fixture" }] }),
  () => apply(latest("fast")), fauxAssistantMessage("repair applied; still waiting for sibling"),
 ]);
 await h.session.prompt("repair fast task explicitly");
 assert.equal(await readFile(join(h.workDir, "fast.txt"), "utf8"), "candidate-2");
 const after = await store.load(fast.handle, { repo: h.workDir, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) });
 assert.equal(after.workspace!.inputs.gitWorkspace!.path, before.workspace!.inputs.gitWorkspace!.path); assert.notEqual(after.nativeLeaf, before.nativeLeaf);
 h.faux.setResponses([managed({ action: "join", runId }), () => apply(latest("slow")), contract({ operation: "close", outcome: "cancelled", reason: "fixture transport proof is not semantic acceptance" }), fauxAssistantMessage("done")]);
 await writeFile(join(base, "release-slow"), "go"); await until(() => state().fulfillment === "cancelled" && h.session.isStreaming === false);
 assert.equal(results.findLast(result => result.action === "join")!.sessions.find(view => view.handle === fast.handle)!.episode, 1);
 assert.equal(await readFile(join(h.workDir, "slow.txt"), "utf8"), "candidate-1"); assert.equal(state().acceptance.length, 0); assert.deepEqual(h.errors, []);
 assert.ok(results.every(result => ["accepted", "succeeded"].includes(result.status)), JSON.stringify(results.map(result => ({ action: result.action, status: result.status, error: result.error }))));
});
