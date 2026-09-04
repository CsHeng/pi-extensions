import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { SubagentRunResult, TaskResult } from "./contracts.ts";

const SUMMARY_SCALAR_CHARS = 300;

function singleLine(value: string): string {
	return truncateLine(value.replace(/\s+/g, " ").trim(), SUMMARY_SCALAR_CHARS).text;
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split("\n").length;
}

export function formatDuration(durationMs: number): string {
	const milliseconds = Math.max(0, Math.floor(durationMs));
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = (milliseconds % 60_000) / 1_000;
	return `${minutes}m ${seconds.toFixed(1)}s`;
}

export function formatClock(durationMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function profileSummary(task: TaskResult): string {
	if (!task.route) return "";
	const profiles: string[] = [];
	if (task.route.executionProfileRequested) {
		profiles.push(`execution:${task.route.executionProfileRequested}/${task.route.executionProfileApplied ? "applied" : "not-applied"}`);
	}
	if (task.route.reasoningProfileRequested) {
		profiles.push(`reasoning:${task.route.reasoningProfileRequested}/${task.route.reasoningProfileApplied ? "applied" : "not-applied"}`);
	}
	if (task.route.profileFallbacks.length > 0) profiles.push(`fallbacks:${task.route.profileFallbacks.join(",")}`);
	return profiles.length === 0 ? "" : ` profiles=${singleLine(profiles.join(";"))}`;
}

function routeSummary(task: TaskResult): string {
	if (!task.route) return "";
	return ` route=${singleLine(`${task.route.provider}/${task.route.model}`)}:${singleLine(task.route.thinking)}`;
}

function taskSummary(task: TaskResult): string {
	const route = task.route
		? `${routeSummary(task)} source=${task.route.source} selection=${task.route.selectionSource ?? "unavailable"}`
		: "";
	const error = task.error ? ` error=${singleLine(task.error.code)}` : "";
	return `[${singleLine(task.id)}] ${task.role} ${task.status} elapsed=${formatDuration(task.durationMs)}${route}${profileSummary(task)} convergence=${task.convergence} changed=${task.changedPaths.length}${error}`;
}

function taskBody(task: TaskResult): string {
	const lines: string[] = [];
	if (task.changedPaths.length > 0) {
		lines.push("Changed paths:", ...task.changedPaths);
	}
	if (task.error) lines.push(`Error (${task.error.code}): ${task.error.message}`);
	if (task.output) lines.push("Output:", task.output);
	return lines.join("\n");
}

export function boundToolContent(content: string): string {
	const initial = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!initial.truncated) return content;
	const marker = `[Tool result truncated: ${initial.totalBytes} bytes, ${initial.totalLines} lines total]`;
	const markerBytes = Buffer.byteLength(`\n${marker}`, "utf8");
	const body = truncateHead(content, {
		maxBytes: Math.max(0, DEFAULT_MAX_BYTES - markerBytes),
		maxLines: Math.max(0, DEFAULT_MAX_LINES - 1),
	});
	return body.content ? `${body.content}\n${marker}` : marker;
}

export function formatProgress(results: readonly TaskResult[]): string {
	const running = results.filter((result) => result.status === "running").length;
	const finished = results.filter((result) => result.status !== "pending" && result.status !== "running").length;
	const turns = results.reduce((total, result) => total + (result.activity?.assistantTurns ?? result.usage.turns), 0);
	const elapsedMs = results.reduce((longest, result) => Math.max(longest, result.activity?.elapsedMs ?? result.durationMs), 0);
	const lines = [`Subagents ${running}/${results.length} running, ${finished} finished · ${turns} turns · ${formatClock(elapsedMs)}`];
	for (const result of results) {
		if (result.status === "pending") continue;
		if (result.status === "running" && result.activity) {
			const tools = result.activity.activeTools.length > 0 ? ` tool=${singleLine(result.activity.activeTools.join(","))}` : "";
			const errors = result.activity.errorCount > 0 ? ` errs=${result.activity.errorCount}` : "";
			lines.push(`[${singleLine(result.id)}] ${result.role} ${result.activity.phase}${routeSummary(result)} elapsed=${formatDuration(result.activity.elapsedMs)} turns=${result.activity.assistantTurns}${tools}${errors} inactive=${formatDuration(result.activity.inactiveForMs)}`);
			continue;
		}
		const elapsed = result.status === "running" && result.durationMs === 0
			? ""
			: ` elapsed=${formatDuration(result.durationMs)}`;
		lines.push(`[${singleLine(result.id)}] ${result.role} ${result.status}${routeSummary(result)}${elapsed}`);
	}
	return lines.join("\n");
}

export function formatRunResult(result: SubagentRunResult): string {
	const telemetry = result.telemetry;
	const summaryLines = [
		`Subagent run: ${result.status} elapsed=${formatDuration(telemetry.runDurationMs)}`,
		`Run ${singleLine(telemetry.runId)} launched=${telemetry.launchedChildren}/${telemetry.admittedTasks} peak=${telemetry.peakConcurrency}`,
		...result.tasks.map(taskSummary),
	];
	const summary = summaryLines.join("\n");
	const bodies = result.tasks
		.map((task) => ({ task, body: taskBody(task) }))
		.filter((entry) => entry.body.length > 0)
		.map((entry) => {
			const header = `--- [${singleLine(entry.task.id)}] details ---`;
			const marker = `[Task details truncated: ${Buffer.byteLength(entry.body, "utf8")} bytes, ${lineCount(entry.body)} lines total]`;
			return { ...entry, header, marker };
		});
	if (bodies.length === 0) return summary;

	const fixedBytes = Buffer.byteLength(summary, "utf8") + bodies.reduce(
		(total, entry) => total + Buffer.byteLength(`\n\n${entry.header}\n\n${entry.marker}`, "utf8"),
		0,
	);
	const availableBytes = Math.max(0, DEFAULT_MAX_BYTES - fixedBytes);
	const availableLines = Math.max(0, DEFAULT_MAX_LINES - summaryLines.length - bodies.length * 4);
	const bodyByteBudget = Math.floor(availableBytes / bodies.length);
	const bodyLineBudget = Math.floor(availableLines / bodies.length);
	const sections = bodies.map((entry) => {
		const truncated = truncateHead(entry.body, {
			maxBytes: bodyByteBudget,
			maxLines: bodyLineBudget,
		});
		const lines = [`\n${entry.header}`];
		if (truncated.content) lines.push(truncated.content);
		if (truncated.truncated) lines.push(entry.marker);
		return lines.join("\n");
	});
	const rendered = [summary, ...sections].join("\n");
	if (Buffer.byteLength(rendered, "utf8") <= DEFAULT_MAX_BYTES && lineCount(rendered) <= DEFAULT_MAX_LINES) {
		return rendered;
	}

	const fallback = `${summary}\n[Task details omitted to enforce Pi tool-output limits.]`;
	return boundToolContent(fallback);
}
