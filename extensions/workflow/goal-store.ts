import { Check } from "typebox/value";
import { goalParameters, goalStateSchema, type GoalOperation, type GoalState, type GoalTask, type GoalView } from "./goal-contracts.ts";
import { actionable, unfinished } from "./goal-state.ts";
export interface GoalContext { signal?: AbortSignal; fenced?: () => boolean }
export function createGoalStore(append: (type: string, data: unknown) => void) {
 let state: GoalState | undefined;
 let unavailable: string | undefined;
 let observation: GoalView["observation"];
 const listeners = new Set<() => void>();
 const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* Read-only observers cannot fail a committed update. */ } } };
 const view = (): GoalView => structuredClone({ ...(state ? { state } : {}), ...(unavailable ? { unavailable } : {}), ...(observation ? { observation } : {}) });
 const commit = (next: GoalState) => { append("csheng-workflow-state", { schemaVersion: 5, state: next }); state = next; unavailable = undefined; notify(); };
 const validateTasks = (tasks: GoalTask[]) => {
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Task ids must be unique.");
  if (tasks.some(task => task.status === "blocked" && !task.note)) throw new Error("A blocked task needs a note describing the actual blocker.");
 };
 return {
  current: () => state && structuredClone(state), view,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  mutate(op: GoalOperation, ctx: GoalContext = {}) {
   try {
    if (!Check(goalParameters, op)) throw new Error("Invalid task update.");
    if (op.operation === "inspect") return { ok: true, view: view() };
    if (ctx.signal?.aborted || ctx.fenced?.()) throw new Error("The host interrupted this update; no state changed.");
    let next: GoalState;
    if (op.operation === "set") {
     if (!op.goal || !op.tasks) throw new Error("set needs a goal and the complete task list.");
     next = { version: 5, revision: (state?.revision ?? 0) + 1, goal: op.goal, paused: false, cancelled: false,
      tasks: op.tasks.map(task => { if (!task.title) throw new Error("Each task in set needs a title."); return { id: task.id, title: task.title, status: task.status ?? "todo", ...(task.note ? { note: task.note } : {}) }; }) };
    } else {
     if (!state) throw new Error(unavailable ?? "No task list exists. Use set when tracking would help.");
     if (state.cancelled) throw new Error("This list was cancelled. Use set explicitly for a new task list.");
     next = structuredClone(state);
     if (op.operation === "update") {
      if (op.goal) next.goal = op.goal;
      if (new Set((op.tasks ?? []).map(task => task.id)).size !== (op.tasks ?? []).length) throw new Error("An update cannot repeat a task id.");
      for (const patch of op.tasks ?? []) {
       const task = next.tasks.find(task => task.id === patch.id);
       if (!task) throw new Error("Unknown task id: " + patch.id + ". Use set to revise the task list.");
       if (patch.title !== undefined) task.title = patch.title;
       if (patch.status !== undefined) task.status = patch.status;
       if (patch.note === null) delete task.note;
       else if (patch.note !== undefined) task.note = patch.note;
      }
     } else if (op.operation === "pause") {
      if (!op.reason) throw new Error("pause needs the real pause reason.");
      next.paused = true; next.reason = op.reason;
     } else if (op.operation === "resume") {
      next.paused = false; delete next.reason;
     } else if (op.operation === "cancel") {
      next.cancelled = true; next.paused = false;
      if (op.reason) next.reason = op.reason;
      for (const task of unfinished(next)) task.status = "cancelled";
     }
     if (JSON.stringify(next) === JSON.stringify(state)) return { ok: true, view: view() };
     next.revision++;
    }
    validateTasks(next.tasks);
    if (!Check(goalStateSchema, next)) throw new Error("Invalid task list.");
    const meaning = (value: GoalState) => JSON.stringify([value.goal, value.tasks, value.paused, value.cancelled, value.reason]);
    if (state && meaning(next) === meaning(state)) return { ok: true, view: view() };
    commit(next);
    return { ok: true, view: view() };
   } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Task tracking update failed.", view: view() }; }
  },
  replay(entries: readonly unknown[]) {
   state = undefined; unavailable = undefined; observation = undefined;
   const newest = entries.findLast(entry => !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === "csheng-workflow-state") as { data?: { schemaVersion?: number; state?: unknown } } | undefined;
   if (newest) {
    try {
     if (newest.data?.schemaVersion !== 5 || !Check(goalStateSchema, newest.data.state)) throw new Error();
     const restored = newest.data.state as GoalState; validateTasks(restored.tasks); state = structuredClone(restored);
    } catch { unavailable = "Previous workflow state is unsupported or invalid and was ignored; no tasks or completion were migrated. Use set to record the current task list."; }
   }
   notify();
  },
  recover(reason: string) { if (state && !state.cancelled && unfinished(state).length) { state = { ...state, paused: true, reason }; notify(); } },
  pause(reason: string) { if (state && !state.cancelled && unfinished(state).length) return this.mutate({ operation: "pause", reason }); },
  observe(tool: string, failed: boolean) { if (state) { observation = { tool, failed }; notify(); } },
  receivedInput() { if (state) delete state.remindedRevision; },
  canRemind() { return !!state && !state.paused && !state.cancelled && actionable(state) && state.remindedRevision !== state.revision; },
  remind(send: () => void) { if (!this.canRemind() || !state) return false; commit({ ...state, remindedRevision: state.revision }); send(); return true; },
 };
}
export type GoalStore = ReturnType<typeof createGoalStore>;
