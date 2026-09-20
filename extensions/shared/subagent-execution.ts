import type { SessionView } from "../subagents/session-contracts.ts";

/** Execution transport only: never a verification judgment or a workflow command. */
export const SUBAGENT_EXECUTION_EVENT = "csheng.subagents.execution.v3";
export interface SubagentExecutionEvent {
	version: 3;
	eventId: string;
	kind: "task-terminal" | "run-terminal";
	runId: string;
	generation: string;
	owner: { repository: string; sessionId: string; branchAnchor: string | null };
	toolCallId: string;
	sessions: SessionView[];
	foreground?: boolean;
	timing?: { clockKey: string; submittedAtMs: number; preparedAtMs: number | null; finishedAtMs: number | null; queuedAtMs?: number; startedAtMs?: number | null };
	runObservation?: import("../subagents/observation-hooks.ts").ObservedRun;
}
