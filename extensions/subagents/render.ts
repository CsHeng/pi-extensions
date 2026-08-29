import type { SubagentRunResult, TaskResult } from "./contracts.ts";

export function formatProgress(results: readonly TaskResult[]): string {
	const running = results.filter((result) => result.status === "running").length;
	const settled = results.filter((result) => result.status !== "pending" && result.status !== "running").length;
	return `Subagents: ${settled}/${results.length} settled, ${running} running`;
}

export function formatRunResult(result: SubagentRunResult): string {
	const lines = [`Subagent run: ${result.status}`];
	for (const task of result.tasks) {
		const route = task.route ? ` ${task.route.provider}/${task.route.model}:${task.route.thinking}` : "";
		lines.push(`\n[${task.id}] ${task.role} ${task.status}${route}`);
		if (task.changedPaths.length > 0) lines.push(`Changed: ${task.changedPaths.join(", ")}`);
		if (task.error) lines.push(`Error (${task.error.code}): ${task.error.message}`);
		if (task.output) lines.push(task.output);
	}
	return lines.join("\n");
}
