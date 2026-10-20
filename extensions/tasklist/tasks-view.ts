/** Owner-scoped read-only Tasks snapshot. Queries never mutate, remind, wake, or enter model context. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TasklistState, TasklistTask } from "./goal-contracts.ts";
import type { TasklistStore } from "./goal-store.ts";

/** Bumped because the published state shape lost list-level control fields. */
export const TASKS_VIEW_VERSION = 2;
export const TASKS_VIEW_REQUEST_EVENT = "csheng.workflow.tasks-view.request";
export const TASKS_VIEW_EVENT = "csheng.workflow.tasks-view";
/** Invalidation only; contains no task payload and prompts an open consumer to requery. */
export const TASKS_VIEW_CHANGED_EVENT = "csheng.workflow.tasks-view.changed";
/** Owner reset or shutdown. Consumers drop cached snapshots and requery after a new bind. */
export const TASKS_VIEW_RESET_EVENT = "csheng.workflow.tasks-view.reset";

const TASK_STATUSES = ["todo", "doing", "blocked", "done", "cancelled"] as const;
const REASONS = ["untrusted", "unsupported"] as const;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const REQUEST_KEYS = ["version", "requestId"];
const CHANGED_KEYS = ["version", "generation"];
const RESET_KEYS = ["version", "generation"];
const RESET_OPTIONAL = ["ownerSessionId", "anchor"];
const REPLY_KEYS = ["version", "requestId", "ownerSessionId", "anchor", "generation", "availability"];
const REPLY_OPTIONAL = ["reason", "state"];
const STATE_KEYS = ["revision", "title", "tasks"];
const TASK_KEYS = ["id", "title", "status"];
const TASK_OPTIONAL = ["note"];

export interface TasksViewRequest { version: typeof TASKS_VIEW_VERSION; requestId: string }
export interface TasksViewChanged { version: typeof TASKS_VIEW_VERSION; generation: string }
export interface TasksViewReset { version: typeof TASKS_VIEW_VERSION; generation: string; ownerSessionId?: string; anchor?: string | null }
export interface TasksViewTask { id: string; title: string; status: TasklistTask["status"]; note?: string }
export interface TasksViewState { revision: number; title: string; tasks: TasksViewTask[] }
export interface TasksViewReply {
 version: typeof TASKS_VIEW_VERSION;
 requestId: string;
 ownerSessionId: string;
 anchor: string | null;
 generation: string;
 availability: "ready" | "unavailable";
 reason?: (typeof REASONS)[number];
 state?: TasksViewState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysExact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
 const allowed = new Set([...required, ...optional]);
 return Object.keys(record).every(key => allowed.has(key)) && required.every(key => key in record);
}
function boundedText(value: unknown, max: number): value is string {
 return typeof value === "string" && value.length > 0 && value.length <= max && !TERMINAL_CONTROL.test(value);
}
function displayText(value: unknown, max: number): value is string {
 return typeof value === "string" && value.length > 0 && value.length <= max && Buffer.byteLength(value, "utf8") <= max * 4;
}
function revision(value: unknown): value is number {
 return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function parseTasksViewRequest(value: unknown): TasksViewRequest | undefined {
 if (!isRecord(value) || !keysExact(value, REQUEST_KEYS)) return undefined;
 if (value.version !== TASKS_VIEW_VERSION || !boundedText(value.requestId, 128)) return undefined;
 return { version: TASKS_VIEW_VERSION, requestId: value.requestId };
}
export function parseTasksViewChanged(value: unknown): TasksViewChanged | undefined {
 if (!isRecord(value) || !keysExact(value, CHANGED_KEYS)) return undefined;
 if (value.version !== TASKS_VIEW_VERSION || !boundedText(value.generation, 32)) return undefined;
 return { version: TASKS_VIEW_VERSION, generation: value.generation };
}
export function parseTasksViewReset(value: unknown): TasksViewReset | undefined {
 if (!isRecord(value) || !keysExact(value, RESET_KEYS, RESET_OPTIONAL)) return undefined;
 if (value.version !== TASKS_VIEW_VERSION || !boundedText(value.generation, 32)) return undefined;
 if ("ownerSessionId" in value && !boundedText(value.ownerSessionId, 256)) return undefined;
 if ("anchor" in value && value.anchor !== null && !boundedText(value.anchor, 256)) return undefined;
 return {
  version: TASKS_VIEW_VERSION,
  generation: value.generation,
  ...("ownerSessionId" in value ? { ownerSessionId: value.ownerSessionId as string } : {}),
  ...("anchor" in value ? { anchor: value.anchor as string | null } : {}),
 };
}
function parseTask(value: unknown): TasksViewTask | undefined {
 if (!isRecord(value) || !keysExact(value, TASK_KEYS, TASK_OPTIONAL)) return undefined;
 if (!displayText(value.id, 80) || !displayText(value.title, 500)) return undefined;
 if (typeof value.status !== "string" || !TASK_STATUSES.includes(value.status as TasksViewTask["status"])) return undefined;
 if ("note" in value && !displayText(value.note, 4000)) return undefined;
 return { id: value.id, title: value.title, status: value.status as TasksViewTask["status"], ...("note" in value ? { note: value.note as string } : {}) };
}
function parseState(value: unknown): TasksViewState | undefined {
 if (!isRecord(value) || !keysExact(value, STATE_KEYS) || !revision(value.revision) || !displayText(value.title, 4000)) return undefined;
 if (!Array.isArray(value.tasks) || value.tasks.length > 100) return undefined;
 const tasks: TasksViewTask[] = [];
 for (const task of value.tasks) {
  const parsed = parseTask(task);
  if (!parsed) return undefined;
  tasks.push(parsed);
 }
 return { revision: value.revision, title: value.title, tasks };
}
export function parseTasksViewReply(value: unknown): { ok: true; value: TasksViewReply } | { ok: false } {
 if (!isRecord(value) || !keysExact(value, REPLY_KEYS, REPLY_OPTIONAL)) return { ok: false };
 if (value.version !== TASKS_VIEW_VERSION || !boundedText(value.requestId, 128) || !boundedText(value.ownerSessionId, 256)) return { ok: false };
 if (value.anchor !== null && !boundedText(value.anchor, 256)) return { ok: false };
 if (!boundedText(value.generation, 32) || (value.availability !== "ready" && value.availability !== "unavailable")) return { ok: false };
 if (value.availability === "unavailable") {
  if (!("reason" in value) || typeof value.reason !== "string" || !REASONS.includes(value.reason as (typeof REASONS)[number]) || "state" in value) return { ok: false };
  return { ok: true, value: { version: TASKS_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId, anchor: value.anchor, generation: value.generation, availability: "unavailable", reason: value.reason as (typeof REASONS)[number] } };
 }
 if ("reason" in value) return { ok: false };
 if (!("state" in value)) return { ok: true, value: { version: TASKS_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId, anchor: value.anchor, generation: value.generation, availability: "ready" } };
 const state = parseState(value.state);
 if (!state) return { ok: false };
 return { ok: true, value: { version: TASKS_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId, anchor: value.anchor, generation: value.generation, availability: "ready", state } };
}

function project(state: TasklistState): TasksViewState {
 return {
  revision: state.revision, title: state.title,
  tasks: state.tasks.map(task => ({ id: task.id, title: task.title, status: task.status, ...(task.note ? { note: task.note } : {}) })),
 };
}
function leafId(ctx: ExtensionContext): string | null {
 const leaf = ctx.sessionManager.getLeafId();
 return typeof leaf === "string" && leaf.length > 0 ? leaf : null;
}

export function registerTasksView(pi: ExtensionAPI, store: TasklistStore) {
 let ctx: ExtensionContext | undefined;
 let generation = 0;
 let bound = false;
 const generationId = () => String(generation);
 const emit = (name: string, data: unknown) => { try { pi.events.emit(name, data); } catch { /* Observer delivery cannot roll back committed task state. */ } };
 const unsubscribe = store.subscribe(() => {
  if (!bound) return;
  emit(TASKS_VIEW_CHANGED_EVENT, { version: TASKS_VIEW_VERSION, generation: generationId() } satisfies TasksViewChanged);
 });
 const answer = (data: unknown) => {
  const request = parseTasksViewRequest(data);
  if (!request || !ctx || !bound) return;
  const ownerSessionId = ctx.sessionManager.getSessionId();
  if (!ownerSessionId) return;
  const anchor = leafId(ctx);
  const trusted = ctx.isProjectTrusted();
  const view = trusted ? store.view() : undefined;
  const reply: TasksViewReply = !trusted || !view
   ? { version: TASKS_VIEW_VERSION, requestId: request.requestId, ownerSessionId, anchor, generation: generationId(), availability: "unavailable", reason: "untrusted" }
   : view.unavailable
    ? { version: TASKS_VIEW_VERSION, requestId: request.requestId, ownerSessionId, anchor, generation: generationId(), availability: "unavailable", reason: "unsupported" }
    : view.state
     ? { version: TASKS_VIEW_VERSION, requestId: request.requestId, ownerSessionId, anchor, generation: generationId(), availability: "ready", state: project(view.state) }
     : { version: TASKS_VIEW_VERSION, requestId: request.requestId, ownerSessionId, anchor, generation: generationId(), availability: "ready" };
  const parsed = parseTasksViewReply(reply);
  if (parsed.ok) emit(TASKS_VIEW_EVENT, parsed.value);
 };
 pi.events.on(TASKS_VIEW_REQUEST_EVENT, answer);
 return {
  hold() { bound = false; },
  bind(next: ExtensionContext) {
   ctx = next; generation += 1; bound = true;
   const ownerSessionId = next.sessionManager.getSessionId();
   emit(TASKS_VIEW_RESET_EVENT, { version: TASKS_VIEW_VERSION, generation: generationId(), ...(ownerSessionId ? { ownerSessionId } : {}), anchor: leafId(next) } satisfies TasksViewReset);
   emit(TASKS_VIEW_CHANGED_EVENT, { version: TASKS_VIEW_VERSION, generation: generationId() } satisfies TasksViewChanged);
  },
  unbind() {
   bound = false; generation += 1; ctx = undefined;
   emit(TASKS_VIEW_RESET_EVENT, { version: TASKS_VIEW_VERSION, generation: generationId() } satisfies TasksViewReset);
  },
  dispose() { unsubscribe(); },
 };
}
