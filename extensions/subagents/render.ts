import type { SubagentRunResult, TaskResult } from "./contracts.ts";

export function formatProgress(results: readonly TaskResult[]): string {
	const running = results.filter((result) => result.status === "running").length;
	const settled = results.filter((result) => result.status !== "pending" && result.status !== "running").length;
	return `Subagents: ${settled}/${results.length} settled, ${running} running`;
}

export function formatRunResult(result: SubagentRunResult): string {
	const telemetry = result.telemetry;
	const lines = [
		`Subagent run: ${result.status}`,
		`Run ${telemetry.runId} launched=${telemetry.launchedChildren}/${telemetry.admittedTasks} peak=${telemetry.peakConcurrency}`,
	];
	for (const task of result.tasks) {
		const route = task.route ? ` ${task.route.provider}/${task.route.model}:${task.route.thinking}` : "";
		const profile = task.route && (task.route.executionProfileRequested || task.route.reasoningProfileRequested)
			? ` profiles=${task.route.executionProfileRequested ?? "default"}/${task.route.reasoningProfileRequested ?? "default"}`
			: "";
		lines.push(`\n[${task.id}] ${task.role} ${task.status}${route}${profile}`);
		if (task.changedPaths.length > 0) lines.push(`Changed: ${task.changedPaths.join(", ")}`);
		if (task.error) lines.push(`Error (${task.error.code}): ${task.error.message}`);
		if (task.output) lines.push(task.output);
	}
	return lines.join("\n");
}
