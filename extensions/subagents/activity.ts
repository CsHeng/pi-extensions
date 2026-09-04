import type { TaskExecutionPhase, TaskResult } from "./contracts.ts";
import { parseSnapshot, type RunUiPhase, type SnapshotTaskV1, type SnapshotV1 } from "./events.ts";

const SETTLED = new Set(["succeeded", "failed", "blocked", "aborted"]);

export function runUiPhase(results: readonly TaskResult[], cancellationRequested: boolean): RunUiPhase {
	if (results.length === 0) return cancellationRequested ? "settled" : "accepted";
	if (results.every((result) => SETTLED.has(result.status))) return "settled";
	const running = results.filter((result) => result.status === "running");
	if (running.length > 0) {
		const settling = running.every((result) => result.activity?.phase === "settling" || result.activity?.phase === "settled-awaiting-exit");
		return settling ? "settling" : "running";
	}
	return "accepted";
}

export function executionPhaseFor(result: TaskResult, explicit?: TaskExecutionPhase): TaskExecutionPhase {
	if (explicit) return explicit;
	if (SETTLED.has(result.status)) return "settled";
	if (result.status === "pending") return "queued";
	if (result.activity?.phase === "starting") return "workspace-preparation";
	return "child-execution";
}

export function buildSnapshot(input: {
	runId: string;
	requestedTasks: number;
	results: readonly TaskResult[];
	elapsedMs: number;
	peakConcurrency: number;
	cancellationRequested: boolean;
	phases?: ReadonlyMap<string, TaskExecutionPhase>;
}): SnapshotV1 | undefined {
	const tasks: SnapshotTaskV1[] = input.results.slice(0, 10).map((result, index) => ({
		id: result.id,
		ordinal: index + 1,
		role: result.role,
		status: result.status,
		executionPhase: executionPhaseFor(result, input.phases?.get(result.id)),
		assistantTurns: result.activity?.assistantTurns ?? result.usage.turns,
		elapsedMs: result.activity?.elapsedMs ?? result.durationMs,
		inactiveForMs: result.activity?.inactiveForMs ?? 0,
		activeTools: (result.activity?.activeTools ?? []).filter((tool): tool is SnapshotTaskV1["activeTools"][number] => (
			tool === "read" || tool === "grep" || tool === "find" || tool === "ls" || tool === "edit" || tool === "write"
		)),
		errorCount: result.activity?.errorCount ?? (result.error ? 1 : 0),
		cancellationRequested: result.status === "aborted",
	}));
	const parsed = parseSnapshot({
		version: 1,
		runId: input.runId,
		phase: runUiPhase(input.results, input.cancellationRequested),
		requestedTasks: input.requestedTasks,
		admittedTasks: input.results.length,
		launchedChildren: input.results.filter((result) => result.telemetry?.childStarted).length,
		activeChildren: input.results.filter((result) => result.status === "running").length,
		settledTasks: input.results.filter((result) => SETTLED.has(result.status)).length,
		aggregateAssistantTurns: tasks.reduce((total, task) => total + task.assistantTurns, 0),
		elapsedMs: input.elapsedMs,
		peakConcurrency: input.peakConcurrency,
		cancellationRequested: input.cancellationRequested,
		tasks,
	});
	return parsed.ok ? parsed.value : undefined;
}
