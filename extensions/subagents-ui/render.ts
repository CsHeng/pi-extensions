import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration } from "../subagents/render.ts";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";

export const SUBAGENTS_UI_STATUS_KEY = "csheng.subagents.status";
export const SUBAGENTS_UI_PANEL_KEY = "csheng.subagents.panel";
export const SUBAGENTS_UI_COMMAND = "subagents-ui";
export const OBSERVER_HEARTBEAT_MS = 5_000;
export const OBSERVER_STALE_MISSED_HEARTBEATS = 3;
export const OBSERVER_STALE_MS = OBSERVER_HEARTBEAT_MS * OBSERVER_STALE_MISSED_HEARTBEATS;
export const EMPTY_OBSERVER_MESSAGE = "No observed subagent work.";
export const OVERLAY_TITLE = "Subagents";
export const OVERLAY_HELP = "↑↓ PgUp/PgDn scroll  ctrl+alt+f close";
export const OVERLAY_CLOSE_CHIP = "[ ✕ ]";
export const OVERLAY_HORIZONTAL_MARGIN = 1;
export const PANEL_PADDING_X = 1;
/** Previous default overlay width, kept as the floor so short content does not shrink the panel. */
export const PANEL_MIN_WIDTH = 80;
/** Space kept between the close chip and the panel's right edge. */
const CLOSE_CHIP_TRAILING_PAD = 1;

export type OverlayRowKind = "title" | "rule" | "summary" | "task" | "more" | "help";

export interface OverlayRow {
	kind: OverlayRowKind;
	text: string;
}

export type ObserverFreshness = "empty" | "live" | "stale" | "terminal";

export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	return text.split("\n").flatMap(part => wrapTextWithAnsi(part, width));
}

/** Text area of one panel row, after the horizontal inset. */
export function panelTextWidth(width: number): number {
	return Math.max(1, width - PANEL_PADDING_X * 2);
}

/** Column span of the close chip on the title row, used for both drawing and hit testing. */
export function closeMarkerColumns(width: number): { start: number; end: number } {
	const chipWidth = visibleWidth(OVERLAY_CLOSE_CHIP);
	if (width <= chipWidth) return { start: 0, end: Math.max(0, width) };
	const start = Math.max(PANEL_PADDING_X, width - chipWidth - CLOSE_CHIP_TRAILING_PAD);
	return { start, end: Math.min(width, start + chipWidth) };
}

/** Panel width that fits the widest row without exceeding the terminal. */
export function overlayPanelWidth(rows: readonly OverlayRow[], terminalColumns: number): number {
	const available = Math.max(1, terminalColumns - OVERLAY_HORIZONTAL_MARGIN * 2);
	const content = rows.reduce((max, row) => Math.max(max, visibleWidth(row.text)), 0)
		+ PANEL_PADDING_X * 2;
	const title = rows.find(row => row.kind === "title");
	const titleContent = title
		? visibleWidth(title.text) + PANEL_PADDING_X + 1 + visibleWidth(OVERLAY_CLOSE_CHIP) + CLOSE_CHIP_TRAILING_PAD
		: 0;
	const desired = Math.max(content, titleContent);
	return Math.max(Math.min(PANEL_MIN_WIDTH, available), Math.min(desired, available));
}

/** Inset one panel row and fill it to the panel width. */
export function fillPanelRow(line: string, width: number): string {
	if (width <= 0) return "";
	const body = truncateToWidth(line, Math.max(0, width - PANEL_PADDING_X));
	const padded = " ".repeat(Math.min(PANEL_PADDING_X, width)) + body;
	return padded + " ".repeat(Math.max(0, width - visibleWidth(padded)));
}

/** Inset the title row and right-align the close chip, keeping it off the panel edge. */
export function panelTitleRow(title: string, width: number): string {
	const chipWidth = visibleWidth(OVERLAY_CLOSE_CHIP);
	if (width <= 0) return "";
	if (width <= chipWidth) return truncateToWidth(OVERLAY_CLOSE_CHIP, width);
	const chipLeft = Math.max(PANEL_PADDING_X, width - chipWidth - CLOSE_CHIP_TRAILING_PAD);
	const head = truncateToWidth(title, Math.max(0, chipLeft - PANEL_PADDING_X - 1));
	const left = " ".repeat(Math.min(PANEL_PADDING_X, chipLeft)) + head;
	const row = left + " ".repeat(Math.max(0, chipLeft - visibleWidth(left))) + OVERLAY_CLOSE_CHIP;
	return row + " ".repeat(Math.max(0, width - visibleWidth(row)));
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

export function overlayRows(
	snapshot: ObserverSnapshot | undefined,
	freshness: ObserverFreshness,
	headerElapsed: number | null,
	taskElapsed: (task: ObserverTask) => number | null,
): OverlayRow[] {
	const rows: OverlayRow[] = [
		{ kind: "title", text: OVERLAY_TITLE },
		{ kind: "rule", text: "" },
	];
	if (!snapshot || freshness === "empty") {
		rows.push({ kind: "summary", text: EMPTY_OBSERVER_MESSAGE }, { kind: "help", text: OVERLAY_HELP });
		return rows;
	}
	const phase = freshness === "stale" ? "stale/unknown" : snapshot.phase;
	rows[0] = { kind: "title", text: `${OVERLAY_TITLE} · ${phase}` };
	rows.push({
		kind: "summary",
		text: `${formatCounts(snapshot, freshness)} · ${snapshot.aggregateAssistantTurns} turns · ${formatDuration(headerElapsed)}`,
	});
	for (const task of snapshot.tasks) {
		rows.push({ kind: "task", text: formatTaskLine(task, freshness, taskElapsed(task)) });
	}
	const hidden = snapshot.admittedTasks - snapshot.tasks.length;
	if (hidden > 0) rows.push({ kind: "more", text: `+${hidden} more` });
	rows.push({ kind: "help", text: OVERLAY_HELP });
	return rows;
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
