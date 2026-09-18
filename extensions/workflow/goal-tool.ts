import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { goalParameters, type GoalOperation, type GoalView } from "./goal-contracts.ts";
import { type GoalContext, type GoalStore } from "./goal-store.ts";

export function goalReceipt(view: GoalView): string {
 if (view.unavailable) return `Workflow unavailable: ${view.unavailable.slice(0, 500)}. Continue the authorized task without certifying workflow completion; do not repair session history.`;
 if (view.legacy) return `Legacy v1 workset: ${view.legacy.workset.goal.slice(0, 300)}. Readable only; explicitly enroll with migrateLegacy and preserve remaining requirements. Old acceptance is not fresh proof.`;
 const s = view.state;
 if (!s) return "No implementation contract enrolled. Ordinary work needs no enrollment.";
 const active = s.attempts.filter(a => a.status === "running").map(a => `${a.task}=${a.id}`).join(", ");
 return [`Contract ${s.fulfillment}; continuation ${s.continuation.state}; input ${s.input.aligned ? "aligned" : "needs alignment"}.`,
  ...(active ? [`Running: ${active}`] : []),
  ...(s.continuation.reason ? [`Reason: ${s.continuation.reason.slice(0, 300)}`] : []),
  ...(view.deficits.length ? [`Remaining: ${view.deficits.slice(0, 12).join(", ")}${view.deficits.length > 12 ? ", …" : ""}`] : []),
 ].join("\n");
}
export const goalContext = (ctx: ExtensionContext, signal?: AbortSignal, fenced?: () => boolean): GoalContext => ({ cwd: ctx.cwd, now: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(), ...(signal ? { signal } : {}), ...(fenced ? { fenced } : {}) });
export function registerGoalTool(pi: ExtensionAPI, store: GoalStore, fenced: () => boolean): void {
 pi.registerTool({
  name: "csheng_workflow", label: "Implementation contract",
  description: "Manage one explicitly enrolled implementation completion contract. Enroll implementation work under existing authority; ordinary analysis, review, questions and todo display do not require enrollment. Code owns revisions and current state. Operations: enroll(goal, delivery, authority, requirements and tasks); start(task, scope, writes); report(summary, facts, judgments, optional complete/task blocker); amend(reason, authority and changed contract); inspect(optional subject); close(outcome, reason); suspend(reason, condition); resume(reason, authority, optional task). A normal slice uses start before work and one compound report after. Facts use stable keys; corrections replace a key. Host facts reference an actual observationId or, if omitted, the latest completed captured tool result for this attempt; use explicit references when judging multiple checks. Agent/user/review declarations stay labeled. Judgment subjects are task:<key>, requirement:<key>, or delivery; explicitly judge all required subjects. Report actual failures normally; diagnostics/remaining work are not tool errors or completion. New input requires alignment describing reconciliation under existing authority. Hash drift alone needs affected re-verification, not permission. Waiting/suspension preserves unfinished obligations; never claim completion from it. No Skill-specific runtime, ordinary todo ledger, or provider change.",
  parameters: goalParameters,
  async execute(id, params, signal, _update, ctx) {
   try { validateToolArguments({ name: "csheng_workflow", parameters: goalParameters } as never, { id, name: "csheng_workflow", arguments: params, type: "toolCall" }); }
   catch { return { content: [{ type: "text", text: "invalid_request: malformed semantic workflow operation; nothing committed." }], details: { ok: false, code: "invalid_request" }, isError: true }; }
   const result = await store.mutate(params as GoalOperation, goalContext(ctx, signal, fenced), id);
   const state = result.view.state;
   const selected = state && params.subject ? state.requirements.find(r => `requirement:${r.key}` === params.subject)
    ?? state.tasks.find(t => `task:${t.key}` === params.subject) ?? state.attempts.find(a => a.id === params.subject)
    ?? state.facts.find(f => f.id === params.subject) ?? { missing: params.subject } : undefined;
   const inspection = params.operation === "inspect" ? JSON.stringify(selected ?? (state ? {
    goal: state.goal, delivery: state.delivery, authority: state.authority, requirements: state.requirements, tasks: state.tasks,
    attempts: state.attempts.slice(-8), facts: state.facts.slice(-16), acceptance: state.acceptance,
   } : result.view.legacy ? { goal: result.view.legacy.workset.goal, criteria: result.view.legacy.criteria, tasks: result.view.legacy.tasks } : {})) : "";
   const text = [result.message, goalReceipt(result.view), ...result.diagnostics.slice(0, 16), inspection].filter(Boolean).join("\n");
   return { content: [{ type: "text", text: text.length > 30000 ? `${text.slice(0, 30000)}\n[Inspection bounded; inspect with subject requirement:<key>, task:<key>, attempt ID or fact ID for the omitted record.]` : text }], details: {
    ok: result.ok, ...(result.code ? { code: result.code } : {}), diagnostics: result.diagnostics,
    ...(params.operation === "inspect" ? { workflow: result.view } : { fulfillment: result.view.state?.fulfillment, continuation: result.view.state?.continuation.state }),
   }, ...(!result.ok ? { isError: true } : {}) };
  },
 });
 pi.on("tool_result", event => {
  if (event.toolName === "csheng_workflow" && (event.details as { ok?: boolean } | undefined)?.ok === false) return { isError: true };
  return;
 });
}
