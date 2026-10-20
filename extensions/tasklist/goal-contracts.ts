/** Passive Pi Tasklist. Item status records the main agent's judgment, never a proof obligation or execution gate. */
import { Type, type Static } from "typebox";
const text = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const status = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("blocked"), Type.Literal("done"), Type.Literal("cancelled")]);
const item = Type.Object({ id: text(80), title: text(500), status, note: Type.Optional(text()) }, { additionalProperties: false });
const patch = Type.Object({ id: text(80), title: Type.Optional(text(500)), status: Type.Optional(status), note: Type.Optional(Type.Union([text(), Type.Null()])) }, { additionalProperties: false });
export const tasklistParameters = Type.Object({
 operation: Type.Union([Type.Literal("set"), Type.Literal("update"), Type.Literal("inspect"), Type.Literal("cancel")]),
 title: Type.Optional(text()),
 tasks: Type.Optional(Type.Array(patch, { maxItems: 100, description: "set replaces the list; each new item needs id and title, status defaults to todo. update patches existing items by id atomically. blocked needs a note; note:null clears it." })),
}, { additionalProperties: false });
export type TasklistOperation = Static<typeof tasklistParameters>;

/** Current written representation. Known older snapshots are normalized in memory, never rewritten. */
export const TASKLIST_STATE_VERSION = 6;
/** Last shipped tracking representation: same item data plus removed list-level pause/cancel control state. */
export const LEGACY_TASKLIST_STATE_VERSION = 5;
export const tasklistStateSchema = Type.Object({
 version: Type.Literal(TASKLIST_STATE_VERSION), revision: Type.Integer({ minimum: 1 }), title: text(),
 tasks: Type.Array(item, { maxItems: 100 }),
}, { additionalProperties: false });
export const legacyTasklistStateSchema = Type.Object({
 version: Type.Literal(LEGACY_TASKLIST_STATE_VERSION), revision: Type.Integer({ minimum: 1 }), goal: text(),
 tasks: Type.Array(item, { maxItems: 100 }), paused: Type.Boolean(), cancelled: Type.Boolean(),
 reason: Type.Optional(text()), remindedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export type TasklistTask = Static<typeof item>;
export type TasklistTaskStatus = TasklistTask["status"];
export type TasklistState = Static<typeof tasklistStateSchema>;
export interface TasklistView { state?: TasklistState; unavailable?: string }
