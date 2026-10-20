/** Read-only Jobs presentation. Section headers share the disclosure helper; list rows keep the legacy summary. */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { panelHeading } from "../shared/panel-heading.ts";
import type { JobsViewRecord } from "../async-bash/jobs-view.ts";

export interface JobsUiTheme { fg: (color: string, text: string) => string }
const plainTheme: JobsUiTheme = { fg: (_color, text) => text };
export const JOBS_UI_LIST_HINT = "/bash-jobs-ui list";

export interface JobsUiView {
	unavailable?: string;
	records?: JobsViewRecord[];
}
export interface JobsRowOptions { folded?: boolean }

function clean(text: string): string {
	return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "").replace(/\s+/gu, " ").trim();
}

/** Compact clock. Unknown stays unknown; this is not a liveness or acceptance claim. */
export function formatJobDuration(durationMs: number | null): string {
	if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "unknown";
	if (durationMs < 1_000) return `${Math.floor(durationMs)}ms`;
	const total = Math.floor(durationMs / 1_000);
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	if (hours > 0) return `${hours}h${pad(minutes)}m${pad(seconds)}s`;
	if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
	return `${seconds}s`;
}

/** Jobs keeps a small budget so a short terminal clips Jobs before the Tasks body. */
export function jobsRenderBudget(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? Math.floor(terminalRows) : 36;
	const tasksBudget = Math.min(12, Math.max(1, Math.floor(rows / 3)));
	return Math.max(1, Math.min(4, rows - tasksBudget - 6));
}

export function shortExecutionIds(ids: readonly string[]): Map<string, string> {
	const unique = [...new Set(ids)];
	const map = new Map<string, string>();
	const max = Math.max(4, ...unique.map((id) => id.length), 4);
	for (let width = 4; width < max; width += 1) {
		const shorts = unique.map((id) => id.slice(-width));
		if (new Set(shorts).size === unique.length) {
			unique.forEach((id, index) => map.set(id, shorts[index] ?? id));
			return map;
		}
	}
	for (const id of unique) map.set(id, id);
	return map;
}

function elapsed(record: JobsViewRecord, now: number): string {
	const end = record.status === "running" ? now : record.terminalAt;
	if (end === null || !Number.isFinite(record.startedAt) || !Number.isFinite(end) || end < record.startedAt) return "unknown";
	return formatJobDuration(end - record.startedAt);
}

function outputAge(record: JobsViewRecord, now: number): string {
	if (record.lastOutputAt === null) return "no output";
	const end = record.status === "running" ? now : record.terminalAt;
	if (end === null || !Number.isFinite(end) || end < record.lastOutputAt) return "unknown";
	return `output ${formatJobDuration(end - record.lastOutputAt)}`;
}

function exitLabel(record: JobsViewRecord): string {
	if (record.status === "running") return "";
	return record.exitCode === null ? "  exit unknown" : `  exit ${record.exitCode}`;
}

export function jobRows(view: JobsUiView, width: number, maxRows = 4, now = Date.now(), theme: JobsUiTheme = plainTheme, options?: JobsRowOptions): string[] {
	width = Math.max(0, Math.floor(width));
	maxRows = Math.max(0, Math.floor(maxRows));
	if (!width || !maxRows) return [];
	const clip = (text: string) => truncateToWidth(text, width, "…");
	if (view.unavailable !== undefined) return [clip(theme.fg("warning", `! Bash jobs · unavailable · ${clean(view.unavailable) || "unavailable"}`))];
	const records = view.records;
	if (!records) return [];
	const running = records.filter((record) => record.status === "running");
	const failed = records.some((record) => record.status === "exited" && record.exitCode !== null && record.exitCode !== 0);
	const interrupted = records.some((record) => record.status === "cancelled" || record.status === "deadline" || record.status === "interrupted");
	const flags = [failed ? "failed" : "", interrupted ? "interrupted" : ""].filter(Boolean);
	let longestAge: number | null = null;
	for (const record of running) {
		const age = Number.isFinite(record.startedAt) && now >= record.startedAt ? now - record.startedAt : null;
		if (age !== null && (longestAge === null || age > longestAge)) longestAge = age;
	}
	const longest = running.length === 0 ? "" : ` · longest ${formatJobDuration(longestAge)}`;
	const summary = `(${running.length} running / ${records.length} total${longest})`;
	const warning = flags.length > 0;
	const content = warning ? `${flags.join(" · ")} · Bash jobs ${summary}` : `Bash jobs ${summary}`;
	const foldedFlag = options?.folded;
	const section = foldedFlag !== undefined;
	const folded = section ? foldedFlag === true || maxRows < 2 : foldedFlag === true || maxRows < 2 || width < 36;
	if (section) {
		if (folded) return [panelHeading(content, width, { folded: foldedFlag === true, warning, theme: { fg: (color, text) => theme.fg(color, text) } })];
	} else if (folded) {
		const header = warning ? `! ${content}` : `${options?.folded ? "▸" : "▾"} ${content}`;
		const hint = !options?.folded && records.length > 0 ? ` · ${JOBS_UI_LIST_HINT}` : "";
		const withHint = visibleWidth(header + hint) <= width ? `${header}${hint}` : header;
		return [clip(theme.fg(warning ? "warning" : "accent", withHint))];
	}
	const header = section
		? panelHeading(content, width, { folded: false, warning, theme: { fg: (color, text) => theme.fg(color, text) } })
		: clip(theme.fg(warning ? "warning" : "accent", warning ? `! ${content}` : `▾ ${content}`));
	const rows = [header];
	const room = maxRows - 1;
	const overflow = records.length > room;
	const shown = records.slice(0, Math.max(0, room - (overflow ? 1 : 0)));
	for (const [index, record] of shown.entries()) {
		const branch = index === shown.length - 1 && !overflow ? "└─ " : "├─ ";
		const preview = clean(record.commandPreview ?? record.label) || "Bash";
		const prefix = `${branch}Bash `;
		const suffix = `  ${record.status}  ${elapsed(record, now)}  ${outputAge(record, now)}${exitLabel(record)}`;
		const room = Math.max(0, width - visibleWidth(prefix + suffix) - 2);
		const command = room > 0 ? `"${truncateToWidth(preview, room, "…")}"` : "";
		const text = `${prefix}${command}${suffix}`;
		rows.push(clip(theme.fg("dim", text)));
	}
	if (overflow && room > 0) rows.push(clip(theme.fg("dim", `… ${records.length - shown.length} more · ${JOBS_UI_LIST_HINT}`)));
	return rows;
}
