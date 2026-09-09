import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration } from "../subagents/render.ts";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";

export const SUBAGENTS_UI_STATUS_KEY = "csheng.subagents.status";
export const SUBAGENTS_UI_PANEL_KEY = "csheng.subagents.panel";
export const SUBAGENTS_UI_COMMAND = "subagents-ui";
export const OBSERVER_HEARTBEAT_MS = 5_000;
export const OBSERVER_STALE_MISSED_HEARTBEATS = 3;
export const OBSERVER_STALE_MS = OBSERVER_HEARTBEAT_MS * OBSERVER_STALE_MISSED_HEARTBEATS;
export const EMPTY_OBSERVER_MESSAGE = "No observed subagent work.";
export const OVERLAY_HELP = "↑↓ PgUp/PgDn scroll  esc close";

export type ObserverFreshness = "empty" | "live" | "stale" | "terminal";

export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	return text.split("\n").flatMap(part => wrapTextWithAnsi(part, width));
}

export function observerFreshness(
	phase: ObserverSnapshot["phase"] | undefined,
	receivedAt: number,
	now: number,
	staleMs: number = OBSERVER_STALE_MS,
): ObserverFreshness {
	if (phase === undefined) return "empty";
	if (phase === "settled") return "terminal";
	if (now - receivedAt > staleMs) return "stale";
	return "live";
}

export function displayElapsed(
	observed: number | null,
	receivedAt: number,
	now: number,
	freshness: ObserverFreshness,
): number | null {
	if (observed === null) return null;
	if (freshness === "live") return observed + Math.max(0, now - receivedAt);
	return observed;
}

export function formatRoute(task: ObserverTask): string {
	if (!task.route) return "route unavailable";
	return `${task.route.provider} ${task.route.model} thinking:${task.route.thinking}`;
}

export function formatCounts(snapshot: ObserverSnapshot, freshness: ObserverFreshness): string {
	const running = freshness === "stale" ? "unknown" : String(snapshot.activeChildren);
	return `launched ${snapshot.launchedChildren} running ${running} finished ${snapshot.settledTasks}`;
}

export function formatHeader(
	snapshot: ObserverSnapshot,
	freshness: ObserverFreshness,
	elapsedMs: number | null,
): string {
	const phase = freshness === "stale" ? "stale/unknown" : snapshot.phase;
	return `${phase} · ${formatCounts(snapshot, freshness)} · ${snapshot.aggregateAssistantTurns} turns · ${formatDuration(elapsedMs)}`;
}

export function formatTaskLine(
	task: ObserverTask,
	freshness: ObserverFreshness,
	elapsedMs: number | null,
): string {
	const liveStatus = task.status === "pending" || task.status === "running";
	const state = freshness === "stale" && liveStatus
		? "stale/unknown"
		: `${task.status} ${task.executionPhase}`;
	const replay = task.replayed ? " replayed" : "";
	const episode = task.episode === null ? "" : ` ep${task.episode}`;
	return `${task.ordinal} ${task.role} ${formatRoute(task)} ${state} t${task.assistantTurns} ${formatDuration(elapsedMs)}${episode}${replay}`;
}

export function formatStatus(snapshot: ObserverSnapshot): string {
	return `SA ${formatCounts(snapshot, "live")} · ${snapshot.aggregateAssistantTurns} turns · ${formatDuration(snapshot.elapsedMs)}`;
}

export function formatPanel(snapshot: ObserverSnapshot): string[] {
	const lines = [formatStatus(snapshot)];
	for (const task of snapshot.tasks) {
		lines.push(formatTaskLine(task, "live", task.elapsedMs));
	}
	const hidden = snapshot.admittedTasks - snapshot.tasks.length;
	if (hidden > 0) lines.push(`+${hidden} more`);
	return lines;
}

export function overlayLines(
	snapshot: ObserverSnapshot | undefined,
	freshness: ObserverFreshness,
	headerElapsed: number | null,
	taskElapsed: (task: ObserverTask) => number | null,
): string[] {
	if (!snapshot || freshness === "empty") return [EMPTY_OBSERVER_MESSAGE, OVERLAY_HELP];
	const lines = [formatHeader(snapshot, freshness, headerElapsed), OVERLAY_HELP];
	for (const task of snapshot.tasks) {
		lines.push(formatTaskLine(task, freshness, taskElapsed(task)));
	}
	const hidden = snapshot.admittedTasks - snapshot.tasks.length;
	if (hidden > 0) lines.push(`+${hidden} more`);
	return lines;
}
