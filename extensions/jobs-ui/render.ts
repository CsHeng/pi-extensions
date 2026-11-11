/** Read-only Jobs presentation on the shared panel heading and row grammar. */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { panelHeading, type PanelTheme, type PanelTone } from "../shared/panel-heading.ts";
import { formatPanelDuration, panelRows, type PanelRowSpec } from "../shared/panel-rows.ts";
import type { JobsViewRecord } from "../async-bash/jobs-view.ts";

export interface JobsUiTheme { fg: (color: string, text: string) => string }
const plainTheme: JobsUiTheme = { fg: (_color, text) => text };
export const JOBS_UI_LIST_HINT = "/jobs-ui list";

export interface JobsUiView {
	unavailable?: string;
	records?: JobsViewRecord[];
}
export interface JobsRowOptions { folded?: boolean }

function clean(text: string): string {
	return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "").replace(/\s+/gu, " ").trim();
}

/** Compact clock. Unknown stays unknown; this is not a liveness or acceptance claim. */
export const formatJobDuration = formatPanelDuration;

/** Jobs keeps a small budget so a short terminal clips Jobs before the Tasks body. */
export function jobsRenderBudget(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? Math.floor(terminalRows) : 36;
	const tasksBudget = Math.min(12, Math.max(1, Math.floor(rows / 3)));
	return Math.max(1, Math.min(4, rows - tasksBudget - 6));
}

function elapsed(record: JobsViewRecord, now: number): string {
	const end = record.status === "running" ? now : record.terminalAt;
	if (end === null || !Number.isFinite(record.startedAt) || !Number.isFinite(end) || end < record.startedAt) return "unknown";
	return formatJobDuration(end - record.startedAt);
}

/** Time since last output matters only while the process runs; quiet output is not a stall. */
function runningDetail(record: JobsViewRecord, now: number): string {
	if (record.lastOutputAt === null) return "no output yet";
	if (!Number.isFinite(record.lastOutputAt) || now < record.lastOutputAt) return "output unknown";
	return `output ${formatJobDuration(now - record.lastOutputAt)} ago`;
}

/** Glyph shape and tone carry the recorded terminal state; a non-zero exit stays on its own row. */
function jobState(record: JobsViewRecord, now: number): { glyph: string; tone: PanelTone; detail: string } {
	switch (record.status) {
		case "running": return record.overdue
			? { glyph: "◐", tone: "warning", detail: `past checkpoint · ${runningDetail(record, now)}` }
			: { glyph: "◐", tone: "accent", detail: runningDetail(record, now) };
		case "exited":
			if (record.exitCode === null) return { glyph: "?", tone: "warning", detail: "exit unknown" };
			return record.exitCode === 0
				? { glyph: "✓", tone: "success", detail: "" }
				: { glyph: "✗", tone: "error", detail: `exit ${record.exitCode}` };
		case "timeout": return { glyph: "⊘", tone: "warning", detail: "timeout" };
		case "interrupted": return { glyph: "⊘", tone: "warning", detail: "interrupted" };
		default: return { glyph: "⊘", tone: "dim", detail: record.status };
	}
}

function jobSpec(record: JobsViewRecord, now: number): PanelRowSpec {
	const state = jobState(record, now);
	return {
		glyph: state.glyph,
		glyphTone: state.tone,
		primary: clean(record.commandPreview ?? record.label) || "Bash",
		primaryTone: record.status === "running" ? "text" : "dim",
		fields: [elapsed(record, now), state.detail],
	};
}

/**
 * The heading reports finished-of-total progress, ends on the running count, and alerts while a
 * job runs past its checkpoint awaiting the model's renew-or-cancel decision.
 * Finished failures stay visible on their rows instead of holding the section in a warning state.
 */
export function jobRows(view: JobsUiView, width: number, maxRows = 4, now = Date.now(), theme: JobsUiTheme = plainTheme, options?: JobsRowOptions): string[] {
	width = Math.max(0, Math.floor(width));
	maxRows = Math.max(0, Math.floor(maxRows));
	if (!width || !maxRows) return [];
	const panel = theme as PanelTheme;
	if (view.unavailable !== undefined) {
		return [panelHeading({ title: "Jobs", alerts: [`unavailable · ${clean(view.unavailable) || "unavailable"}`] }, width, { folded: true, theme: panel })];
	}
	const records = view.records;
	if (!records) return [];
	const running = records.filter((record) => record.status === "running");
	const section = options?.folded !== undefined;
	const folded = options?.folded === true || maxRows < 2 || (!section && width < 36);
	const overdue = running.filter((record) => record.overdue === true).length;
	let header = panelHeading({
		title: "Jobs",
		progress: `${records.length - running.length}/${records.length} done`,
		focus: running.length ? [`${running.length} running`] : [],
		alerts: overdue ? [`${overdue} past checkpoint`] : [],
	}, width, { folded, theme: panel });
	if (folded) {
		if (!section && !options?.folded && records.length > 0) {
			const hint = theme.fg("dim", ` · ${JOBS_UI_LIST_HINT}`);
			if (visibleWidth(header + hint) <= width) header = truncateToWidth(header + hint, width, "…");
		}
		return [header];
	}
	return [header, ...panelRows(records.map((record) => jobSpec(record, now)), width, panel, {
		maxRows: maxRows - 1,
		align: ["right", "left"],
		hint: JOBS_UI_LIST_HINT,
	})];
}
