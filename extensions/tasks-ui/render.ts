/** Read-only task presentation. Section headers share the disclosure helper; list rows keep the legacy summary. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { panelHeading, type PanelTheme } from "../shared/panel-heading.ts";
import type { TasklistState, TasklistTask, TasklistView } from "../tasklist/contracts.ts";

export type TasklistUiTheme = Pick<Theme, "fg" | "strikethrough">;
const plainTheme: TasklistUiTheme = { fg: (_color, text) => text, strikethrough: text => text };
export const TASKS_UI_LIST_HINT = "/tasks-ui list";

/** Task text is terminal data, never markup. Preserve emoji joiners. */
function clean(text: string): string {
	return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
}

type Progress = TasklistTask["status"];
export function taskProgress(_state: TasklistState, task: TasklistTask): Progress { return task.status; }

/** The host has already selected a TUI: ambient stdout/Chalk detection must not erase SGR 9. */
function strike(title: string, theme: TasklistUiTheme): string {
	if (theme === plainTheme || !title) return title;
	const styled = theme.strikethrough(title);
	return styled.includes("\x1b[9m") ? styled : `\x1b[9m${styled}\x1b[29m`;
}

export interface TasklistRowOptions { folded?: boolean }

/** Above-editor Tasks budget. A short terminal keeps the header and clips the body before Jobs. */
export function tasksRenderBudget(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? Math.floor(terminalRows) : 36;
	return Math.min(12, Math.max(1, Math.floor(rows / 3)));
}

function headingTheme(theme: TasklistUiTheme): PanelTheme {
	return { fg: (color, text) => theme.fg(color, text) };
}

export function taskRows(view: TasklistView, width: number, maxRows = 12, theme: TasklistUiTheme = plainTheme, options?: TasklistRowOptions): string[] {
	width = Math.max(0, Math.floor(width));
	maxRows = Math.max(0, Math.floor(maxRows));
	if (!width || !maxRows) return [];
	const clip = (text: string) => truncateToWidth(text, width, "…");
	if (view.unavailable !== undefined) return [panelHeading({ title: "Tasks", alerts: ["state unavailable", TASKS_UI_LIST_HINT] }, width, { folded: true, theme: headingTheme(theme) })];
	const s = view.state;
	if (!s) return [];
	const tasks = s.tasks.map(task => ({ task, status: task.status, suffix: task.note ? clean(task.note) : "" }));
	const doneCount = tasks.filter(t => t.status === "done").length;
	const cancelledCount = tasks.filter(t => t.status === "cancelled").length;
	// Item-derived only: the list has no engine state to report.
	const blockedCount = tasks.filter(t => t.status === "blocked").length;
	const doingCount = tasks.filter(t => t.status === "doing").length;
	const folded = options?.folded === true;
	// Blocked is current item state, so it is the only alert; the list title shrinks first.
	const rows = [panelHeading({
		title: "Tasks",
		...(folded ? {} : { subtitle: clean(s.title) }),
		progress: `${doneCount}/${tasks.length} done${cancelledCount ? ` · ${cancelledCount} cancelled` : ""}`,
		focus: doingCount ? [`${doingCount} doing`] : [],
		alerts: blockedCount ? [`${blockedCount} blocked`] : [],
	}, width, { folded, theme: headingTheme(theme) })];
	if (folded) return rows;
	const available = maxRows - rows.length;
	const overflow = tasks.length > available;
	// Keep active and blocked tasks visible instead of filling the widget with completed work.
	const priority = (status: string) => status === "doing" || status === "blocked" ? 0 : (status === "done" || status === "cancelled") ? 2 : 1;
	const ordered = overflow ? [...tasks].sort((a, b) => priority(a.status) - priority(b.status)) : tasks;
	const shown = ordered.slice(0, Math.max(0, available - (overflow ? 1 : 0)));
	// One key column so titles start on the same column.
	const keyCap = Math.min(16, Math.floor(Math.max(0, width - 5) / 4));
	const keyColumn = keyCap >= 3 ? Math.min(keyCap, Math.max(0, ...shown.map(({ task }) => visibleWidth(clean(task.id))))) : 0;
	for (const [index, { task, status, suffix }] of shown.entries()) {
		const glyph = { done: "✓", doing: "◐", blocked: "!", todo: "○", cancelled: "–" }[status];
		const color = status === "done" ? "success" : status === "doing" || status === "blocked" ? "warning" : "dim";
		const branch = index === shown.length - 1 && !overflow ? "└─ " : "├─ ";
		const rowPrefix = `${branch}${glyph} `;
		const keyText = keyColumn ? truncateToWidth(clean(task.id), keyColumn, "…") : "";
		const key = keyColumn ? `${keyText}${" ".repeat(Math.max(0, keyColumn - visibleWidth(keyText)))}  ` : "";
		const remaining = Math.max(0, width - visibleWidth(rowPrefix + key));
		// Titles are the primary content; long keys and diagnostic hints must not crowd them out.
		const titleText = clean(task.title);
		const reserved = Math.min(visibleWidth(titleText), Math.max(12, Math.ceil(remaining * 0.6)));
		const suffixWidth = Math.min(48, remaining - reserved - 3);
		const label = suffix && suffixWidth >= 8 ? ` · ${truncateToWidth(suffix, suffixWidth, "…")}` : "";
		const titleWidth = remaining - visibleWidth(label);
		const title = titleWidth > 0 ? truncateToWidth(titleText, titleWidth, "…") : "";
		const text = status === "done" ? theme.fg("dim", strike(title, theme)) : theme.fg(status === "doing" ? "accent" : "text", title);
		rows.push(clip(theme.fg("dim", branch) + theme.fg(color, glyph) + " " + theme.fg("dim", key) + text + theme.fg("dim", label)));
	}
	if (overflow && available > 0) rows.push(clip(theme.fg("dim", `└─ … ${tasks.length - shown.length} more · ${TASKS_UI_LIST_HINT}`)));
	return rows;
}
