/** Public host adapter: no private loop calls, timers, provider or child dispatch. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPreparedInputTracker } from "../shared/prepared-input.ts";
import { summarizeHostObservation, MANAGED_SESSION_TOOL_NAME, type ManagedResultObservation } from "./observation.ts";
import { registerSettlementBarrier } from "../shared/settlement.ts";
import { createGoalStore } from "./goal-store.ts";
import { accepted, digest } from "./goal-state.ts";
import { SUBAGENT_EXECUTION_EVENT, type SubagentExecutionEvent } from "../shared/subagent-execution.ts";
import { goalContext, goalReceipt, registerGoalTool } from "./goal-tool.ts";
import { registerGoalUi } from "./goal-ui.ts";

/** Stable host check/outcome identity. Free-form output differences are not certified semantic progress. */
export function hostCheckIdentity(toolName: string, args: unknown, result: unknown): string | undefined {
 const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
 try {
  const input = JSON.stringify(args);
  if (input.length > 65536) return undefined;
  let outcome: unknown = null;
  if (result && typeof result === "object") {
   if (toolName === MANAGED_SESSION_TOOL_NAME) {
    const managed = result as ManagedResultObservation;
    outcome = { action: managed.action, status: managed.status, sessions: managed.sessions.map(session => ({ role: session.role, state: session.state, reportComplete: session.reportComplete,
     ...(session.candidate ? { candidate: { status: session.candidate.status, changedPaths: session.candidate.changedPaths, appliedPaths: session.candidate.appliedPaths } } : {}),
    })) };
   } else {
    const observed = result as { isError?: boolean; exitCode?: number };
    outcome = { isError: observed.isError, exitCode: observed.exitCode };
   }
  }
  // Timeouts are execution controls, not a new check on the same input/outcome.
  const check = args && typeof args === "object" && !Array.isArray(args) ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "timeout" && key !== "timeoutMs")) : args;
  return digest([toolName, stable(check), stable(outcome)]);
 } catch { return undefined; }
}
const REMINDER = "csheng-workflow-goal-alignment";
export default function goalWorkflow(pi: ExtensionAPI): void {
 const store = createGoalStore((type, data) => pi.appendEntry(type, data));
 const ui = registerGoalUi(pi, store);
 const tracker = createPreparedInputTracker();
 const barrier = registerSettlementBarrier(pi, { command: "csheng-workflow-wait", tool: "csheng_workflow", enabled: () => {
  const state = store.current();
  return state?.fulfillment === "pending" && state.continuation.state === "active" && state.input.aligned;
 } });
 const stopArming = store.subscribe(() => { barrier.arm(); });
 let fenced = false; let epoch = 0; let stopped = false; let projected: number | undefined;
 type Capture = Awaited<ReturnType<typeof store.capture>> & { input: string | undefined };
 const captures = new Map<string, Capture>();
 const executionCaptures = new Map<string, { capture: Capture; contractId: string }>();
 const dispatches = new Map<string, { capture: Capture; sessionId: string; contractId: string; anchor: string | null }>();
 const pending = new Map<string, { call: string; tasks: Set<string> }>();
 const terminalTasks = new Set<string>(); const terminalRuns = new Set<string>(); const seenEvents = new Set<string>();
 registerGoalTool(pi, store, () => fenced);
 const reset = () => { epoch++; captures.clear(); executionCaptures.clear(); dispatches.clear(); pending.clear(); terminalTasks.clear(); terminalRuns.clear(); seenEvents.clear(); tracker.reset(); fenced = false; projected = undefined; };
 pi.on("session_start", async (_event, ctx) => { ui.detach(); reset(); const lease = epoch; store.replay(ctx.sessionManager.getBranch()); await store.revalidate(ctx.cwd); if (lease !== epoch) return; store.recover("Session recovery requires explicit reconciliation/resume."); ui.attach(ctx); });
 pi.on("session_tree", async (_event, ctx) => { ui.detach(); reset(); const lease = epoch; store.replay(ctx.sessionManager.getBranch()); await store.revalidate(ctx.cwd); if (lease !== epoch) return; store.recover("Branch replacement requires explicit reconciliation/resume."); ui.attach(ctx); });
 pi.on("session_shutdown", () => { reset(); ui.detach(); });
 pi.on("input", event => { tracker.received(event); if (event.source === "interactive" || event.source === "rpc") epoch++; });
 pi.on("before_agent_start", () => { tracker.prepare(); stopped = false; });
 pi.on("message_start", event => { tracker.observe(event.message); });
 pi.on("message_end", event => {
  if (event.message.role === "assistant" && (event.message.stopReason === "aborted" || event.message.stopReason === "error")) { stopped = true; projected = undefined; }
 });
 pi.on("context", event => {
  fenced = true;
  for (const input of tracker.peek(event.messages)) {
   if (input.provenance !== "extension") { store.delivered(input.provenance === "unknown"); epoch++; projected = undefined; }
   tracker.commit([input.id]);
  }
  fenced = false;
  const state = store.current();
  const messages = event.messages.filter(m => !(m.role === "custom" && m.customType === REMINDER));
  if (!state || state.fulfillment !== "pending" || state.input.aligned) return { messages };
  const content = `Implementation contract needs alignment with delivered input. ${state.input.unknown ? "Origin is unconfirmed; this is not new permission. " : ""}Reconcile current context against existing authority; pass alignment in the next semantic operation. ${goalReceipt(store.view())}`;
  const existing = event.messages.findIndex(m => m.role === "custom" && m.customType === REMINDER && m.content === content);
  if (existing >= 0) return { messages: event.messages.filter((m, i) => i === existing || !(m.role === "custom" && m.customType === REMINDER)) };
  if (projected === state.input.generation) return { messages };
  projected = state.input.generation;
  messages.splice(messages.findLastIndex(m => m.role === "user") + 1, 0, { role: "custom", customType: REMINDER, content, display: false, timestamp: Date.now() });
  return { messages };
 });
 pi.on("session_compact", () => { projected = undefined; });
 pi.on("tool_execution_start", async (event, ctx) => {
  if (event.toolName === "csheng_workflow") return;
  const lease = epoch; const capture = await store.capture(ctx.cwd);
  if (lease === epoch) {
   const value = { ...capture, input: hostCheckIdentity(event.toolName, event.args, null) };
   captures.set(event.toolCallId, value);
   const args = event.args as { action?: string };
   const state = store.current();
   if (event.toolName === MANAGED_SESSION_TOOL_NAME && ["create", "continue"].includes(args?.action ?? "") && state && Object.keys(capture.bases).length) {
    const binding = { capture: value, sessionId: ctx.sessionManager.getSessionId(), contractId: state.id, anchor: ctx.sessionManager.getLeafId() };
    // Historical association survives in the native branch; recovery never turns it into fresh proof.
    pi.appendEntry("csheng-workflow-execution-binding", { version: 1, toolCallId: event.toolCallId, ...binding });
    dispatches.set(event.toolCallId, binding);
    while (dispatches.size > 256) dispatches.delete(dispatches.keys().next().value!);
   }
  }
  while (captures.size > 256) captures.delete(captures.keys().next().value!);
 });
 pi.on("tool_execution_end", (event, ctx) => {
  const capture = captures.get(event.toolCallId); captures.delete(event.toolCallId);
  if (!capture) return;
  const host = summarizeHostObservation({ ...event, at: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId() });
  const details = event.result?.details as { schemaVersion?: number; action?: string; kind?: string; runId?: string; sessions?: Array<{ handle: string; episode: number; state: string; result?: unknown }> } | undefined;
  if (event.toolName === MANAGED_SESSION_TOOL_NAME && details?.schemaVersion === 3 && details.kind === "submission" && details.runId) {
   if (dispatches.has(event.toolCallId) && !terminalRuns.has(details.runId)) {
    const tasks = new Set((details.sessions ?? []).filter(session => ["queued", "running"].includes(session.state) && !terminalTasks.has(`${details.runId}:${session.handle}:${session.episode}`)).map(session => `${session.handle}:${session.episode}`));
    if (tasks.size) pending.set(details.runId, { call: event.toolCallId, tasks });
    store.pendingExecutions([...pending.keys()]);
   }
   return; // An accepted receipt is not a completed host check.
  }
  if (details?.schemaVersion === 3 && ["create", "continue"].includes(details.action ?? "")) return; // Execution events retain the original dispatch association, including foreground/replay.
  const identity = hostCheckIdentity(event.toolName, host.managed ? { action: host.managed.action } : capture.input, host.managed ?? { isError: host.isError, exitCode: host.exitCode });
  let evidence = capture;
  if (details?.schemaVersion === 3 && ["inspect", "join"].includes(details.action ?? "") && details.sessions?.some(session => session.result)) {
   const originals = details.sessions.filter(session => session.result).map(session => {
    const binding = executionCaptures.get(`${session.handle}:${session.episode}`);
    return binding?.contractId === store.current()?.id ? binding?.capture : undefined;
   });
   const first = originals[0];
   // Querying an old result is not a new execution check. Mixed or recovered bindings fail closed.
   evidence = first && originals.every(value => value && value.owner === first.owner && value.generation === first.generation && digest(value.bases) === digest(first.bases)) ? first : { ...capture, bases: {} };
  }
  store.observe({ bases: evidence.bases, owner: evidence.owner, generation: evidence.generation, host, ...(identity ? { checkIdentity: identity } : {}) });
 });
 const unsubscribeExecution = pi.events.on(SUBAGENT_EXECUTION_EVENT, raw => {
  const event = raw as SubagentExecutionEvent;
  if (!event || event.version !== 3 || typeof event.eventId !== "string" || typeof event.runId !== "string" || !["task-terminal", "run-terminal"].includes(event.kind) || !Array.isArray(event.sessions) || event.sessions.length > 10 || seenEvents.has(event.eventId)) return;
  const binding = dispatches.get(event.toolCallId); const state = store.current();
  if (!binding || !state || binding.contractId !== state.id || binding.sessionId !== event.owner?.sessionId) return;
  if (event.sessions.some(session => !session || !Number.isSafeInteger(session.episode) || typeof session.handle !== "string" || ["queued", "running"].includes(session.state))) return;
  seenEvents.add(event.eventId); while (seenEvents.size > 512) seenEvents.delete(seenEvents.values().next().value!);
  for (const session of event.sessions) {
   executionCaptures.set(`${session.handle}:${session.episode}`, { capture: binding.capture, contractId: binding.contractId });
   terminalTasks.add(`${event.runId}:${session.handle}:${session.episode}`);
   pending.get(event.runId)?.tasks.delete(`${session.handle}:${session.episode}`);
  }
  if (event.kind === "run-terminal") terminalRuns.add(event.runId);
  if (event.kind === "run-terminal" || pending.get(event.runId)?.tasks.size === 0) pending.delete(event.runId);
  while (executionCaptures.size > 2560) executionCaptures.delete(executionCaptures.keys().next().value!);
  while (terminalTasks.size > 2560) terminalTasks.delete(terminalTasks.values().next().value!);
  while (terminalRuns.size > 256) terminalRuns.delete(terminalRuns.values().next().value!);
  store.pendingExecutions([...pending.keys()]);
  const status = event.sessions.every(session => session.result?.status === "succeeded") ? "succeeded" : "failed";
  const host = summarizeHostObservation({ toolCallId: event.eventId, toolName: MANAGED_SESSION_TOOL_NAME, isError: status !== "succeeded", sessionId: binding.sessionId, result: { details: { action: "execution", status, sessions: event.sessions } } });
  const identity = hostCheckIdentity(MANAGED_SESSION_TOOL_NAME, { action: "execution" }, host.managed);
  store.observe({ bases: binding.capture.bases, owner: binding.capture.owner, generation: binding.capture.generation, host, ...(identity ? { checkIdentity: identity } : {}) });
  store.executionReady(event.runId); // The executor alone owns the completion wake.
 });
 pi.on("session_shutdown", () => { unsubscribeExecution(); stopArming(); });
 pi.on("agent_settled", (_event, ctx) => {
  if (!fenced) tracker.reset();
  const state = store.current();
  if (!state || state.fulfillment !== "pending" || state.continuation.state !== "active") return;
  if (stopped || ctx.signal?.aborted) { store.suspend("Agent abort or provider error; no automatic recovery."); return; }
  if (fenced || !state.input.aligned) return;
  if (pending.size) {
   const attempts = new Set([...pending.values()].flatMap(value => Object.keys(dispatches.get(value.call)?.capture.bases ?? {})));
   const waitingTasks = new Set(state.attempts.filter(attempt => attempts.has(attempt.id)).map(attempt => attempt.task));
   const independent = state.tasks.some(task => !waitingTasks.has(task.key) && !task.blocker && !accepted(state, `task:${task.key}`) && (task.dependsOn?.every(key => accepted(state, `task:${key}`)) ?? true));
   if (!independent) { store.waitForExecutions([...pending.keys()]); return; }
  }
  if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.isProjectTrusted() || !pi.getActiveTools().includes("csheng_workflow")) {
   store.suspend("Continuation capability unavailable in this host/mode/trust state."); return;
  }
  const lease = epoch;
  if (!barrier.schedule(idleCtx => {
   const invalid = () => fenced || stopped || epoch !== lease || !idleCtx.isIdle() || idleCtx.hasPendingMessages() || !idleCtx.isProjectTrusted() || !pi.getActiveTools().includes("csheng_workflow");
   if (invalid()) return;
   void store.settle(goalContext(idleCtx, idleCtx.signal, invalid), () => {
    pi.sendUserMessage(`Continue the enrolled implementation under existing authority. ${goalReceipt(store.view())} Advance ready work and report real evidence; record an actual blocker or operational suspension rather than claiming completion.`, { deliverAs: "followUp" });
   }).catch(() => { try { store.suspend("Continuation preparation or dispatch failed; reconcile explicitly."); } catch { /* No automatic retry or session repair. */ } });
  })) store.suspend("Public settlement waiter unavailable; explicit resume after capability repair.");
 });
}
