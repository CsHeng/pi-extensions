import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration } from "../subagents/render.ts";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";
import type { SessionViewHistoryRow, SessionViewReply } from "../subagents/session-view.ts";
import type { RecordedUsageProjection } from "../subagents/observability.ts";

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

export type OverlayRowKind =
	| "title" | "rule" | "counts" | "liveHeader" | "live" | "gap"
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

function liveStatusLabel(task: ObserverTask, freshness: ObserverFreshness): string {
	if (freshness === "stale") return "unknown";
	return task.status === "pending" ? "queued" : task.status;
}

function liveStatusColor(task: ObserverTask, freshness: ObserverFreshness): RowColor {
	if (freshness === "stale") return "borderMuted";
	return task.status === "pending" ? "dim" : "accent";
}

function historyLabelWarning(label: string): boolean {
	return label.startsWith("history unavailable") || label === "history partial";
}

const DETAIL_INVISIBLE = /[\u200B-\u200D\uFEFF\u00AD]/g;

/** Headlines may carry zero-width separators; show real word spaces in the detail row. */
export function displayDetailText(text: string): string {
	return text.replace(DETAIL_INVISIBLE, " ");
}

function liveSecondaryLine(task: ObserverTask): string | undefined {
	const parts: string[] = [];
	if (task.headline) parts.push(displayDetailText(task.headline));
	if (task.activeTools.length > 0) parts.push(task.activeTools.join(", "));
	if (parts.length === 0) return undefined;
	return "\n" + " ".repeat(LIVE_DETAIL_INDENT) + parts.join(" · ");
}

/** Wrap a live row; detail continuations keep the hang-indent after word wrap. */
export function wrapLiveRowText(text: string, width: number): string[] {
	const newline = text.indexOf("\n");
	if (newline < 0) return wrapText(text, width);
	const lines = wrapText(text.slice(0, newline), width);
	const detailLines = wrapText(text.slice(newline + 1), width);
	const indent = " ".repeat(LIVE_DETAIL_INDENT);
	for (let index = 0; index < detailLines.length; index++) {
		const line = detailLines[index]!;
		if (index === 0) lines.push(line);
		else lines.push(line.startsWith(indent) ? line : indent + line.replace(/^\s+/, ""));
	}
	return lines;
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

export function formatLiveRow(task: ObserverTask, freshness: ObserverFreshness, columns: TaskColumns, label?: string): OverlayRow {
	const status = liveStatusLabel(task, freshness);
	const statusColor = liveStatusColor(task, freshness);
	const head = `${label ? `${label} ep${task.episode} ` : ""}${task.role.padEnd(columns.role)} t${String(task.assistantTurns).padEnd(columns.turns)} `;
	const elapsed = formatDuration(task.elapsedMs).padStart(columns.elapsed);
	const primary = `${taskGlyph(task)} ${head}${status.padEnd(columns.status)} ${elapsed}`;
	const secondary = liveSecondaryLine(task);
	const segments: RowSegment[] = [
		{ text: `${taskGlyph(task)} `, color: "accent" },
		{ text: head, color: "text" },
		{ text: status.padEnd(columns.status), color: statusColor },
		{ text: ` ${elapsed}`, color: "text" },
	];
	if (secondary) segments.push({ text: secondary, color: "dim" });
	return { kind: "live", text: primary + (secondary ?? ""), segments };
}

/** Section label for the pinned live block; mirrors the history nav row. */
export function formatRunningNav(agentCount: number): OverlayRow {
	const suffix = ` · ${agentCount} agent${agentCount === 1 ? "" : "s"}`;
	const text = `running${suffix}`;
	return {
		kind: "liveHeader",
		text,
		segments: [{ text: "running", color: "accent" }, { text: suffix, color: "dim" }],
	};
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
	}
	const summary = settledSummary(snapshot.tasks);
	if (summary.count > 0) lines.push(formatGroupRow(summary, false));
	return lines;
}

// ── Session-scoped overlay formatters (session-view contract consumer) ──────────────────

/** Characters of the host session id shown in the session-scoped title. */
export const SESSION_SCOPE_CHARS = 6;

/** Session-scoped title; never a batch number or a run prefix. */
export function formatSessionTitle(sessionId: string | undefined): string {
	if (!sessionId) return `${OVERLAY_TITLE} · session`;
	const prefix = sessionId.slice(0, SESSION_SCOPE_CHARS);
	return `${OVERLAY_TITLE} · session ${prefix}${sessionId.length > SESSION_SCOPE_CHARS ? "…" : ""}`;
}

export function compactCount(value: number | null): string {
	if (value === null) return "?";
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function compactCost(value: number | null): string {
	if (value === null) return "?";
	if (value < 100) return value.toFixed(2);
	return compactCount(value);
}

function usageCoverageTag(usage: RecordedUsageProjection): string {
	return usage.status === "complete" ? "" : usage.status === "incomplete" ? "partial" : "unknown";
}

/** Cumulative recorded usage line; live current-episode turns stay on the live rows. */
export function formatSessionUsage(usage: RecordedUsageProjection | null): OverlayRow | undefined {
	if (!usage) return undefined;
	const turns = usage.assistantTurns === null ? "?" : String(usage.assistantTurns);
	const text = `recorded Σ${turns} turns · ↑${compactCount(usage.usage.input)} ↓${compactCount(usage.usage.output)} · $${compactCost(usage.usage.cost)}`
		+ (usageCoverageTag(usage) ? ` (${usageCoverageTag(usage)})` : "");
	return { kind: "summary", text, segments: [{ text, color: "dim" }] };
}

export interface SessionCounts {
	live: number;
	liveTurns: number;
	known: boolean;
	agents: string;
	episodes: string;
	idle: string;
	interrupted: string;
	closed: string;
	historyLabel: string;
	limitedLive: boolean;
}

export function sessionCounts(
	snapshot: ObserverSnapshot | undefined,
	reply: SessionViewReply | undefined,
	historyState: string,
	reason: string | undefined,
	refreshing: boolean,
): SessionCounts {
	const live = snapshot?.tasks.filter(isLiveTask) ?? [];
	const summary = reply?.summary;
	const states = summary?.states;
	let historyLabel = "";
	if (historyState === "loading") historyLabel = refreshing ? "history refreshing" : "history loading";
	else if (historyState === "unavailable") historyLabel = `history unavailable${reason ? ` (${reason})` : ""}${reply?.history.state === "ready" ? " · cached" : ""}`;
	else if (reply && !reply.inventory.complete) historyLabel = "history partial";
	return {
		live: live.length,
		liveTurns: live.reduce((sum, task) => sum + task.assistantTurns, 0),
		known: summary !== undefined && summary !== null,
		agents: summary ? String(summary.agents) : "?",
		episodes: !summary ? "?" : summary.acceptedEpisodes === null ? "?" : String(summary.acceptedEpisodes),
		idle: states ? String(states.idle) : "?",
		interrupted: states ? String(states.interrupted) : "?",
		closed: states ? String(states.closed) : "?",
		historyLabel,
		limitedLive: snapshot !== undefined && (reply === undefined || snapshot.version !== 3),
	};
}

/** Session summary as stacked rows so live count stays visually primary. */
export function formatSessionCountRows(counts: SessionCounts): OverlayRow[] {
	const head = counts.live > 0 ? `${counts.live} live (t${counts.liveTurns})` : "0 live";
	const body = `${counts.agents} agents · ${counts.episodes} episodes · ${counts.idle} idle · ${counts.interrupted} int · ${counts.closed} closed`;
	const rows: OverlayRow[] = [
		{ kind: "counts", text: head, segments: [{ text: head, color: "accent" }] },
		{ kind: "counts", text: body, segments: [{ text: body, color: "dim" }] },
	];
	const meta: string[] = [];
	if (counts.historyLabel) {
		const warning = historyLabelWarning(counts.historyLabel);
		meta.push(warning ? `⚠ ${counts.historyLabel}` : counts.historyLabel);
	}
	if (counts.limitedLive) meta.push("limited live observation");
	if (meta.length > 0) {
		const text = meta.join(" · ");
		const warning = meta.some(part => part.startsWith("⚠"));
		rows.push({ kind: "counts", text, segments: [{ text, color: warning ? "borderMuted" : "dim" }] });
	}
	return rows;
}

/** Flattened counts line for width estimation and legacy callers. */
export function formatSessionCounts(counts: SessionCounts): OverlayRow {
	const rows = formatSessionCountRows(counts);
	const text = rows.map(row => row.text).join(" · ");
	return { kind: "counts", text, segments: rows.flatMap(row => row.segments ?? [{ text: row.text }]) };
}

/** Stable short agent label with collision disambiguation across the visible set. */
export function shortLabel(handle: string, others: readonly string[] = []): string {
	const uuid = handle.startsWith("session_") ? handle.slice("session_".length) : handle;
	for (const length of [8, 12, 36]) {
		const candidate = uuid.slice(0, length);
		if (!others.some(other => other !== handle && shortLabelBase(other, length) === candidate)) return candidate;
	}
	return handle;
}
function shortLabelBase(handle: string, length: number): string {
	const uuid = handle.startsWith("session_") ? handle.slice("session_".length) : handle;
	return uuid.slice(0, length);
}

export interface HistoryColumns { label: number; role: number; episode: number; state: number; outcome: number; }

export function historyColumns(rows: readonly SessionViewHistoryRow[], labels: ReadonlyMap<string, string>): HistoryColumns {
	const columns: HistoryColumns = { label: 0, role: 0, episode: 0, state: 0, outcome: 0 };
	for (const row of rows) {
		columns.label = Math.max(columns.label, (labels.get(row.handle) ?? row.handle).length);
		columns.role = Math.max(columns.role, row.role.length);
		columns.episode = Math.max(columns.episode, `ep${row.episode}`.length);
		columns.state = Math.max(columns.state, historyStateLabel(row).length);
		columns.outcome = Math.max(columns.outcome, row.latestOutcome.length);
	}
	return columns;
}

/** Durable managed state; running/queued in history is unconfirmed without fresh live evidence. */
function historyStateLabel(row: SessionViewHistoryRow): string {
	return row.state === "running" || row.state === "queued" ? `${row.state}?` : row.state;
}

function historyGlyph(row: SessionViewHistoryRow): string {
	if (row.state === "running" || row.state === "queued") return "?";
	if (row.state === "closed") return "■";
	if (row.latestOutcome === "succeeded") return "✓";
	if (row.latestOutcome === "failed") return "✗";
	if (row.latestOutcome === "aborted") return "⊘";
	return "·";
}

export function formatHistoryRow(row: SessionViewHistoryRow, label: string, columns: HistoryColumns): OverlayRow {
	const badges = [row.onCurrentBranch ? "" : "off-branch", row.legacy ? "legacy" : ""].filter(Boolean).join(" ");
	const turns = row.recordedUsage.assistantTurns === null ? "?" : String(row.recordedUsage.assistantTurns);
	const coverage = usageCoverageTag(row.recordedUsage);
	const usage = `Σ${turns}t ↑${compactCount(row.recordedUsage.usage.input)} $${compactCost(row.recordedUsage.usage.cost)}${coverage ? `·${coverage}` : ""}`;
	const primary = `${historyGlyph(row)} ${label.padEnd(columns.label)} ${row.role.padEnd(columns.role)} ${`ep${row.episode}`.padEnd(columns.episode)} ${historyStateLabel(row).padEnd(columns.state)} ${row.latestOutcome.padEnd(columns.outcome)}`;
	const route = row.route ? `\n  ${row.route.provider} ${row.route.model} thinking:${row.route.thinking}` : "";
	const text = `${primary} ${usage}` + (badges ? `  ${badges}` : "") + route;
	const segments: RowSegment[] = [
		{ text: `${historyGlyph(row)} `, color: "text" },
		{ text: `${label.padEnd(columns.label)} ${row.role.padEnd(columns.role)} ${`ep${row.episode}`.padEnd(columns.episode)} `, color: "text" },
		{ text: historyStateLabel(row).padEnd(columns.state), color: "text" },
		{ text: ` ${row.latestOutcome.padEnd(columns.outcome)} `, color: "text" },
		{ text: usage + (badges ? `  ${badges}` : ""), color: "dim" },
	];
	if (route) segments.push({ text: route, color: "dim" });
	return { kind: "settled", text, segments };
}

/** Honest visible range and page indicator for the expanded history section. */
export function formatHistoryNav(history: SessionViewReply["history"]): OverlayRow {
	const from = history.totalRows === 0 ? 0 : history.page * history.pageSize + 1;
	const to = Math.min(history.totalRows, (history.page + 1) * history.pageSize);
	const suffix = ` ${from}–${to} of ${history.totalRows} · page ${history.page + 1}/${Math.max(1, history.totalPages)} · pgup/pgdn`;
	const text = `history${suffix}`;
	return { kind: "group", text, segments: [{ text: "history", color: "accent" }, { text: suffix, color: "dim" }] };
}

export function formatHistoryCollapsed(session: { kind: string; reply?: SessionViewReply; reason?: string }): string {
	if (session.kind === "loading") return session.reply ? "▸ history refreshing · enter" : "▸ history loading · enter";
	if (session.kind === "unavailable") return `▸ ⚠ history unavailable${session.reason ? ` (${session.reason})` : ""}${session.reply?.history.state === "ready" ? " · cached" : ""} · enter retry`;
	const count = session.reply?.history.totalRows ?? 0;
	return `▸ ${count} retained agents · enter`;
}

export interface SessionHelpState {
	liveOverflow: boolean;
	historyOpen: boolean;
	historyOverflow: boolean;
}

export function sessionHelpText(state: SessionHelpState): string {
	const parts: string[] = [];
	if (state.liveOverflow) parts.push("↑↓ live");
	if (state.historyOverflow) parts.push("↑↓ rows");
	parts.push(state.historyOpen ? "enter collapse" : "enter history");
	if (state.historyOpen) parts.push("pgup/pgdn page");
	parts.push("ctrl+alt+f close");
	return parts.join(" · ");
}
