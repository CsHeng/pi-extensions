/** Public host adapter: no private loop calls, timers, provider or child dispatch. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPreparedInputTracker } from "../shared/prepared-input.ts";
import { summarizeHostObservation, MANAGED_SESSION_TOOL_NAME, type ManagedResultObservation } from "./observation.ts";
import { registerSettlementBarrier } from "./settlement.ts";
import { createGoalStore } from "./goal-store.ts";
import { digest } from "./goal-state.ts";
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
 const barrier = registerSettlementBarrier(pi);
 let fenced = false; let epoch = 0; let stopped = false; let projected: number | undefined;
 const captures = new Map<string, Awaited<ReturnType<typeof store.capture>> & { input: string | undefined }>();
 registerGoalTool(pi, store, () => fenced);
 const reset = () => { epoch++; captures.clear(); tracker.reset(); fenced = false; projected = undefined; };
 pi.on("session_start", (_event, ctx) => { ui.detach(); reset(); store.replay(ctx.sessionManager.getBranch()); store.recover("Session recovery requires explicit reconciliation/resume."); ui.attach(ctx); });
 pi.on("session_tree", (_event, ctx) => { ui.detach(); reset(); store.replay(ctx.sessionManager.getBranch()); store.recover("Branch replacement requires explicit reconciliation/resume."); ui.attach(ctx); });
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
  if (lease === epoch) captures.set(event.toolCallId, { ...capture, input: hostCheckIdentity(event.toolName, event.args, null) });
  while (captures.size > 256) captures.delete(captures.keys().next().value!);
 });
 pi.on("tool_execution_end", (event, ctx) => {
  const capture = captures.get(event.toolCallId); captures.delete(event.toolCallId);
  if (!capture) return;
  const host = summarizeHostObservation({ ...event, at: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId() });
  const identity = hostCheckIdentity(event.toolName, host.managed ? { action: host.managed.action } : capture.input, host.managed ?? { isError: host.isError, exitCode: host.exitCode });
  store.observe({ bases: capture.bases, owner: capture.owner, generation: capture.generation, host, ...(identity ? { checkIdentity: identity } : {}) });
 });
 pi.on("agent_settled", (_event, ctx) => {
  if (!fenced) tracker.reset();
  const state = store.current();
  if (!state || state.fulfillment !== "pending" || state.continuation.state !== "active") return;
  if (stopped || ctx.signal?.aborted) { store.suspend("Agent abort or provider error; no automatic recovery."); return; }
  if (fenced || !state.input.aligned) return;
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
