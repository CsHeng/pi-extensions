/** Pi task tracking. Status records the main agent's judgment, never a proof obligation. */
import { Type, type Static } from "typebox";
const text = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const status = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("blocked"), Type.Literal("done"), Type.Literal("cancelled")]);
const task = Type.Object({ id: text(80), title: text(500), status, note: Type.Optional(text()) }, { additionalProperties: false });
const patch = Type.Object({ id: text(80), title: Type.Optional(text(500)), status: Type.Optional(status), note: Type.Optional(Type.Union([text(), Type.Null()])) }, { additionalProperties: false });
export const goalParameters = Type.Object({
 operation: Type.Union([Type.Literal("set"), Type.Literal("update"), Type.Literal("inspect"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("cancel")]),
 goal: Type.Optional(text()),
 tasks: Type.Optional(Type.Array(patch, { maxItems: 100, description: "set replaces the list; each new item needs id and title, status defaults to todo. update patches existing ids atomically. blocked needs a note; note:null clears it." })),
 reason: Type.Optional(text()),
}, { additionalProperties: false });
export type GoalOperation = Static<typeof goalParameters>;
export const goalStateSchema = Type.Object({
 version: Type.Literal(5), revision: Type.Integer({ minimum: 1 }), goal: text(),
 tasks: Type.Array(task, { maxItems: 100 }), paused: Type.Boolean(), cancelled: Type.Boolean(),
 reason: Type.Optional(text()), remindedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export type GoalTask = Static<typeof task>;
export type GoalState = Static<typeof goalStateSchema>;
export interface GoalView { state?: GoalState; unavailable?: string; observation?: { tool: string; failed: boolean } }
