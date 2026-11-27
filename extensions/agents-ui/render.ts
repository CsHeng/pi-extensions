import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ObserverSnapshot, ObserverTask, ObserverToolCall } from "../agents/observer-events.ts";
import type { SessionViewHistoryRow, SessionViewReply } from "../agents/session-view.ts";
import type { RecordedUsageProjection } from "../agents/observability.ts";
import { panelHeading, panelTheme, type PanelHeadingContent, type PanelTone } from "../shared/panel-heading.ts";
import { formatPanelDuration as formatDuration } from "../shared/panel-rows.ts";
import { formatUsageLane } from "../shared/usage-metrics.ts";
import { inspectionFrame, type InspectionFrame, type InspectionItem } from "../shared/inspection-rows.ts";

export const AGENTS_UI_STATUS_KEY = "agents.status";
export const AGENTS_UI_PANEL_KEY = "agents.panel";
export const AGENTS_UI_COMMAND = "agents-ui";
export const OBSERVER_STALE_MS = 3 * 5_000;
export const EMPTY_OBSERVER_MESSAGE = "No observed Agent work.";
export const OVERLAY_HORIZONTAL_MARGIN = 1;
export const PANEL_FRAME = 1;
const PANEL_PADDING_X = 1;
const OVERLAY_CLOSE_CHIP = "×";

export interface OverlayRow {
	kind: "title" | "rule" | "counts" | "liveHeader" | "live" | "group" | "settled" | "summary" | "more" | "help";
	text: string;
	item?: InspectionItem;
}

export function panelTextWidth(width: number): number { return Math.max(1, width - PANEL_PADDING_X * 2); }

export function closeMarkerColumns(width: number): { start: number; end: number } {
	if (width <= 1) return { start: 0, end: Math.max(0, width) };
	const start = Math.max(PANEL_PADDING_X, width - 2);
	return { start, end: Math.min(width, start + 1) };
}

export function overlayPanelWidth(rows: readonly OverlayRow[], terminalColumns: number): number {
	const available = Math.max(1, terminalColumns - OVERLAY_HORIZONTAL_MARGIN * 2);
	const content = rows.reduce((max, row) => Math.max(max, visibleWidth(row.text) + (row.kind === "title" || row.item ? 2 : 0)), 0);
	return Math.min(available, Math.max(80, content + 2 * (PANEL_PADDING_X + PANEL_FRAME)));
}

export function fillPanelRow(line: string, width: number): string {
	if (width <= 0) return "";
	const padded = " ".repeat(Math.min(PANEL_PADDING_X, width)) + truncateToWidth(line, Math.max(0, width - PANEL_PADDING_X));
	return padded + " ".repeat(Math.max(0, width - visibleWidth(padded)));
}

export function panelTitleRow(title: string, width: number): string {
	if (width <= 1) return width > 0 ? OVERLAY_CLOSE_CHIP : "";
	const { start } = closeMarkerColumns(width);
	const left = " ".repeat(PANEL_PADDING_X) + truncateToWidth(title, Math.max(0, start - PANEL_PADDING_X - 1));
	return left + " ".repeat(Math.max(0, start - visibleWidth(left))) + OVERLAY_CLOSE_CHIP + " ".repeat(width - start - 1);
}

export const isLiveTask = (task: ObserverTask): boolean => task.status === "pending" || task.status === "running";

/** Only a fresh running child has an advancing clock. Stale rows keep the last measured duration. */
export function observationAt(snapshot: ObserverSnapshot | undefined, receivedAt: number, now: number, staleMs = OBSERVER_STALE_MS) {
	const age = Math.max(0, now - receivedAt);
	const stale = snapshot !== undefined && snapshot.phase !== "settled" && age >= staleMs;
	const tasks = snapshot?.tasks.map(task => !stale && snapshot.phase !== "settled" && task.status === "running" && task.executionPhase === "child-execution" && task.elapsedMs !== null
		? { ...task, elapsedMs: task.elapsedMs + age } : task) ?? [];
	return { tasks, stale };
}

export function agentItemKey(handle: string, episode: number | null): string { return JSON.stringify([handle, episode]); }

export function shortLabel(handle: string, others: readonly string[] = []): string {
	const bare = (id: string) => id.startsWith("session_") ? id.slice(8) : id;
	for (const length of [8, 12, 36]) {
		const prefix = bare(handle).slice(0, length);
		if (!others.some(other => other !== handle && bare(other).slice(0, length) === prefix)) return prefix;
	}
	return handle;
}

const displayText = (text: string) => text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, " ");
const roleTitle = (role: string, label?: string) => `${role[0]!.toUpperCase()}${role.slice(1)}: ${label ? displayText(label) : "untitled task"}`;
const routeText = (route: ObserverTask["route"] | undefined, full = false) => route
	? `${full ? `${route.provider} ` : ""}${route.model} ${route.thinking}` : full ? "route unavailable" : "—";

function callText(call: ObserverToolCall): string {
	return `${call.tool} ${call.id}${call.parentId ? ` parent ${call.parentId}` : ""} ${call.status}${call.summary ? ` ${call.summary}` : ""}`;
}

/** Only started, still-running calls describe current work. Tails, proposed and completed calls are detail. */
function currentAction(task: ObserverTask): string {
	if (task.status !== "running") return task.status === "pending" ? "queued" : task.status;
	if (task.executionPhase === "workspace-preparation") return "preparing workspace";
	if (task.executionPhase === "convergence-critical") return "finalizing";
	const active = task.calls.filter(call => call.status === "running" && call.startedMs !== null);
	const call = active.at(-1);
	if (call) return `${call.tool}${call.summary ? ` · ${call.summary}` : ""}${active.length > 1 ? ` (+${active.length - 1})` : ""}`;
	return task.responding ? "generating reply" : "running";
}

function stateGlyph(state: string): Pick<InspectionItem, "glyph" | "tone"> {
	switch (state) {
		case "running": return { glyph: "◐", tone: "accent" };
		case "pending": return { glyph: "○", tone: "dim" };
		case "succeeded": return { glyph: "✓", tone: "success" };
		case "failed": return { glyph: "✗", tone: "error" };
		case "blocked": return { glyph: "!", tone: "warning" };
		case "interrupted": case "aborted": return { glyph: "⊘", tone: "warning" };
		default: return { glyph: "?", tone: "warning" };
	}
}

export function formatAgentUsage(usage: RecordedUsageProjection | null | undefined): string {
	if (!usage || usage.status === "unavailable") return "usage unavailable";
	const text = formatUsageLane({ input: usage.usage.input ?? 0, output: usage.usage.output ?? 0, cacheRead: usage.usage.cacheRead ?? 0,
		cacheWrite: usage.usage.cacheWrite ?? 0, cost: usage.usage.cost ?? 0, ...usage.lane }) || "no usage";
	return text + (usage.status === "incomplete" ? " (partial)" : "");
}

function rowAgentUsage(usage: RecordedUsageProjection | null | undefined): string | undefined {
	if (!usage || usage.status === "unavailable") return undefined;
	const text = formatAgentUsage(usage);
	return text === "no usage" || text === "usage unavailable" ? undefined : text;
}

function observedItem(task: ObserverTask, name: string, stale: boolean): InspectionItem {
	const lost = stale && isLiveTask(task);
	const usageText = formatUsageLane(task.usage);
	return { key: agentItemKey(task.id, task.episode), ...stateGlyph(lost ? "unknown" : task.status), name,
		activity: lost ? "observation stale" : currentAction(task), meta: routeText(task.route),
		...(usageText ? { usage: usageText } : {}), tail: task.elapsedMs === null ? "" : formatDuration(task.elapsedMs),
		detail: () => lost ? [`Agent ${task.id} ep${task.episode ?? "?"}`, "Live observation stale · record unavailable",
			`Route: ${routeText(task.route, true)}`, `Usage: ${usageText || "unavailable"} · turns: ${task.assistantTurns}`]
			: [`Agent ${task.id} ep${task.episode ?? "?"}`, `${name} · ${currentAction(task)} · ${formatDuration(task.elapsedMs)}`,
			`Assignment: ${displayText(task.headline) || "unavailable"}`, `Route: ${routeText(task.route, true)}`,
			`Usage: ${usageText || "unavailable"} · turns: ${task.assistantTurns}`, ...task.calls.flatMap(call => [callText(call),
				`Timing: started ${call.startedMs ?? "?"} · updated ${call.updatedMs ?? "?"} · output ${call.outputMs ?? "?"} · deadline ${call.deadlineMs ?? "?"}`,
				...(call.tail ? [`Output tail${call.truncated ? " (truncated)" : ""}: ${call.tail}`] : [])]),
			...(task.callsTruncated ? ["Additional calls omitted"] : [])] };
}

const unconfirmedState = (row: SessionViewHistoryRow) => row.state === "running" || row.state === "queued";

function historyItem(row: SessionViewHistoryRow, name: string): InspectionItem {
	const unconfirmed = unconfirmedState(row);
	const outcome = unconfirmed ? "unconfirmed" : row.latestOutcome === "unknown" && row.state === "interrupted" ? "interrupted" : row.latestOutcome;
	const tail = [!row.onCurrentBranch && "off-branch", row.legacy && "legacy", row.elapsedMs !== undefined && formatDuration(row.elapsedMs)].filter(Boolean).join(" · ");
	const rowUsage = rowAgentUsage(row.recordedUsage);
	const turnsSuffix = row.recordedUsage?.assistantTurns != null ? ` · turns: ${row.recordedUsage.assistantTurns}` : "";
	return { key: agentItemKey(row.handle, row.episode), ...stateGlyph(outcome), name, activity: outcome, meta: routeText(row.route),
		...(rowUsage ? { usage: rowUsage } : {}), tail,
		detail: () => [`Agent ${row.handle} ep${row.episode}`, name, `State: ${row.state}${unconfirmed ? "?" : ""} · outcome: ${row.latestOutcome}${!row.onCurrentBranch ? " · off-branch" : ""}${row.legacy ? " · legacy" : ""}`,
			`Elapsed: ${formatDuration(row.elapsedMs ?? null)}`, `Route: ${routeText(row.route, true)}`, `Usage: ${formatAgentUsage(row.recordedUsage)} (agent history)${turnsSuffix}`,
			...(unconfirmed && row.onCurrentBranch ? ["Activity unconfirmed. Ask the main agent to reconcile this handle and episode."] : []),
			`Accepted episodes: ${row.acceptedEpisodes ?? "unknown"} · report ${row.reportComplete ? "complete" : "incomplete"} · retained ${row.retained ? "yes" : "no"}`,
			`Candidate roots: ${row.roots?.length ?? "unavailable"}`, ...(row.roots ?? []).map(root => `${root.id.slice(0, 8)} ${root.status}${root.recovery === "required" ? "!" : ""}/${root.release} ${root.destination}`),
			...(row.release ? [`cleanup=${row.release.status}${row.release.remaining ? ` remaining=${row.release.remaining}` : ""}`] : [])] };
}

export function agentListSections(tasks: readonly ObserverTask[], history: readonly SessionViewHistoryRow[], stale = false) {
	const observed = tasks.filter(task => !history.some(row => row.handle === task.id && (task.episode === null || row.episode > task.episode
		|| (row.episode === task.episode && !unconfirmedState(row) && (stale || !isLiveTask(task))))));
	const retained = history.filter(row => !observed.some(task => task.id === row.handle)).map(row => {
		const last = tasks.find(task => task.id === row.handle && task.episode === row.episode);
		if (!last || last.status === "running" || last.status === "pending") return row;
		// A terminal observer can fill a gap in this exact episode, never a different episode's duration or result.
		return { ...row, ...(!row.label && last.label ? { label: last.label } : {}), route: row.route ?? last.route,
			...(row.elapsedMs === undefined && last.elapsedMs !== null ? { elapsedMs: last.elapsedMs } : {}),
			latestOutcome: row.latestOutcome === "unknown" ? last.status : row.latestOutcome };
	});
	const titles = new Map<string, string[]>();
	for (const agent of [...observed, ...retained]) {
		const title = roleTitle(agent.role, agent.label);
		const group = titles.get(title) ?? [];
		group.push("handle" in agent ? agent.handle : agent.id);
		titles.set(title, group);
	}
	const distinguish = (item: InspectionItem, handle: string) => {
		const group = titles.get(item.name)!;
		const compactName = item.name.replace(/^(Worker|Explorer|Reviewer): /, (_, role: string) => role[0] + ": ");
		return { ...item, compactName, ...(group.length > 1 ? { nameSuffix: `[${shortLabel(handle, group)}]` } : {}) };
	};
	const fromTask = (task: ObserverTask) => distinguish(observedItem(task, roleTitle(task.role, task.label), stale), task.id);
	return { live: observed.filter(isLiveTask).map(fromTask), finished: observed.filter(task => !isLiveTask(task)).map(fromTask),
		retained: retained.map(row => distinguish(historyItem(row, roleTitle(row.role, row.label)), row.handle)) };
}

export interface AgentsSummaryCounts { running: number | "unknown"; queued: number; agents: number | "unknown" }
export interface AgentsInlineModel {
	counts: AgentsSummaryCounts;
	tasks?: readonly ObserverTask[];
	history?: readonly SessionViewHistoryRow[];
	historyTotal?: number;
	stale?: boolean;
}

function summaryHeading(counts: AgentsSummaryCounts): PanelHeadingContent {
	const alerts: string[] = [], focus: string[] = [];
	if (counts.running === "unknown") alerts.push("running unknown");
	else if (counts.running > 0) focus.push(`${counts.running} running`);
	if (counts.queued > 0) focus.push(`${counts.queued} queued`);
	if (counts.agents === "unknown") alerts.push("agents unknown");
	const done = typeof counts.agents !== "number" ? undefined : `${typeof counts.running === "number" ? Math.max(0, counts.agents - counts.running - counts.queued) : "?"}/${counts.agents} done`;
	return { title: "Agents", ...(done ? { progress: done } : {}), focus, alerts };
}

export function agentsInlineBudget(terminalRows: number): number {
	return Math.max(1, Math.min(6, Math.floor((Number.isFinite(terminalRows) ? terminalRows : 36) / 4)));
}

export function agentInspectionItems(model: AgentsInlineModel): InspectionItem[] {
	const taskRank = (t: ObserverTask) => t.status === "running" ? 0 : t.status === "pending" ? 1 : t.status === "succeeded" ? 3 : 2;
	const historyRank = (r: SessionViewHistoryRow) => r.state === "interrupted" ? 0 : r.state === "running" || r.state === "queued" ? 1 : r.state === "idle" ? 2 : 3;
	const items = agentListSections([...(model.tasks ?? [])].sort((a, b) => taskRank(a) - taskRank(b)),
		[...(model.history ?? [])].sort((a, b) => historyRank(a) - historyRank(b)), model.stale);
	return [...items.live, ...items.finished, ...items.retained];
}

export function formatAgentsInspection(model: AgentsInlineModel, width: number, maxRows: number, theme: unknown, selected?: string): InspectionFrame {
	const colors = panelTheme(theme) ?? { fg: (_color: PanelTone, text: string) => text };
	const heading = panelHeading(summaryHeading(model.counts), width, { folded: false, theme: colors });
	const hidden = Math.max(0, (model.historyTotal ?? 0) - (model.history?.length ?? 0));
	return inspectionFrame(heading, agentInspectionItems(model), width, maxRows, colors, { ...(selected === undefined ? {} : { selected }), hidden, hint: `/${AGENTS_UI_COMMAND} list` });
}

export function formatAgentsInline(model: AgentsInlineModel, width: number, maxRows = 1, options: { folded?: boolean; theme?: unknown } = {}): string[] {
	if (!Number.isFinite(width) || width < 1 || !Number.isFinite(maxRows) || maxRows < 1) return [];
	const folded = options.folded !== false;
	if (folded || maxRows < 2) return [panelHeading(summaryHeading(model.counts), width, { folded, theme: panelTheme(options.theme) })];
	return formatAgentsInspection(model, width, maxRows, options.theme).lines;
}

export function agentsSummaryHasState(counts: AgentsSummaryCounts): boolean {
	return (typeof counts.running === "number" && counts.running > 0) || counts.queued > 0 || (typeof counts.agents === "number" && counts.agents > 0);
}

export function formatSessionTitle(sessionId: string | undefined): string {
	return sessionId ? `Agents · session ${sessionId.slice(0, 6)}${sessionId.length > 6 ? "…" : ""}` : "Agents · session";
}

export function formatHistoryNav(history: SessionViewReply["history"]): OverlayRow {
	const from = history.totalRows === 0 ? 0 : history.page * history.pageSize + 1;
	const to = Math.min(history.totalRows, (history.page + 1) * history.pageSize);
	return { kind: "group", text: `history ${from}–${to} of ${history.totalRows} · page ${history.page + 1}/${Math.max(1, history.totalPages)} · pgup/pgdn` };
}

export function formatHistoryCollapsed(session: { kind: string; reply?: SessionViewReply; reason?: string }): string {
	if (session.kind === "loading") return session.reply ? "▸ history refreshing · H" : "▸ history loading · H";
	if (session.kind === "unavailable") return `▸ ⚠ history unavailable${session.reason ? ` (${session.reason})` : ""}${session.reply?.history.state === "ready" ? " · cached" : ""} · H retry`;
	const n = session.reply?.history.totalRows ?? 0;
	return `▸ ${n} retained agent${n === 1 ? "" : "s"} · H`;
}

export function sessionHelpText(state: { historyOpen: boolean; liveOverflow?: boolean; historyOverflow?: boolean }): string {
	return `${state.historyOpen ? "H hide PgUp/PgDn" : "H history"} ↑↓ select Enter detail Esc`;
}
