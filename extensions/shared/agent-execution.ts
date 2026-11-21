import type { SessionView } from "../agents/session-contracts.ts";

/** Execution transport only: never a verification judgment or a task command. */
export const AGENT_EXECUTION_EVENT = "agents.execution.v5";
export interface AgentExecutionEvent {
	version: 5;
	eventId: string;
	kind: "task-terminal" | "run-terminal";
	runId: string;
	generation: string;
	owner: { repository: string; sessionId: string; branchAnchor: string | null };
	toolCallId: string;
	sessions: SessionView[];
	foreground?: boolean;
	timing?: { clockKey: string; submittedAtMs: number; preparedAtMs: number | null; finishedAtMs: number | null; queuedAtMs?: number; startedAtMs?: number | null };
	runObservation?: import("../agents/observation-hooks.ts").ObservedRun;
}
