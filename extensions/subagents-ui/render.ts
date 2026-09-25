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
export const OVERLAY_CLOSE_CHIP = "[ ✕ ]";
export const OVERLAY_HORIZONTAL_MARGIN = 1;
export const PANEL_PADDING_X = 1;
/** Previous default overlay width, kept as the floor so short content does not shrink the panel. */
export const PANEL_MIN_WIDTH = 80;
/** Space kept between the close chip and the panel's right edge. */
const CLOSE_CHIP_TRAILING_PAD = 1;
/** Indent of a live task's demoted objective line, inside the glyph column. */
const LIVE_DETAIL_INDENT = 4;
/** Indent of expanded settled rows under the group row. */
const SETTLED_INDENT = 2;
/** Characters of the run id shown in the title scope label. */
const RUN_PREFIX_CHARS = 4;

export type OverlayRowKind =
	| "title" | "rule" | "counts" | "live" | "liveDetail" | "gap"
	| "group" | "settled" | "summary" | "more" | "help";

export type RowColor = "accent" | "borderMuted" | "dim" | "text";

export interface RowSegment {
	text: string;
	color?: RowColor;
}

export interface OverlayRow {
	kind: OverlayRowKind;
	text: string;
	segments?: RowSegment[];
}

export type ObserverFreshness = "empty" | "live" | "stale" | "terminal";

export interface OverlayScope {
	batch: number;
}

export interface HelpState {
	overflow: boolean;
	hasGroup: boolean;
	expanded: boolean;
}

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

function isLiveTask(task: ObserverTask): boolean {
	return task.status === "pending" || task.status === "running";
}

/** Title scope label: the panel always shows exactly one observed run, never a session total. */
export function formatTitle(snapshot: ObserverSnapshot | undefined, freshness: ObserverFreshness, scope?: OverlayScope): string {
	if (!snapshot || freshness === "empty") return OVERLAY_TITLE;
	const phase = freshness === "stale" ? "stale" : snapshot.phase;
	const batch = scope ? ` · batch ${scope.batch}` : "";
	const prefix = snapshot.runId.slice(0, RUN_PREFIX_CHARS);
	const run = snapshot.runId.length > RUN_PREFIX_CHARS ? `${prefix}…` : prefix;
	return `${OVERLAY_TITLE}${batch} · run ${run} · ${phase}`;
}

function liveStatusLabel(task: ObserverTask, freshness: ObserverFreshness): string {
	if (freshness === "stale") return "unknown";
	return task.status === "pending" ? "queued" : task.status;
}

function settledStatusLabel(task: ObserverTask): string {
	return task.status;
}

function taskGlyph(task: ObserverTask): string {
	if (isLiveTask(task)) return "●";
	if (task.status === "succeeded") return "✓";
	if (task.status === "failed") return "✗";
	return "";
}

export interface CountParts {
	liveLabel: string;
	finished: number;
	turns: number;
	elapsedText: string;
	frozen: boolean;
}

export function countParts(snapshot: ObserverSnapshot, freshness: ObserverFreshness, headerElapsed: number | null): CountParts {
	const live = snapshot.tasks.filter(isLiveTask);
	const running = live.filter(task => task.status === "running").length;
	const queued = live.length - running;
	const labels: string[] = [];
	if (freshness === "stale" && live.length > 0) labels.push(`${live.length} unknown`);
	else {
		if (running > 0) labels.push(`${running} running`);
		if (queued > 0) labels.push(`${queued} queued`);
	}
	const finished = snapshot.tasks.length - live.length;
	return {
		liveLabel: labels.join(" · "),
		finished,
		turns: snapshot.aggregateAssistantTurns,
		elapsedText: formatDuration(headerElapsed),
		frozen: freshness === "stale" || freshness === "terminal",
	};
}

export function formatCountsText(parts: CountParts): string {
	const head = parts.liveLabel ? `${parts.liveLabel} · ` : "";
	return `${head}${parts.finished} finished · ${parts.turns} turns · ${parts.elapsedText}${parts.frozen ? " frozen" : ""}`;
}

export function countsSegments(parts: CountParts): RowSegment[] {
	const rest = `${parts.finished} finished · ${parts.turns} turns · ${parts.elapsedText}${parts.frozen ? " frozen" : ""}`;
	if (!parts.liveLabel) return [{ text: rest, color: "dim" }];
	return [{ text: parts.liveLabel, color: "accent" }, { text: ` · ${rest}`, color: "dim" }];
}

export interface TaskColumns {
	role: number;
	turns: number;
	status: number;
	elapsed: number;
}

/** Shared column widths so live and settled rows scan vertically. */
export function taskColumns(tasks: readonly ObserverTask[], freshness: ObserverFreshness): TaskColumns {
	const columns: TaskColumns = { role: 0, turns: 0, status: 0, elapsed: 0 };
	for (const task of tasks) {
		columns.role = Math.max(columns.role, task.role.length);
		columns.turns = Math.max(columns.turns, `t${task.assistantTurns}`.length);
		columns.status = Math.max(columns.status, (isLiveTask(task) ? liveStatusLabel(task, freshness) : settledStatusLabel(task)).length);
		columns.elapsed = Math.max(columns.elapsed, visibleWidth(formatDuration(task.elapsedMs)));
	}
	return columns;
}

export function formatLiveRow(task: ObserverTask, freshness: ObserverFreshness, columns: TaskColumns): OverlayRow {
	const status = liveStatusLabel(task, freshness);
	const tools = task.activeTools.join(",");
	const head = `${task.role.padEnd(columns.role)} t${String(task.assistantTurns).padEnd(columns.turns)} `;
	const elapsed = formatDuration(task.elapsedMs).padStart(columns.elapsed);
	const segments: RowSegment[] = [
		{ text: `${taskGlyph(task)} `, color: "accent" },
		{ text: head, color: "text" },
		{ text: status.padEnd(columns.status), color: "accent" },
		{ text: ` ${elapsed}`, color: "text" },
	];
	let text = `${taskGlyph(task)} ${head}${status.padEnd(columns.status)} ${elapsed}`;
	if (tools) {
		segments.push({ text: `  ${tools}`, color: "dim" });
		text += `  ${tools}`;
	}
	return { kind: "live", text, segments };
}

export function formatLiveDetail(task: ObserverTask): OverlayRow | undefined {
	if (!task.headline) return undefined;
	return { kind: "liveDetail", text: " ".repeat(LIVE_DETAIL_INDENT) + task.headline, segments: [{ text: " ".repeat(LIVE_DETAIL_INDENT) + task.headline, color: "dim" }] };
}

export interface SettledSummary {
	count: number;
	rangeText: string;
	turns: number;
}

export function settledSummary(tasks: readonly ObserverTask[]): SettledSummary {
	const settled = tasks.filter(task => !isLiveTask(task));
	const elapsed = settled.map(task => task.elapsedMs).filter((value): value is number => value !== null);
	const rangeText = elapsed.length === 0
		? "unknown"
		: elapsed.length === 1
			? formatDuration(elapsed[0] ?? null)
			: `${formatDuration(Math.min(...elapsed))} – ${formatDuration(Math.max(...elapsed))}`;
	return { count: settled.length, rangeText, turns: settled.reduce((sum, task) => sum + task.assistantTurns, 0) };
}

export function formatGroupRow(summary: SettledSummary, expanded: boolean): string {
	return `${expanded ? "▾" : "▸"} ${summary.count} finished · ${summary.rangeText} · ${summary.turns} turns`;
}

/** Inline right-side hint on the group row; only advertises keys that act right now. */
export function formatGroupHint(expanded: boolean, arrow: "down" | "up" | undefined): string {
	if (!expanded) return arrow === "down" ? "enter/↓ expand" : "enter expand";
	return arrow === "up" ? "enter/↑ collapse" : "enter collapse";
}

export function formatSettledRow(task: ObserverTask, columns: TaskColumns): OverlayRow {
	const head = `${task.role.padEnd(columns.role)} t${String(task.assistantTurns).padEnd(columns.turns)} `;
	const status = settledStatusLabel(task).padEnd(columns.status);
	const elapsed = formatDuration(task.elapsedMs).padStart(columns.elapsed);
	const text = `${" ".repeat(SETTLED_INDENT)}${taskGlyph(task)} ${head}${status} ${elapsed}  ${formatRoute(task)}`;
	return { kind: "settled", text, segments: [{ text, color: "dim" }] };
}

/** Help row lists only keys that currently do something. */
export function helpText(state: HelpState): string {
	const parts: string[] = [];
	if (state.overflow) parts.push("↑↓ scroll");
	if (state.hasGroup) parts.push(state.expanded ? "enter collapse" : "enter expand");
	parts.push("ctrl+alt+f close");
	return parts.join(" · ");
}

export function overlayRows(
	snapshot: ObserverSnapshot | undefined,
	freshness: ObserverFreshness,
	headerElapsed: number | null,
	taskElapsed: (task: ObserverTask) => number | null,
	scope?: OverlayScope,
): OverlayRow[] {
	const rows: OverlayRow[] = [
		{ kind: "title", text: formatTitle(snapshot, freshness, scope) },
		{ kind: "rule", text: "" },
	];
	if (!snapshot || freshness === "empty") {
		rows.push({ kind: "summary", text: EMPTY_OBSERVER_MESSAGE, segments: [{ text: EMPTY_OBSERVER_MESSAGE, color: "dim" }] });
		return rows;
	}
	const parts = countParts(snapshot, freshness, headerElapsed);
	rows.push({ kind: "counts", text: formatCountsText(parts), segments: countsSegments(parts) });
	rows.push({ kind: "rule", text: "" });
	const withElapsed = snapshot.tasks.map(task => ({ task, elapsed: taskElapsed(task) }));
	const columns = taskColumns(snapshot.tasks, freshness);
	const live = withElapsed.filter(entry => isLiveTask(entry.task));
	const settled = withElapsed.filter(entry => !isLiveTask(entry.task));
	for (const entry of live) {
		rows.push(formatLiveRow({ ...entry.task, elapsedMs: entry.elapsed }, freshness, columns));
		const detail = formatLiveDetail(entry.task);
		if (detail) rows.push(detail);
	}
	if (settled.length > 0) {
		if (live.length > 0) rows.push({ kind: "gap", text: "" });
		const groupText = formatGroupRow(settledSummary(snapshot.tasks), false);
		rows.push({ kind: "group", text: groupText, segments: [{ text: groupText, color: "dim" }] });
	}
	return rows;
}

/** Expanded settled rows for the component once the group is open. */
export function settledRows(
	snapshot: ObserverSnapshot,
	taskElapsed: (task: ObserverTask) => number | null,
	columns: TaskColumns,
): OverlayRow[] {
	return snapshot.tasks
		.filter(task => !isLiveTask(task))
		.map(task => formatSettledRow({ ...task, elapsedMs: taskElapsed(task) }, columns));
}

export function formatStatus(snapshot: ObserverSnapshot): string {
	const parts = countParts(snapshot, "live", snapshot.elapsedMs);
	const live = parts.liveLabel ? `●${parts.liveLabel} · ` : "";
	return `SA ${live}${parts.finished} finished · ${parts.elapsedText}`;
}

export function formatPanel(snapshot: ObserverSnapshot): string[] {
	const parts = countParts(snapshot, "live", snapshot.elapsedMs);
	const lines = [formatCountsText(parts)];
	const columns = taskColumns(snapshot.tasks, "live");
	for (const task of snapshot.tasks.filter(isLiveTask)) {
		lines.push(formatLiveRow(task, "live", columns).text);
		const detail = formatLiveDetail(task);
		if (detail) lines.push(detail.text);
	}
	const summary = settledSummary(snapshot.tasks);
	if (summary.count > 0) lines.push(formatGroupRow(summary, false));
	return lines;
}
