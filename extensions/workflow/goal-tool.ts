import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { goalParameters, type GoalOperation, type GoalView } from "./goal-contracts.ts";
import { type GoalContext, type GoalStore } from "./goal-store.ts";
import { taskFrontier } from "./goal-state.ts";

function boundedItems(items: string[], limit = 6): string {
 return `${items.slice(0, limit).join(", ")}${items.length > limit ? `, … (+${items.length - limit}; inspect for remaining tasks)` : ""}`;
}

export function goalReceipt(view: GoalView, showFrontier = true): string {
 if (view.unavailable) return `Workflow unavailable: ${view.unavailable.slice(0, 500)}. Continue the authorized task without certifying workflow completion; do not repair session history.`;
 const s = view.state;
 if (!s && view.legacy) {
  const old = view.legacy;
  return `Historical v2 contract ${old.id} (revision ${old.revision}); no active acceptance or automatic continuation. Explicit replacement enrollment requires alignment reconciling these obligations and unresolved executions.\n${JSON.stringify({ goal: old.goal, delivery: old.delivery, requirements: old.requirements, tasks: old.tasks, executionPending: old.executionPending ?? [], runningAttempts: old.attempts.filter(a => a.status === "running").map(a => a.id), waitingFor: old.continuation.waitingFor ?? [] })}`;
 }
 if (!s) return "No implementation contract enrolled. Ordinary work needs no enrollment.";
 const active = s.attempts.filter(a => a.status === "running").map(a => `${a.task}=${a.id}`);
 const frontier = taskFrontier(s);
 const taskLines = s.fulfillment === "pending" && showFrontier ? [
  "Task-local frontier (alignment and continuation still apply; not permission to resume):",
  `Ready: ${boundedItems(frontier.ready) || "none"}`,
  ...(frontier.blocked.length ? [`Blocked: ${boundedItems(frontier.blocked.map(t => `${t.task} [${t.kind}] — ${t.reason.replace(/\s+/g, " ").slice(0, 160)}`))}`] : []),
  ...(frontier.waiting.length ? [`Waiting on dependencies: ${boundedItems(frontier.waiting.map(t => `${t.task} <- ${boundedItems(t.dependencies, 4)}`))}`] : []),
 ] : [];
 return [`Contract ${s.fulfillment}; continuation ${s.continuation.state}; input ${s.input.aligned ? "aligned" : "needs alignment"}.`,
  ...(s.fulfillment === "pending" && s.continuation.state === "active" && s.continuation.automaticPaused ? ["Automatic dispatch paused; authorized tool work remains available. This is not a user pause, a new approval gate or completion."] : []),
  ...(active.length ? [`Running: ${boundedItems(active)}`] : []),
  ...(s.continuation.reason ? [`Reason: ${s.continuation.reason.slice(0, 300)}`] : []),
  ...(view.deficits.length ? [`Remaining: ${view.deficits.slice(0, 12).join(", ")}${view.deficits.length > 12 ? ", …" : ""}`] : []),
  ...taskLines,
  ...(!showFrontier && s.fulfillment === "pending" ? ["Task frontier withheld after rejected operation; inspect the recorded obligations before choosing the next task."] : []),
 ].join("\n");
}
export const goalContext = (ctx: ExtensionContext, signal?: AbortSignal, fenced?: () => boolean): GoalContext => ({ cwd: ctx.cwd, now: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(), ...(signal ? { signal } : {}), ...(fenced ? { fenced } : {}) });
export function registerGoalTool(pi: ExtensionAPI, store: GoalStore, fenced: () => boolean): void {
 pi.registerTool({
  name: "csheng_workflow", label: "Implementation contract",
  description: "High-frequency rules: report names the attempt id start returned, or omits attempt only while exactly one matching attempt runs (optionally selected by task); host-fact checks count only while that attempt runs; a pre-start check cannot be relabeled as a current host observation, and still-valid evidence may be reused with honest non-host provenance without a bookkeeping rerun; judgments reference only current fact ids. Preparation conflicts replay automatically; a withheld rejection commits nothing. Manage one explicitly enrolled implementation completion contract. Enroll implementation work under existing authority; ordinary analysis, review, questions and todo display do not require enrollment. Code owns revisions and current state. Project required outcomes rather than every plan row or model-inferred obligation. Preserve independently deliverable plan task IDs for real obligations: one task per independently verifiable outcome/blocker boundary, not an umbrella for multiple owners or one item per command. dependsOn names only required upstream outputs, never display grouping or mere phase order; overall completion remains a requirement/delivery judgment. Operations: enroll(goal, delivery, authority, requirements and tasks); start(task, scope, writes); report(summary, facts, judgments, optional complete/task blocker); amend(reason, authority and changed contract; tasks replaces the full task list); inspect(optional subject); close(outcome, reason); suspend(reason, condition); resume(reason, authority, optional task and reconciledExecutions). Replayed unresolved executions remain completion deficits until explicit resume with alignment records their actual terminal state or owner disposition; reconciliation never cancels live work or imports its acceptance. scope and writes are filesystem path arrays, never task descriptions: scope declares source inputs relevant to evidence without certifying their content, writes names planned mutation paths; use cwd-relative paths or authorized absolute roots, and put prose in goal, task title or report.summary. Start each slice before work; report its real outcome at a slice/check boundary, before switching finished work, blocking/handoff or the final reply. Correct an over-specified model-derived obligation with amend under existing authority; preserve actual required results and their relation to the user's intent. Do not drop an explicit user outcome or resume after cancellation. A split or regrouped subject needs a fresh acceptance judgment and does not inherit aggregate acceptance. Unchanged applicable facts may support that judgment without a bookkeeping rerun or invented host provenance; missing or invalidated evidence, including an actual source or oracle change, needs affected verification. An obsolete attempt cannot publish new results merely because its earlier facts remain valid. Report partial or failed work without accepting it; accept locally verified tasks when their actual requirements are met, not merely at final close. Report ends that attempt's writer; further changes require a new attempt. Independent concurrent attempts remain allowed, with explicit report task/attempt identity. Facts use stable keys; corrections replace a key. Host facts reference an actual observationId or, if omitted, the latest completed captured tool result for this attempt; use explicit references when judging multiple checks. Agent/user/review declarations stay labeled. Judgment subjects are task:<key>, requirement:<key>, or delivery; explicitly judge all required subjects. Report actual failures normally; diagnostics/remaining work are not tool errors or completion. New input requires alignment describing reconciliation under existing authority. The main agent judges evidence relevance and affected re-verification; tools do not hash source trees or revoke acceptance on disk drift. Historical v2 snapshots require explicit replacement enrollment with alignment; old acceptance is not imported. Use the task-local Ready/Blocked/dependency frontier to continue independent authorized work; record a local blocker on its task, not as global suspension. Unfinished implementation/classification/review and the end of a slice are remaining work, not suspension reasons. Reserve suspension for a real user pause or operational inability to continue; never infer permission to resume from Ready. An automatic dispatch pause only stops repeated follow-ups: continue authorized work through normal tools without a resume ritual. Useful exploration and failed diagnostics can add evidence without reducing the task count. Resume does not reset anti-spin history; neither changed wording nor repeated operations earn automatic messages. Waiting/suspension preserves unfinished obligations; never claim completion from it. No Skill-specific runtime, ordinary todo ledger, or provider change.",
  parameters: goalParameters,
  async execute(id, params, signal, _update, ctx) {
   try { validateToolArguments({ name: "csheng_workflow", parameters: goalParameters } as never, { id, name: "csheng_workflow", arguments: params, type: "toolCall" }); }
   catch { return { content: [{ type: "text", text: "invalid_request: malformed semantic workflow operation; nothing committed." }], details: { ok: false, code: "invalid_request" }, isError: true }; }
   const result = await store.mutate(params as GoalOperation, goalContext(ctx, signal, fenced), id);
   const state = result.view.state;
   const started = result.ok && params.operation === "start" && state && !result.diagnostics.includes("Already recorded.") ? [...state.attempts].reverse().find(a => a.status === "running" && a.task === params.task) : undefined;
   const selected = state && params.subject ? state.requirements.find(r => `requirement:${r.key}` === params.subject)
    ?? state.tasks.find(t => `task:${t.key}` === params.subject) ?? state.attempts.find(a => a.id === params.subject)
    ?? state.facts.find(f => f.id === params.subject) ?? { missing: params.subject } : undefined;
   const inspection = params.operation === "inspect" ? JSON.stringify(selected ?? (state ? {
    goal: state.goal, delivery: state.delivery, authority: state.authority, requirements: state.requirements, tasks: state.tasks,
    attempts: state.attempts.slice(-8), facts: state.facts.slice(-16), acceptance: state.acceptance,
   } : {})) : "";
   const refs = state && ["start", "report", "inspect"].includes(params.operation) ? JSON.stringify({
    contractId: state.id, revision: state.revision, inputGeneration: state.input.generation,
    attempts: state.attempts.slice(-8).map(a => ({ id: a.id, task: a.task, status: a.status })),
    facts: state.facts.filter(f => f.usable).slice(-16).map(f => ({ id: f.id, observationId: f.observationId ?? null, result: f.result })),
    observations: store.availableObservations(ctx.sessionManager.getSessionId()),
   }) : "";
   const text = [result.message, ...(started ? [`Attempt ${started.id} is running for task ${started.task}: report with attempt "${started.id}"; host-fact checks count only while it runs. A check that predates this start cannot be relabeled as a current host observation; reuse still-valid evidence with honest non-host provenance instead of rerunning it only for bookkeeping.`] : []), goalReceipt(result.view, result.ok), refs, ...result.diagnostics.slice(0, 16), inspection].filter(Boolean).join("\n");
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
