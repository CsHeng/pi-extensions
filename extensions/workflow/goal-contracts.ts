/** Version three records provenance and explicit judgment, not disk-content certification. */
import { Type, type Static } from "typebox";

export const WORKFLOW_ENTRY_TYPE = "csheng-workflow-state";
export const WORKFLOW_TOOL_NAME = "csheng_workflow";

const text = (maxLength = 2000) => Type.String({ minLength: 1, maxLength });
const key = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const list = <T extends ReturnType<typeof text>>(item: T, maxItems = 32) => Type.Array(item, { maxItems });
const requirement = Type.Object({ key, outcome: text(), verification: text(), required: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const task = Type.Object({
 key, title: text(80), covers: Type.Array(key),
 dependsOn: Type.Optional(Type.Array(key, { description: "Only task outputs actually required to start and accept this task; not display groups, phase order or every owner in a plan." })),
}, { additionalProperties: false, description: "An independently verifiable outcome. Preserve independently deliverable plan task IDs; split different acceptance or blocker boundaries. Do not collapse independent owners into an umbrella task or track each command as a task." });
const fact = Type.Object({
 key, kind: Type.Union([Type.Literal("host"), Type.Literal("agent"), Type.Literal("user"), Type.Literal("review")]),
 check: text(500), result: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
 observationId: Type.Optional(text(128)), artifacts: Type.Optional(list(text(500))),
}, { additionalProperties: false });
const judgment = Type.Object({ subject: text(80), facts: list(text(128)), accepted: Type.Boolean(), rationale: text() }, { additionalProperties: false });
const blocker = Type.Object({ kind: Type.Union([Type.Literal("authority"), Type.Literal("decision"), Type.Literal("prerequisite"), Type.Literal("capability"), Type.Literal("conflict"), Type.Literal("non_convergent")]), reason: text(), unblock: text() }, { additionalProperties: false });
const enums = <T extends string>(...values: T[]) => Type.Unsafe<T>({ type: "string", enum: values });
// Single object is compatible with provider function schemas; per-operation requirements are checked by code.
export const goalParameters = Type.Object({
 operation: enums("enroll", "start", "report", "amend", "inspect", "close", "suspend", "resume"),
 goal: Type.Optional(text()), delivery: Type.Optional(text()), authority: Type.Optional(text()),
 requirements: Type.Optional(Type.Array(requirement, { minItems: 1 })),
 tasks: Type.Optional(Type.Array(task)),
 subject: Type.Optional(text(128)), task: Type.Optional(key),
 scope: Type.Optional(Type.Array(text(500), { maxItems: 32, description: "Filesystem file/directory paths whose state the work and checks depend on, relative to cwd or explicitly authorized absolute roots. Not task descriptions, goals or summaries. Include the actual checked source paths; planned missing paths are supported." })),
 writes: Type.Optional(Type.Array(text(500), { maxItems: 32, description: "Planned filesystem write paths for overlap detection, relative to cwd or explicitly authorized absolute roots. Not objectives, summaries or permission grants; missing targets for new files are supported." })),
 attempt: Type.Optional(text(64)), summary: Type.Optional(text()),
 reconciledExecutions: Type.Optional(Type.Array(text(128), { uniqueItems: true, description: "Resume only: recovered execution IDs whose terminal state or explicit owner disposition the main agent reconciled. Requires alignment, reason and existing authority; never cancels live execution or imports evidence." })),
 facts: Type.Optional(Type.Array(fact, { maxItems: 32 })), judgments: Type.Optional(Type.Array(judgment, { maxItems: 64 })),
 complete: Type.Optional(Type.Boolean()), blocker: Type.Optional(blocker),
 outcome: Type.Optional(enums("completed", "cancelled", "superseded")),
 reason: Type.Optional(text()), condition: Type.Optional(text()), alignment: Type.Optional(text()),
}, { additionalProperties: false });
export type GoalOperation = Static<typeof goalParameters>;
export type GoalFactInput = Static<typeof fact>;
export type GoalJudgment = Static<typeof judgment>;
export interface GoalRequirement extends Static<typeof requirement> { revision: number }
export interface GoalTask extends Static<typeof task> { revision: number; blocker?: Static<typeof blocker> }
export interface GoalAttempt {
 id: string; task: string; revision: number; generation: number; started: string;
 status: "running" | "reported" | "interrupted"; scope: string[]; writes: string[];
 summary?: string;
}
export interface GoalFact extends GoalFactInput {
 id: string; attempt: string; scope: string[]; at: string; generation: number;
 usable: boolean; note?: string; checkIdentity?: string;
}
export interface GoalAcceptance extends GoalJudgment { revision: number }
export interface GoalState {
 version: 3; revision: number; id: string;
 goal: string; delivery: string; authority: string; goalRevision: number;
 fulfillment: "pending" | "complete" | "cancelled" | "superseded";
 continuation: { state: "active" | "waiting" | "suspended"; reason?: string; unblock?: string; lastProgress?: string; repeat: number; dispatched: number; waitingFor?: string[]; automaticPaused?: boolean };
 input: { generation: number; aligned: boolean; unknown: boolean };
 requirements: GoalRequirement[]; tasks: GoalTask[]; attempts: GoalAttempt[]; facts: GoalFact[]; acceptance: GoalAcceptance[];
 /** Inert provenance retained when reading v2 snapshots created by the retired v1 migrator. */
 legacy?: { revision: number; id: string; goal: string };
 replacement?: { id: string; revision: number; alignment: string; unresolvedExecutions: string[] };
 executionPending?: string[];
 recoveredExecutions?: string[];
 executionReconciliations?: Array<{ ids: string[]; reason: string; authority: string; alignment: string }>;
 calls: string[]; serial: number;
}
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const basis = Type.Object({ scope: list(text(500)), fingerprint: text(256), state: enums("current", "unavailable"), note: Type.Optional(text()) }, { additionalProperties: false });
export const goalStateSchema = Type.Object({
 version: Type.Literal(3), revision: Type.Integer({ minimum: 1 }), id: text(128), goal: text(), delivery: text(), authority: text(), goalRevision: Type.Integer({ minimum: 1 }),
 fulfillment: enums("pending", "complete", "cancelled", "superseded"),
 continuation: Type.Object({ state: enums("active", "waiting", "suspended"), reason: Type.Optional(text()), unblock: Type.Optional(text()), lastProgress: Type.Optional(text(128)), repeat: integer, dispatched: integer, waitingFor: Type.Optional(Type.Array(text(128))), automaticPaused: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
 input: Type.Object({ generation: integer, aligned: Type.Boolean(), unknown: Type.Boolean() }, { additionalProperties: false }),
 requirements: Type.Array(Type.Object({ ...requirement.properties, revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { minItems: 1 }),
 tasks: Type.Array(Type.Object({ ...task.properties, revision: Type.Integer({ minimum: 1 }), blocker: Type.Optional(blocker) }, { additionalProperties: false })),
 // Session lifetime is not an execution budget. Retain evidence and idempotency identities without a cumulative cutoff.
 attempts: Type.Array(Type.Object({ id: text(64), task: key, revision: Type.Integer({ minimum: 1 }), generation: integer, started: text(100), status: enums("running", "reported", "interrupted"), scope: list(text(500)), writes: list(text(500)), summary: Type.Optional(text()) }, { additionalProperties: false })),
 facts: Type.Array(Type.Object({ ...fact.properties, id: text(128), attempt: text(64), scope: list(text(500)), at: text(100), generation: integer, usable: Type.Boolean(), note: Type.Optional(text()), checkIdentity: Type.Optional(text(128)) }, { additionalProperties: false })),
 acceptance: Type.Array(Type.Object({ ...judgment.properties, revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
 replacement: Type.Optional(Type.Object({ id: text(128), revision: integer, alignment: text(), unresolvedExecutions: Type.Array(text(128)) }, { additionalProperties: false })),
 recoveredExecutions: Type.Optional(Type.Array(text(128))),
 executionReconciliations: Type.Optional(Type.Array(Type.Object({ ids: Type.Array(text(128)), reason: text(), authority: text(), alignment: text() }, { additionalProperties: false }))),
 legacy: Type.Optional(Type.Object({ revision: integer, id: text(128), goal: text(4000) }, { additionalProperties: false })), executionPending: Type.Optional(Type.Array(text(128))), calls: Type.Array(text(256)), serial: integer,
}, { additionalProperties: false });
// V2 is read-only historical evidence; its accepted state is never imported into V3.
const { replacement: _replacement, recoveredExecutions: _recovered, executionReconciliations: _reconciliations, ...legacyProperties } = goalStateSchema.properties;
export const legacyGoalStateSchema = Type.Object({ ...legacyProperties, version: Type.Literal(2),
 attempts: Type.Array(Type.Object({ id: text(64), task: key, revision: Type.Integer({ minimum: 1 }), generation: integer, started: text(100), status: enums("running", "reported", "interrupted"), basis, writes: list(text(500)), summary: Type.Optional(text()) }, { additionalProperties: false })),
 facts: Type.Array(Type.Object({ ...fact.properties, id: text(128), attempt: text(64), basis, at: text(100), generation: integer, usable: Type.Boolean(), note: Type.Optional(text()), checkIdentity: Type.Optional(text(128)) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type LegacyGoalState = Static<typeof legacyGoalStateSchema>;
export interface GoalSnapshot { schemaVersion: 3; state: GoalState }
export interface GoalView { state?: GoalState; legacy?: LegacyGoalState; unavailable?: string; deficits: string[] }
// This bounds repeated automatic dispatch, not the amount of legitimate work in a contract.
export const GOAL_LIMITS = { noProgress: 2 } as const;
export class GoalError extends Error {
 readonly code: string;
 constructor(code: string, message: string) { super(message); this.code = code; }
}
export function requireGoal(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new GoalError(code, message); }
