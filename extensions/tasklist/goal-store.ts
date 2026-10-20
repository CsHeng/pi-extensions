import { Check } from "typebox/value";
import {
 LEGACY_TASKLIST_STATE_VERSION, TASKLIST_STATE_VERSION, legacyTasklistStateSchema, tasklistParameters, tasklistStateSchema,
 type TasklistOperation, type TasklistState, type TasklistTask, type TasklistView,
} from "./goal-contracts.ts";
import { unfinished } from "./goal-state.ts";

export interface TasklistContext { signal?: AbortSignal }

/** Private branch entry key. Kept stable so earlier written snapshots stay readable. */
export const TASKLIST_STORAGE_TYPE = "csheng-workflow-state";

const textValue = (value: unknown): string => value === undefined ? "unknown" : String(value).slice(0, 24);

function unsupported(schemaVersion: unknown, invalid = false): string {
 return "Previous task list state (schema version " + textValue(schemaVersion) + ") is " + (invalid ? "invalid" : "unsupported") +
  " and was left unchanged; no items were migrated, completed or removed. Use set to record the current task list.";
}

/** Normalize a known written snapshot into the current in-memory shape. Never mutates the stored entry. */
export function normalizeTasklistSnapshot(data: unknown): TasklistState | undefined {
 if (!data || typeof data !== "object") return undefined;
 const payload = data as { schemaVersion?: unknown; state?: unknown };
 if (payload.schemaVersion === TASKLIST_STATE_VERSION && Check(tasklistStateSchema, payload.state)) {
  return structuredClone(payload.state as TasklistState);
 }
 if (payload.schemaVersion === LEGACY_TASKLIST_STATE_VERSION && Check(legacyTasklistStateSchema, payload.state)) {
  const legacy = payload.state as { revision: number; goal: string; tasks: TasklistTask[] };
  // Pause/cancel flags were list-level control state, not item data: drop them and keep every item as written.
  return structuredClone({ version: TASKLIST_STATE_VERSION, revision: legacy.revision, title: legacy.goal, tasks: legacy.tasks } satisfies TasklistState);
 }
 return undefined;
}

export function createTasklistStore(append: (type: string, data: unknown) => void) {
 let state: TasklistState | undefined;
 let unavailable: string | undefined;
 const listeners = new Set<() => void>();
 const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* Read-only observers cannot fail a committed update. */ } } };
 const view = (): TasklistView => structuredClone({ ...(state ? { state } : {}), ...(unavailable ? { unavailable } : {}) });
 const commit = (next: TasklistState) => { append(TASKLIST_STORAGE_TYPE, { schemaVersion: TASKLIST_STATE_VERSION, state: next }); state = next; unavailable = undefined; notify(); };
 const meaning = (value: TasklistState) => JSON.stringify([value.title, value.tasks]);
 const validateTasks = (tasks: TasklistTask[]) => {
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Task ids must be unique.");
  if (tasks.some(task => task.status === "blocked" && !task.note)) throw new Error("A blocked item needs a note describing the actual blocker.");
 };
 return {
  current: () => state && structuredClone(state), view,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  mutate(op: TasklistOperation, ctx: TasklistContext = {}) {
   try {
    if (!Check(tasklistParameters, op)) throw new Error("Invalid task list update.");
    if (op.operation === "inspect") {
     if (unavailable) return { ok: false, message: unavailable, view: view() };
     return { ok: true, view: view() };
    }
    // Cancellation belongs to this invocation, not a previous provider/wake failure.
    if (ctx.signal?.aborted) return { ok: false, error: { code: "call_cancelled" as const },
     message: "This task list update was cancelled; no state changed. Retry only with an active invocation, not the same cancelled call. Tracking failure does not require repeating completed business work.", view: view() };
    let next: TasklistState;
    if (op.operation === "set") {
     if (!op.title || !op.tasks) throw new Error("set needs a title and the complete item list.");
     next = { version: TASKLIST_STATE_VERSION, revision: 0, title: op.title,
      tasks: op.tasks.map(task => { if (!task.title) throw new Error("Each item in set needs a title."); return { id: task.id, title: task.title, status: task.status ?? "todo", ...(task.note ? { note: task.note } : {}) }; }) };
    } else {
     if (!state) throw new Error(unavailable ?? "No task list exists. Use set when tracking would help.");
     next = structuredClone(state);
     if (op.operation === "update") {
      if (op.title) next.title = op.title;
      if (new Set((op.tasks ?? []).map(task => task.id)).size !== (op.tasks ?? []).length) throw new Error("An update cannot repeat an item id.");
      for (const patch of op.tasks ?? []) {
       const task = next.tasks.find(candidate => candidate.id === patch.id);
       if (!task) throw new Error("Unknown item id: " + patch.id + ". Use set to revise the task list.");
       if (patch.title !== undefined) task.title = patch.title;
       if (patch.status !== undefined) task.status = patch.status;
       if (patch.note === null) delete task.note;
       else if (patch.note !== undefined) task.note = patch.note;
      }
     } else {
      // A list-level convenience edit on item data only: it cancels work, it cannot stop an execution.
      for (const task of unfinished(next)) task.status = "cancelled";
     }
    }
    validateTasks(next.tasks);
    if (state && meaning(next) === meaning(state)) return { ok: true, view: view() };
    next.revision = (state?.revision ?? 0) + 1;
    if (!Check(tasklistStateSchema, next)) throw new Error("Invalid task list.");
    commit(next);
    return { ok: true, view: view() };
   } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Task list update failed.", view: view() }; }
  },
  replay(entries: readonly unknown[]) {
   state = undefined; unavailable = undefined;
   const newest = entries.findLast(entry => !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === TASKLIST_STORAGE_TYPE) as { data?: unknown } | undefined;
   if (newest) {
    const restored = normalizeTasklistSnapshot(newest.data);
    try {
     if (!restored) throw new Error();
     validateTasks(restored.tasks);
     state = restored;
    } catch {
     state = undefined;
     const schemaVersion = (newest.data as { schemaVersion?: unknown } | undefined)?.schemaVersion;
     // A known version with an unusable payload is invalid; anything else is simply unsupported.
     unavailable = unsupported(schemaVersion, schemaVersion === TASKLIST_STATE_VERSION || schemaVersion === LEGACY_TASKLIST_STATE_VERSION);
    }
   }
   notify();
  },
 };
}
export type TasklistStore = ReturnType<typeof createTasklistStore>;
