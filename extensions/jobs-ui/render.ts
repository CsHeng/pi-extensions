/** Read-only Jobs presentation on the shared panel heading and row grammar. */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { panelHeading, type PanelTheme, type PanelTone } from "../shared/panel-heading.ts";
import { formatPanelDuration } from "../shared/panel-rows.ts";
import type { JobsViewRecord } from "../async-bash/jobs-view.ts";
import { inspectionFrame, type InspectionFrame, type InspectionItem } from "../shared/inspection-rows.ts";

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

function instant(value: number): string {
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}

export function jobItems(view: JobsUiView, now = Date.now()): InspectionItem[] {
	return (view.records ?? []).map(record => {
		const state = jobState(record, now);
		const command = clean(record.commandPreview ?? record.label) || "Bash";
		return {
			key: record.executionId, glyph: state.glyph, tone: state.tone, name: "", activity: command,
			tail: [record.status === "running" ? (record.overdue ? "past checkpoint" : "") : state.detail, elapsed(record, now)].filter(Boolean).join(" · "),
			detail: () => [
				`Job: ${clean(record.label)}`, `Command: ${command}`,
				`Status: ${record.status}${record.status === "exited" && record.exitCode === 0 ? " · exit 0" : state.detail ? ` · ${state.detail}` : ""}`,
				`Started: ${instant(record.startedAt)}`,
				...(record.terminalAt === null ? [] : [`Finished: ${instant(record.terminalAt)}`]),
				`Elapsed: ${elapsed(record, now)}`,
				`Last output: ${record.lastOutputAt === null ? "none" : instant(record.lastOutputAt)}`,
				...(record.output ? [record.output.truncated ? "Output (earlier output truncated):" : "Output:",
					record.output.text.replace(/\t/g, "    ") || (record.lastOutputAt !== null ? "(no printable output)" : record.status === "running" ? "(no output yet)" : "(no output)")] : ["Output unavailable"]),
			],
		};
	});
}

export function jobFrame(view: JobsUiView, width: number, maxRows: number, now: number, theme: JobsUiTheme | undefined, selected?: string): InspectionFrame {
	const heading = jobHeading(view, width, maxRows < 2, theme) ?? "";
	return inspectionFrame(heading, jobItems(view, now), width, maxRows, theme as PanelTheme | undefined, { ...(selected !== undefined ? { selected } : {}), hint: JOBS_UI_LIST_HINT });
}

/**
 * The heading reports finished-of-total progress, ends on the running count, and alerts while a
 * job runs past its checkpoint awaiting the model's renew-or-cancel decision.
 * Finished failures stay visible on their rows instead of holding the section in a warning state.
 */
function jobHeading(view: JobsUiView, width: number, folded: boolean, theme: JobsUiTheme = plainTheme): string | undefined {
	if (width < 1) return undefined;
	const panel = theme as PanelTheme;
	if (view.unavailable !== undefined) {
		return panelHeading({ title: "Jobs", alerts: [`unavailable · ${clean(view.unavailable) || "unavailable"}`] }, width, { folded: true, theme: panel });
	}
	const records = view.records;
	if (!records) return undefined;
	const running = records.filter((record) => record.status === "running");
	const overdue = running.filter((record) => record.overdue === true).length;
	return panelHeading({
		title: "Jobs",
		progress: `${records.length - running.length}/${records.length} done`,
		focus: running.length ? [`${running.length} running`] : [],
		alerts: overdue ? [`${overdue} past checkpoint`] : [],
	}, width, { folded, theme: panel });
}

export function jobRows(view: JobsUiView, width: number, maxRows = 4, now = Date.now(), theme: JobsUiTheme = plainTheme, options?: JobsRowOptions): string[] {
	width = Math.max(0, Math.floor(width)); maxRows = Math.max(0, Math.floor(maxRows));
	if (!width || !maxRows) return [];
	const folded = options?.folded === true || maxRows < 2 || (options?.folded === undefined && width < 36);
	const heading = jobHeading(view, width, folded, theme);
	if (heading === undefined) return [];
	if (folded || view.unavailable !== undefined) return [heading];
	return inspectionFrame(heading, jobItems(view, now), width, maxRows, theme as PanelTheme, { hint: JOBS_UI_LIST_HINT }).lines;
}
