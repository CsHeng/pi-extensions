import { dirname, isAbsolute, relative, resolve, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { Check } from "typebox/value";
import { randomUUID } from "node:crypto";
import { WORKFLOW_ENTRY_TYPE } from "./contracts.ts";
import { createWorkflowStore, type SessionEntryLike } from "./store.ts";
import { fingerprintScope, type BasisFingerprint } from "./fingerprints.ts";
import type { HostObservation } from "./observation.ts";
import { GoalError, GOAL_LIMITS, goalParameters, requireGoal, type GoalOperation, type GoalState, type GoalView, type GoalFact } from "./goal-contracts.ts";
import { accepted, amend, complete, deficits, digest, invalidate, judge, progressKey, validateGoalState, validateGraph } from "./goal-state.ts";

export interface CheckObservation { host: HostObservation; bases: Record<string, BasisFingerprint>; generation: number; owner: number; checkIdentity?: string }
export interface GoalContext { cwd: string; now: string; signal?: AbortSignal; sessionId: string; fenced?: () => boolean }
export interface GoalResult { ok: boolean; code?: string; message?: string; diagnostics: string[]; view: GoalView }
function declaredScope(paths: string[] | undefined, cwd: string): string[] {
 const root = resolve(cwd);
 const result = (paths?.length ? paths : ["."]).map(path => {
  const rel = relative(root, resolve(root, path));
  requireGoal(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel), "invalid_scope", "Scope must be inside the current workspace.");
  return rel || ".";
 });
 return [...new Set(result)].sort();
}
export async function canonicalScope(paths: string[] | undefined, cwd: string): Promise<string[]> {
 const root = resolve(cwd);
 const result = declaredScope(paths, cwd);
 const physicalRoot = await realpath(root);
 const canonical: string[] = [];
 for (const entry of result) {
  let probe = resolve(root, entry); const tail: string[] = [];
  while (true) {
   try { probe = await realpath(probe); break; }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; tail.unshift(basename(probe)); const parent = dirname(probe); if (parent === probe) throw error; probe = parent; }
  }
  const rel = relative(physicalRoot, resolve(probe, ...tail));
  requireGoal(rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "invalid_scope", "Scope resolves outside the current workspace.");
  canonical.push(rel || ".");
 }
 return [...new Set(canonical)].sort();
}
/** Preserve declared alias identity as well as its current contained physical target. */
async function goalFingerprint(scope: string[], cwd: string): Promise<BasisFingerprint> {
 try {
  const physical = await canonicalScope(scope, cwd);
  const basis = await fingerprintScope(scope, cwd);
  return basis.state === "current" ? { ...basis, fingerprint: digest([basis.fingerprint, physical]) } : basis;
 } catch { return { scope, fingerprint: "unavailable", state: "unavailable", note: "Declared scope is unreadable or no longer physically contained." }; }
}
export const overlaps = (a: string[], b: string[]): boolean => a.some(x => b.some(y => x === "." || y === "." || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

export function createGoalStore(append: (type: string, data: unknown) => void) {
 let state: GoalState | undefined;
 let legacy: GoalView["legacy"];
 let unavailable: string | undefined;
 let owner = 0;
 const listeners = new Set<() => void>();
 const checks = new Map<string, CheckObservation>();
 const notify = () => { for (const listener of listeners) try { listener(); } catch { listeners.delete(listener); } };
 const view = (): GoalView => ({ ...(state ? { state: structuredClone(state) } : {}), ...(legacy ? { legacy: structuredClone(legacy) } : {}), ...(unavailable ? { unavailable } : {}), deficits: state ? deficits(state) : [] });
 function commit(next: GoalState, call: string): void {
  next.revision++;
  next.calls = [...next.calls, digest(call)].slice(-GOAL_LIMITS.calls);
  validateGoalState(next);
  append(WORKFLOW_ENTRY_TYPE, { schemaVersion: 2, state: next });
  state = next; legacy = undefined; owner++; notify();
 }
 const writable = () => requireGoal(!unavailable, "state_unavailable", `Workflow unavailable: ${unavailable}. Continue authorized work without claiming contract certification; do not repair history.`);
 async function refresh(next: GoalState, cwd: string): Promise<void> {
  const cache = new Map<string, BasisFingerprint>(); const lost = new Set<string>();
  for (const fact of next.facts) {
   if (!fact.usable) continue;
   const key = JSON.stringify(fact.basis.scope);
   let current = cache.get(key);
   if (!current) { current = await goalFingerprint(fact.basis.scope, cwd); cache.set(key, current); }
   if (current.state !== "current" || current.fingerprint !== fact.basis.fingerprint) {
    fact.usable = false; fact.note = current.state === "current" ? "Declared source changed; reverify affected evidence." : "Current basis unavailable.";
    for (const j of next.acceptance) if (j.facts.includes(fact.id)) lost.add(j.subject);
   }
  }
  invalidate(next, lost);
 }
 function align(next: GoalState, op: GoalOperation) {
  if (op.alignment) { next.input.aligned = true; }
  requireGoal(next.input.aligned, "alignment_required", "Reconcile delivered input against existing authority and supply alignment; this is not new permission.");
 }
 async function mutate(op: GoalOperation, ctx: GoalContext, call: string): Promise<GoalResult> {
  const diagnostics: string[] = [];
  try {
   requireGoal(Check(goalParameters, op), "invalid_request", "Malformed semantic operation.");
   if (op.operation === "inspect") return { ok: true, diagnostics, view: view() };
   writable();
   if (state?.calls.includes(digest(call))) return { ok: true, diagnostics: ["Already recorded."], view: view() };
   const lease = owner;
   let next: GoalState;
   if (op.operation === "enroll") {
    requireGoal(!state || state.fulfillment !== "pending", "already_enrolled", "An implementation contract is already enrolled; amend or close it explicitly.");
    requireGoal(op.goal && op.delivery && op.authority && op.requirements?.length, "invalid_contract", "Explicit implementation enrollment requires goal, delivery, existing authority and requirements.");
    if (legacy) {
     requireGoal(op.migrateLegacy === true, "migration_required", "Legacy workset is readable only. Explicitly re-enroll the same goal with remaining requirements; old acceptance is not fresh proof.");
     requireGoal(op.goal === legacy.workset.goal, "migration_required", "Migrate the existing goal before a semantic goal amendment.");
     for (const c of Object.values(legacy.criteria)) if (c.disposition !== "retired" && c.required) {
      requireGoal(op.requirements.some(r => r.outcome === c.outcome && r.verification === c.verification && r.required !== false), "migration_required", "Migration must preserve every legacy required criterion; acceptance is reverified.");
     }
    }
    next = { version: 2, revision: state?.revision ?? 0, id: randomUUID(), goal: op.goal, delivery: op.delivery, authority: op.authority,
     goalRevision: 1, fulfillment: "pending", continuation: { state: "active", repeat: 0, dispatched: 0 }, input: { generation: 0, aligned: true, unknown: false },
     requirements: op.requirements.map(r => ({ ...r, revision: 1 })), tasks: (op.tasks ?? op.requirements.map(r => ({ key: r.key, title: r.outcome.slice(0, 80), covers: [r.key] }))).map(t => ({ ...t, revision: 1 })), attempts: [], facts: [], acceptance: [], calls: [], serial: 0,
     ...(legacy ? { legacy: { id: legacy.workset.id, revision: legacy.revision, goal: legacy.workset.goal } } : {}) };
    validateGraph(next);
   } else {
    requireGoal(state, "no_contract", "Enroll an authorized implementation contract first. Ordinary work needs no workflow enrollment.");
    next = structuredClone(state);
    requireGoal(next.fulfillment === "pending" || op.operation === "resume", "closed_contract", "Contract is terminal; explicitly enroll new work.");
    if (op.operation !== "report" || op.alignment) align(next, op);
    if (op.operation === "start") {
     requireGoal(next.continuation.state === "active", "suspended", "Explicitly resume the contract under existing authority.");
     const task = next.tasks.find(t => t.key === op.task);
     requireGoal(task, "unknown_task", "Start needs a current task key.");
     requireGoal(!task.blocker, "blocked_task", "Resolve this task's recorded blocker with explicit resume before starting it.");
     requireGoal(!next.attempts.some(a => a.task === task.key && a.status === "running"), "running_attempt", "This task already has a running attempt.");
     await refresh(next, ctx.cwd);
     requireGoal(!accepted(next, `task:${task.key}`), "accepted_task", "Task is already accepted.");
     requireGoal(task.dependsOn?.every(dep => accepted(next, `task:${dep}`)) ?? true, "dependency_pending", "Task predecessors are not accepted.");
     requireGoal(next.attempts.length < GOAL_LIMITS.attempts, "state_limit", "Attempt limit reached; no attempt was started.");
     const scope = declaredScope(op.scope, ctx.cwd); const writes = op.writes?.length ? declaredScope(op.writes, ctx.cwd) : [];
     await canonicalScope(scope, ctx.cwd); if (writes.length) await canonicalScope(writes, ctx.cwd);
     const basis = await goalFingerprint(scope, ctx.cwd);
     if (basis.state !== "current") diagnostics.push(`Attempt basis unavailable: ${basis.note ?? "scope could not be captured"}. Host checks need their own valid capture; declared evidence cannot certify this basis.`);
     next.attempts.push({ id: `A${++next.serial}`, task: task.key, revision: task.revision, generation: next.input.generation, status: "running", started: ctx.now, basis, writes });
    } else if (op.operation === "report") {
     const candidates = next.attempts.filter(a => a.status === "running" && (!op.task || a.task === op.task));
     const attempt = op.attempt ? next.attempts.find(a => a.id === op.attempt) : candidates.length === 1 ? candidates[0] : undefined;
     requireGoal(attempt && attempt.status !== "interrupted", "unknown_attempt", "Report needs an unambiguous current attempt; corrections may name a reported attempt.");
     requireGoal(attempt.revision === next.tasks.find(t => t.key === attempt.task)?.revision, "stale_attempt", "Task meaning changed; start a current attempt.");
     requireGoal(op.summary, "invalid_report", "Report needs a truthful outcome summary.");
     attempt.status = "reported"; attempt.summary = op.summary;
     for (const input of op.facts ?? []) {
      const id = `${attempt.id}:${input.key}`;
      const observation = input.observationId ? checks.get(input.observationId) : input.kind === "host" ? [...checks.values()].reverse().find(check => check.bases[attempt.id] && check.host.sessionId === ctx.sessionId && check.generation === attempt.generation && check.host.at >= attempt.started) : undefined;
      if (input.kind === "host") requireGoal(observation && observation.host.toolName !== "csheng_workflow" && observation.host.sessionId === ctx.sessionId, "observation_required", "Host evidence requires an actual non-workflow observation in this session.");
      const basis = input.kind === "host" ? observation?.bases[attempt.id] : attempt.basis;
      const fact: GoalFact = { ...input, ...(input.kind === "host" && observation ? { observationId: observation.host.toolCallId, ...(observation.checkIdentity ? { checkIdentity: observation.checkIdentity } : {}) } : {}), id, attempt: attempt.id, at: ctx.now, generation: input.kind === "host" && observation ? observation.generation : next.input.generation, basis: basis ?? { scope: attempt.basis.scope, fingerprint: "unavailable", state: "unavailable" }, usable: !!basis && basis.state === "current" };
      if (input.kind === "host" && (observation!.generation !== attempt.generation || observation!.host.at < attempt.started)) { fact.usable = false; fact.note = "Observation belongs to another input or predates this attempt."; }
      if (input.kind === "host" && input.result === "pass" && (observation!.host.isError || (observation!.host.exitCode != null && observation!.host.exitCode !== 0) || (observation!.host.managed && observation!.host.managed.status !== "succeeded"))) { fact.usable = false; fact.note = "Host reported failure; cannot certify a passing check."; }
      const old = next.facts.find(f => f.id === id);
      // The same stable key corrects an earlier fact; remove only judgments depending on it.
      if (old && digest([old.kind, old.check, old.result, old.basis, old.observationId]) !== digest([fact.kind, fact.check, fact.result, fact.basis, fact.observationId])) invalidate(next, new Set(next.acceptance.filter(j => j.facts.includes(id)).map(j => j.subject)));
      next.facts = next.facts.filter(f => f.id !== id); next.facts.push(fact);
      if (!fact.usable || fact.result !== "pass") diagnostics.push(`${input.key}: ${fact.note ?? fact.result}`);
     }
     if (op.blocker) {
      next.tasks.find(t => t.key === attempt.task)!.blocker = op.blocker;
      invalidate(next, new Set([`task:${attempt.task}`]));
     }
     await refresh(next, ctx.cwd);
     for (const judgment of op.judgments ?? []) {
      const resolved = { ...judgment, facts: judgment.facts.map(id => next.facts.some(f => f.id === id) ? id : `${attempt.id}:${id}`) };
      const used = next.facts.filter(f => resolved.facts.includes(f.id));
      const sources = await Promise.all(used.filter(f => f.usable).map(f => canonicalScope(f.basis.scope, ctx.cwd)));
      const writers = await Promise.all(next.attempts.filter(a => a.status === "running" && a.writes.length).map(a => canonicalScope(a.writes, ctx.cwd)));
      const overlap = writers.some(writes => sources.some(scope => overlaps(writes, scope)));
      if (!next.input.aligned || overlap) { diagnostics.push(`${judgment.subject}: ${overlap ? "overlapping writer is running" : "input alignment required"}.`); continue; }
      judge(next, resolved, diagnostics);
     }
     if (next.tasks.some(t => t.blocker) && !next.attempts.some(a => a.status === "running") && !next.tasks.some(t => !t.blocker && !accepted(next, `task:${t.key}`) && (t.dependsOn?.every(dep => accepted(next, `task:${dep}`)) ?? true))) {
      next.continuation.state = "waiting"; next.continuation.reason = "Remaining ready work is blocked."; next.continuation.unblock = "Resolve the recorded task blockers and explicitly resume.";
     }
     if (op.complete) complete(next, diagnostics);
    } else if (op.operation === "amend") {
     amend(next, op);
    } else if (op.operation === "suspend") {
     requireGoal(op.reason && op.condition, "invalid_suspend", "Suspension needs an actual reason and explicit resume condition.");
     next.continuation.state = "suspended"; next.continuation.reason = op.reason; next.continuation.unblock = op.condition;
    } else if (op.operation === "resume") {
     requireGoal(op.reason && op.authority, "invalid_resume", "Resume requires the resolved condition and existing authority, not new permission by implication.");
     requireGoal(next.fulfillment !== "cancelled" && next.fulfillment !== "superseded", "closed_contract", "Cannot resume cancelled/superseded work.");
     const active = next.continuation.state === "active";
     const blocked = next.tasks.filter(t => t.blocker && (!op.task || t.key === op.task));
     requireGoal(!active || blocked.length > 0, "already_active", "Active work has no matching resolved blocker; resume cannot replenish continuation history.");
     await refresh(next, ctx.cwd);
     if (!active) next.continuation = { state: "active", repeat: 0, dispatched: next.continuation.dispatched };
     for (const task of blocked) delete task.blocker;
    } else if (op.operation === "close") {
     requireGoal(op.outcome && op.reason, "invalid_close", "Close needs outcome and reason.");
     if (op.outcome === "completed") { await refresh(next, ctx.cwd); complete(next, diagnostics); }
     else { next.fulfillment = op.outcome; for (const a of next.attempts) if (a.status === "running") a.status = "interrupted"; }
    }
   }
   requireGoal(owner === lease && !ctx.signal?.aborted && !ctx.fenced?.(), "preparation_changed", "Owner, input or cancellation changed during preparation; nothing committed.");
   commit(next, call);
   return { ok: true, diagnostics: [...new Set(diagnostics)], view: view() };
  } catch (error) {
   return { ok: false, code: error instanceof GoalError ? error.code : "state_unavailable", message: error instanceof Error ? error.message : String(error), diagnostics, view: view() };
  }
 }
 return {
  view, mutate, owner: () => owner,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  current: () => state ? structuredClone(state) : undefined,
  replay(entries: readonly SessionEntryLike[]) {
   owner++; state = undefined; legacy = undefined; unavailable = undefined; checks.clear();
   const last = entries.findLast(e => e.type === "custom" && e.customType === WORKFLOW_ENTRY_TYPE);
   if (last) try {
    const snapshot = last.data as { schemaVersion?: number; state?: GoalState };
    if (snapshot?.schemaVersion === 1) {
     const reader = createWorkflowStore({ append() { throw new Error("Read-only legacy reader"); } }); reader.replay([last]);
     requireGoal(!reader.recovery() && reader.current(), "state_unavailable", reader.recovery() ?? "Invalid legacy snapshot."); legacy = structuredClone(reader.current()!);
    } else {
     requireGoal(snapshot?.schemaVersion === 2 && snapshot.state, "state_unavailable", "Unsupported latest workflow snapshot; no fallback.");
     validateGoalState(snapshot.state); state = structuredClone(snapshot.state);
    }
   } catch (error) { unavailable = error instanceof Error ? error.message : String(error); }
   notify();
  },
  /** Restart/tree replacement is not permission to resume. Persist interruptions before accepting more work. */
  recover(reason: string) {
   if (!state || state.fulfillment !== "pending") return;
   const next = structuredClone(state); for (const a of next.attempts) if (a.status === "running") a.status = "interrupted";
   delete next.continuation.waitingFor; delete next.executionPending;
   next.input.aligned = false; next.continuation.state = "suspended"; next.continuation.reason = reason; next.continuation.unblock = "Reconcile branch/input and explicitly resume under existing authority.";
   try { commit(next, `recover:${owner}`); } catch (error) { unavailable = String(error); notify(); }
  },
  delivered(unknown: boolean) {
   if (!state || state.fulfillment !== "pending") return;
   const next = structuredClone(state); next.input.generation++; next.input.aligned = false; next.input.unknown = unknown;
   commit(next, `input:${next.input.generation}:${owner}`);
  },
  async capture(cwd: string): Promise<{ bases: Record<string, BasisFingerprint>; owner: number; generation: number }> {
   const lease = owner; const current = state; const bases: Record<string, BasisFingerprint> = {};
   for (const a of current?.attempts ?? []) if (a.status === "running") bases[a.id] = await goalFingerprint(a.basis.scope, cwd);
   return { bases: lease === owner ? bases : {}, owner: lease, generation: current?.input.generation ?? -1 };
  },
  observe(observation: CheckObservation) { checks.set(observation.host.toolCallId, observation); while (checks.size > 256) checks.delete(checks.keys().next().value!); },
  pendingExecutions(runIds: string[]) {
   if (!state || state.fulfillment !== "pending") return;
   const values = [...new Set(runIds)].slice(0, 256);
   if (digest(values) === digest(state.executionPending ?? [])) return;
   const next = structuredClone(state); next.executionPending = values;
   commit(next, `execution-pending:${owner}`);
  },
  waitForExecutions(runIds: string[]) {
   if (!state || state.fulfillment !== "pending" || state.continuation.state !== "active" || !runIds.length) return;
   const next = structuredClone(state);
   next.continuation.state = "waiting"; next.continuation.waitingFor = [...new Set(runIds)].slice(0, 256);
   next.continuation.reason = "Awaiting accepted subagent execution; receipts are not completion.";
   next.continuation.unblock = "A current-owner terminal event makes evidence available; the executor owns the wake.";
   commit(next, `execution-wait:${owner}`);
  },
  executionReady(runId: string) {
   if (!state || state.continuation.state !== "waiting" || !state.continuation.waitingFor?.includes(runId)) return;
   const next = structuredClone(state);
   next.continuation.state = "active"; delete next.continuation.waitingFor;
   delete next.continuation.reason; delete next.continuation.unblock;
   commit(next, `execution-ready:${owner}:${runId}`);
  },
  async settle(ctx: GoalContext, dispatch: () => void): Promise<void> {
   if (!state || state.fulfillment !== "pending" || state.continuation.state !== "active" || !state.input.aligned || unavailable || ctx.signal?.aborted || ctx.fenced?.()) return;
   const lease = owner; const next = structuredClone(state); await refresh(next, ctx.cwd);
   if (lease !== owner || ctx.signal?.aborted || ctx.fenced?.()) return;
   const key = progressKey(next);
   next.continuation.repeat = key === next.continuation.lastProgress ? next.continuation.repeat + 1 : 0;
   next.continuation.lastProgress = key;
   if (next.continuation.repeat >= GOAL_LIMITS.noProgress) {
    next.continuation.state = "suspended"; next.continuation.reason = "Repeated unchanged deficits without material progress."; next.continuation.unblock = "Diagnose the repeated condition, then explicitly resume under existing authority.";
   } else next.continuation.dispatched++;
   commit(next, `settled:${owner}`);
   if (next.continuation.state === "active") dispatch();
  },
  suspend(reason: string) {
   if (!state || state.fulfillment !== "pending" || state.continuation.state !== "active") return;
   const next = structuredClone(state); next.continuation.state = "suspended"; next.continuation.reason = reason; next.continuation.unblock = "Restore the named capability/condition and explicitly resume.";
   commit(next, `suspend:${owner}`);
  },
 };
}
export type GoalStore = ReturnType<typeof createGoalStore>;
