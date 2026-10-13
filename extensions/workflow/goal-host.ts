/** Pi owns the loop. Tracking only records tasks and offers bounded settlement reminders. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettlementBarrier } from "../shared/settlement.ts";
import { SUBAGENT_EXECUTION_EVENT, type SubagentExecutionEvent } from "../shared/subagent-execution.ts";
import { isUserInputSource } from "./host-adapter.ts";
import { createGoalStore } from "./goal-store.ts";
import { goalReceipt, registerGoalTool } from "./goal-tool.ts";
import { registerGoalUi } from "./goal-ui.ts";
export default function goalWorkflow(pi: ExtensionAPI): void {
 const store = createGoalStore((type, data) => pi.appendEntry(type, data));
 const ui = registerGoalUi(pi, store);
 let epoch = 0, stopped = false;
 let sessionId: string | undefined;
 const dispatches = new Set<string>(), pending = new Set<string>(), terminal = new Set<string>();
 const barrier = registerSettlementBarrier(pi, { command: "csheng-workflow-wait", tool: "csheng_workflow", enabled: () => store.canRemind() });
 const unsubscribe = store.subscribe(() => { barrier.arm(); });
 registerGoalTool(pi, store, () => stopped);
 const reset = () => { epoch++; stopped = false; dispatches.clear(); pending.clear(); terminal.clear(); };
 const restore = (ctx: Parameters<typeof ui.attach>[0]) => {
  ui.detach(); reset(); sessionId = ctx.sessionManager.getSessionId();
  store.replay(ctx.sessionManager.getBranch());
  store.recover("Recovered task list; reconcile the current work and use resume when continuing.");
  ui.attach(ctx);
 };
 pi.on("session_start", (_event, ctx) => restore(ctx));
 pi.on("session_tree", (_event, ctx) => restore(ctx));
 pi.on("input", event => { if (isUserInputSource(event.source)) { epoch++; store.receivedInput(); } });
 pi.on("before_agent_start", () => { stopped = false; });
 pi.on("context", event => {
  const type = "csheng-workflow-tasks";
  const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === type));
  const view = store.view();
  if (view.state || view.unavailable) messages.push({ role: "custom", customType: type,
   content: "Current task tracking (read-only context, not new requirements or authority). " + goalReceipt(view, 12), display: false, timestamp: Date.now() });
  return { messages };
 });
 pi.on("message_end", event => { if (event.message.role === "assistant" && ["aborted", "error"].includes(event.message.stopReason)) stopped = true; });
 pi.on("tool_execution_start", event => {
  if (event.toolName === "csheng_subagent_sessions" && ["create", "continue"].includes((event.args as { action?: string })?.action ?? "")) dispatches.add(event.toolCallId);
 });
 pi.on("tool_execution_end", event => {
  if (event.toolName === "csheng_workflow") return;
  store.observe(event.toolName, event.isError);
  if (event.toolName !== "csheng_subagent_sessions" || !dispatches.has(event.toolCallId)) return;
  const result = event.result?.details as { schemaVersion?: number; kind?: string; runId?: string; status?: string; requestTelemetry?: { version: number; ownerSessionId: string; admittedTasks: number | null } } | undefined;
  // Replay returns the original accepted receipt but fresh invocation telemetry has no admission.
  // Only an admission in this process can promise a future terminal event; historical state cannot.
  const admission = result?.requestTelemetry;
  if (result?.schemaVersion === 4 && result.kind === "submission" && result.status === "accepted" && result.runId && !terminal.has(result.runId)
   && admission?.version === 1 && admission.ownerSessionId === sessionId && admission.admittedTasks != null && admission.admittedTasks > 0) pending.add(result.runId);
 });
 const unsubscribeExecution = pi.events.on(SUBAGENT_EXECUTION_EVENT, raw => {
  const event = raw as SubagentExecutionEvent;
  if (event?.version !== 4 || event.kind !== "run-terminal" || !dispatches.has(event.toolCallId) || event.owner?.sessionId !== sessionId) return;
  pending.delete(event.runId); terminal.add(event.runId); dispatches.delete(event.toolCallId);
  // The executor owns the completion wake. Its result never marks a tracked task done.
 });
 pi.on("agent_settled", (_event, ctx) => {
  if (stopped || ctx.signal?.aborted || barrier.aborted) { store.pause("Host interruption; resume only when continuing the work."); return; }
  if (!store.canRemind() || pending.size || !["tui", "rpc"].includes(ctx.mode) || !ctx.isProjectTrusted() || !pi.getActiveTools().includes("csheng_workflow")) return;
  const lease = epoch;
  barrier.schedule(idleCtx => {
   if (stopped || lease !== epoch || pending.size || !idleCtx.isIdle() || idleCtx.hasPendingMessages() || !idleCtx.isProjectTrusted() || !pi.getActiveTools().includes("csheng_workflow")) return;
   try {
    store.remind(() => pi.sendUserMessage("Return attention to the tracked work under the user's current instructions. Revise unnecessary inferred steps, continue useful work, or record the actual blocker or pause. Tracking adds no verification or review obligations.\n" + goalReceipt(store.view()), { deliverAs: "followUp" }));
   } catch { store.recover("Task reminder could not be recorded or delivered; inspect before resuming."); }
  });
 });
 pi.on("session_shutdown", () => { reset(); ui.detach(); unsubscribe(); unsubscribeExecution(); });
}
