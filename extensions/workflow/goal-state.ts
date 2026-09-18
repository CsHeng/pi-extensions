/** Pure semantic transitions. Facts never imply the main agent's acceptance judgment. */
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import { GoalError, GOAL_LIMITS, goalStateSchema, requireGoal, type GoalAcceptance, type GoalOperation, type GoalState } from "./goal-contracts.ts";

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function subjectRevision(state: GoalState, subject: string): number | undefined {
 if (subject === "delivery") return state.goalRevision;
 return state.requirements.find(r => `requirement:${r.key}` === subject)?.revision ?? state.tasks.find(t => `task:${t.key}` === subject)?.revision;
}
export function accepted(state: GoalState, subject: string): boolean {
 const judgment = state.acceptance.find(j => j.subject === subject);
 if (!judgment?.accepted || judgment.revision !== subjectRevision(state, subject) || !judgment.facts.length) return false;
 return judgment.facts.every(id => state.facts.some(f => f.id === id && f.usable && f.result === "pass"));
}
export function deficits(state: GoalState): string[] {
 const result: string[] = [];
 if (!state.input.aligned) result.push("Align the delivered input against current authority.");
 for (const r of state.requirements) if (r.required !== false && !accepted(state, `requirement:${r.key}`)) result.push(`requirement:${r.key}`);
 for (const t of state.tasks) {
  if (!accepted(state, `task:${t.key}`)) result.push(`task:${t.key}`);
  if (t.blocker) result.push(`blocked:${t.key}:${t.blocker.kind}`);
 }
 for (const a of state.attempts) if (a.status === "running") result.push(`running:${a.id}`);
 if (!accepted(state, "delivery")) result.push("delivery");
 return result;
}
/** Excludes wording, receipts, counters, attempts and repeated facts: these cannot buy another automatic turn. */
export function progressKey(state: GoalState): string {
 return digest({ goal: state.goalRevision, input: state.input.generation,
  accepted: state.acceptance.filter(j => accepted(state, j.subject)).map(j => j.subject).sort(),
  facts: [...new Set(state.facts.filter(f => f.usable).map(f => digest([f.kind, f.result, f.basis.scope, f.basis.fingerprint, f.kind === "host" ? f.checkIdentity : undefined])))].sort(),
  blockers: state.tasks.filter(t => t.blocker).map(t => [t.key, t.blocker!.kind]) });
}
export function validateGraph(state: Pick<GoalState, "requirements" | "tasks">): void {
 requireGoal(new Set(state.requirements.map(r => r.key)).size === state.requirements.length, "invalid_contract", "Duplicate requirement key.");
 requireGoal(new Set(state.tasks.map(t => t.key)).size === state.tasks.length, "invalid_contract", "Duplicate task key.");
 const requirements = new Set(state.requirements.map(r => r.key));
 const tasks = new Map(state.tasks.map(t => [t.key, t]));
 const visiting = new Set<string>(); const visited = new Set<string>();
 const visit = (key: string) => {
  requireGoal(!visiting.has(key), "invalid_contract", "Task dependencies contain a cycle.");
  if (visited.has(key)) return;
  const task = tasks.get(key); requireGoal(task, "invalid_contract", `Unknown dependency ${key}.`);
  visiting.add(key);
  for (const covered of task.covers) requireGoal(requirements.has(covered), "invalid_contract", `Unknown requirement ${covered}.`);
  for (const dep of task.dependsOn ?? []) visit(dep);
  visiting.delete(key); visited.add(key);
 };
 for (const task of state.tasks) visit(task.key);
}
export function invalidate(state: GoalState, subjects: Set<string>, obsoleteExecution = false): void {
 let changed = true;
 while (changed) {
  changed = false;
  for (const task of state.tasks) {
   const subject = `task:${task.key}`;
   if (subjects.has(subject)) continue;
   if (task.covers.some(key => subjects.has(`requirement:${key}`)) || task.dependsOn?.some(key => subjects.has(`task:${key}`))) {
    subjects.add(subject); changed = true;
   }
  }
 }
 if (subjects.size) subjects.add("delivery");
 state.acceptance = state.acceptance.filter(j => !subjects.has(j.subject));
 for (const attempt of state.attempts) if (subjects.has(`task:${attempt.task}`) && (obsoleteExecution || attempt.status === "running")) attempt.status = "interrupted";
 for (const fact of state.facts) if (state.attempts.some(a => a.id === fact.attempt && a.status === "interrupted")) { fact.usable = false; fact.note = "Attempt invalidated."; }
 if (subjects.size && state.fulfillment === "complete") state.fulfillment = "pending";
}
export function amend(state: GoalState, op: GoalOperation): void {
 requireGoal(op.reason && op.authority, "invalid_contract", "Amendment needs reason and authority, not merely a new file hash.");
 const affected = new Set<string>();
 if ((op.goal && op.goal !== state.goal) || (op.delivery && op.delivery !== state.delivery)) {
  state.goal = op.goal ?? state.goal; state.delivery = op.delivery ?? state.delivery; state.goalRevision++;
  for (const j of state.acceptance) affected.add(j.subject);
  for (const t of state.tasks) affected.add(`task:${t.key}`);
 }
 if (op.requirements) {
  for (const old of state.requirements) if (!op.requirements.some(r => r.key === old.key)) affected.add(`requirement:${old.key}`);
  state.requirements = op.requirements.map(r => {
   const old = state.requirements.find(o => o.key === r.key);
   const same = old && old.outcome === r.outcome && old.verification === r.verification && (old.required !== false) === (r.required !== false);
   if (!same) affected.add(`requirement:${r.key}`);
   return { ...r, revision: same ? old.revision : (old?.revision ?? 0) + 1 };
  });
 }
 if (op.tasks) {
  for (const old of state.tasks) if (!op.tasks.some(t => t.key === old.key)) affected.add(`task:${old.key}`);
  state.tasks = op.tasks.map(t => {
   const old = state.tasks.find(o => o.key === t.key);
   const same = old && digest([old.covers, old.dependsOn ?? []]) === digest([t.covers, t.dependsOn ?? []]);
   if (!same) affected.add(`task:${t.key}`);
   return { ...t, revision: same ? old.revision : (old?.revision ?? 0) + 1, ...(old?.blocker ? { blocker: old.blocker } : {}) };
  });
 }
 state.authority = op.authority;
 validateGraph(state); invalidate(state, affected, true);
}
export function judge(state: GoalState, input: Omit<GoalAcceptance, "revision">, diagnostics: string[]): void {
 const revision = subjectRevision(state, input.subject);
 requireGoal(revision !== undefined, "unknown_subject", `Unknown subject ${input.subject}.`);
 requireGoal(input.facts.every(id => state.facts.some(f => f.id === id)), "unknown_fact", "Judgment references an unknown fact.");
 state.acceptance = state.acceptance.filter(j => j.subject !== input.subject);
 if (!input.accepted) { invalidate(state, new Set([input.subject])); return; }
 const usable = input.facts.length > 0 && input.facts.every(id => state.facts.some(f => f.id === id && f.usable && f.result === "pass"));
 if (!usable) { diagnostics.push(`${input.subject}: passing current evidence is missing.`); return; }
 const task = state.tasks.find(t => input.subject === `task:${t.key}`);
 if (task?.blocker) { diagnostics.push(`${input.subject}: resolve the recorded blocker explicitly.`); return; }
 if (task?.dependsOn?.some(dep => !accepted(state, `task:${dep}`))) { diagnostics.push(`${input.subject}: predecessor acceptance is missing.`); return; }
 state.acceptance.push({ ...input, revision });
}
export function complete(state: GoalState, diagnostics: string[]): void {
 const missing = deficits(state);
 if (missing.length) { diagnostics.push(...missing); return; }
 state.fulfillment = "complete";
}
/** Bound durable counters and relational integrity; malformed latest snapshots are never skipped. */
export function validateGoalState(state: GoalState): void {
 requireGoal(Check(goalStateSchema, state), "state_unavailable", "Invalid snapshot shape or bounded field.");
 requireGoal(state.version === 2 && Number.isSafeInteger(state.revision) && state.revision > 0 && Number.isSafeInteger(state.serial) && state.serial >= 0, "state_unavailable", "Invalid version/counters.");
 requireGoal(state.attempts.length <= GOAL_LIMITS.attempts && state.facts.length <= GOAL_LIMITS.facts && state.calls.length <= GOAL_LIMITS.calls, "state_unavailable", "Record limit exceeded.");
 validateGraph(state);
 const attemptIds = new Set(state.attempts.map(a => a.id));
 const factIds = new Set(state.facts.map(f => f.id));
 requireGoal(new Set(state.acceptance.map(j => j.subject)).size === state.acceptance.length, "state_unavailable", "Duplicate acceptance subjects.");
 for (const a of state.attempts) {
  requireGoal(/^A[1-9][0-9]*$/.test(a.id) && Number(a.id.slice(1)) <= state.serial && a.generation <= state.input.generation, "state_unavailable", "Attempt counter or input is inconsistent.");
  if (a.status === "running") requireGoal(state.tasks.some(t => t.key === a.task && t.revision === a.revision), "state_unavailable", "Running attempt refers to obsolete task.");
 }
 for (const f of state.facts) requireGoal(f.id === `${f.attempt}:${f.key}` && f.generation <= state.input.generation && (!f.usable || f.basis.state === "current"), "state_unavailable", "Fact binding is inconsistent.");
 requireGoal(attemptIds.size === state.attempts.length && factIds.size === state.facts.length, "state_unavailable", "Duplicate durable identities.");
 for (const fact of state.facts) requireGoal(attemptIds.has(fact.attempt), "state_unavailable", "Fact references missing attempt.");
 for (const j of state.acceptance) requireGoal(subjectRevision(state, j.subject) !== undefined && j.facts.every(id => factIds.has(id)), "state_unavailable", "Acceptance references missing subject/fact.");
 if (state.fulfillment === "complete") requireGoal(deficits(state).length === 0, "state_unavailable", "Complete snapshot has deficits.");
 if (Buffer.byteLength(JSON.stringify(state)) > GOAL_LIMITS.bytes) throw new GoalError("state_limit", "Contract snapshot is full; nothing committed. Continue the task and disclose unavailable bookkeeping.");
}
