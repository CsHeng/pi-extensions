import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TaskDisposition, WorkflowView, WorksetState } from "./contracts.ts";
import { buildView } from "./reducer.ts";

export interface WorkflowUiSnapshot {
	state: WorksetState | undefined;
	recovery: string | undefined;
}

export interface WorkflowUiTheme {
	fg(color: "accent" | "dim" | "text" | "warning" | "success" | "error" | "muted", text: string): string;
	strikethrough(text: string): string;
}

type ViewTask = WorkflowView["tasks"][number];

/** Model-authored text is terminal data, never terminal markup. Preserve emoji joiners. */
function clean(text: string): string {
	return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
}

function projection(state: WorksetState) {
	const view = buildView(state);
	// Closed views intentionally suppress completion deficits. Ask the same reducer predicate
	// for recorded acceptance facts without changing the closed state or certifying freshness.
	const acceptanceView = state.workset.disposition === "closed"
		? buildView({ ...state, workset: { ...state.workset, disposition: "active" } }) : view;
	const unaccepted = new Set(acceptanceView.deficits.find((deficit) => deficit.code === "unaccepted_tasks")?.ids ?? []);
	const active = view.tasks.filter((task) => task.disposition !== "cancelled" && task.disposition !== "superseded");
	const accepted = new Set(active.filter((task) => task.disposition === "accepted" && !unaccepted.has(task.id)).map((task) => task.id));
	return { view, active, accepted };
}

function heading(state: WorksetState, count: number, total: number, needsAlignment: boolean, theme: WorkflowUiTheme, width: number): string {
	const status = state.workset.disposition === "closed" ? ` · ${state.workset.closeOutcome ?? "closed"}`
		: `${state.workset.disposition === "paused" ? " · paused" : ""}${needsAlignment ? " · needs_alignment" : ""}`;
	const start = "● Tasks";
	const end = ` (${count}/${total} accepted)${status}`;
	const goalWidth = width - visibleWidth(start + end + " · ");
	const goal = goalWidth > 0 ? ` · ${stripTerminalSequences(truncateToWidth(clean(state.workset.goal), goalWidth, "…"))}` : "";
	return theme.fg("accent", stripTerminalSequences(truncateToWidth(start + goal + end, width, "…")));
}

const glyphs: Record<TaskDisposition, string> = {
	pending: "○", running: "◐", awaiting_acceptance: "◇", accepted: "✓", blocked: "!", paused: "Ⅱ", cancelled: "×", superseded: "↪",
};

/** Above-editor widget rows stop at this width on wider terminals; the detail list keeps full text. */
const MAX_WIDGET_WIDTH = 120;
const MAX_ROW_SUFFIX = 48;

function taskRow(task: ViewTask, accepted: Set<string>, theme: WorkflowUiTheme, width?: number): string {
	const valid = accepted.has(task.id);
	const invalid = task.disposition === "accepted" && !valid;
	const color = valid ? "success" : task.disposition === "running" || task.disposition === "blocked" || invalid ? "warning" : "dim";
	let suffix = "";
	if (invalid) suffix = "acceptance not current";
	else if (task.disposition === "pending") {
		const unresolved = task.dependsOn.filter((id) => !accepted.has(id));
		if (unresolved.length > 0) suffix = `waits for ${unresolved.map(clean).join(", ")}`;
	} else if (task.disposition === "awaiting_acceptance") suffix = "awaiting acceptance";
	else if (task.disposition === "blocked") suffix = `blocked${task.reason ? `: ${clean(task.reason)}` : ""}`;
	else if (["paused", "cancelled", "superseded"].includes(task.disposition)) suffix = task.disposition;
	if (suffix) suffix = stripTerminalSequences(truncateToWidth(suffix, MAX_ROW_SUFFIX, "…"));
	const glyph = invalid ? "◇" : glyphs[task.disposition];
	const idText = clean(task.id);
	let title = clean(task.title ?? task.outcome);
	if (width !== undefined) {
		// Middle truncation keeps the leading glyph/id and the trailing status visible at any width.
		const available = width - visibleWidth(`${glyph} ${idText} `) - visibleWidth(suffix ? ` · ${suffix}` : "") - 1;
		title = available > 4 ? stripTerminalSequences(truncateToWidth(title, available, "…")) : "";
	}
	const outcome = valid ? theme.fg("dim", theme.strikethrough(title)) : theme.fg(task.disposition === "running" ? "accent" : "text", title);
	return `${theme.fg(color, glyph)} ${theme.fg("dim", idText)} ${outcome}${suffix ? theme.fg("dim", ` · ${suffix}`) : ""}`;
}

function priority(task: ViewTask, accepted: Set<string>): number {
	if (accepted.has(task.id)) return 2;
	if (task.disposition === "pending" || task.disposition === "paused") return 1;
	return 0;
}

function omittedSummary(tasks: ViewTask[], accepted: Set<string>): string {
	const counts = new Map<string, number>();
	for (const task of tasks) {
		const label = task.disposition === "accepted" && !accepted.has(task.id) ? "acceptance not current" : task.disposition.replaceAll("_", " ");
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return `… ${[...counts].map(([label, count]) => `${count} ${label}`).join(", ")} hidden · /workflow-ui list`;
}

const deficitLabels = {
	unaccepted_criteria: "criteria not accepted", unaccepted_tasks: "tasks not accepted", open_attempts: "unresolved attempts",
	missing_delivery_evidence: "delivery evidence missing", needs_alignment: "needs_alignment", workset_not_active: "workset paused", uncovered_criteria: "criteria without tasks",
	no_required_criteria: "no required criteria",
};

export function renderWorkflowWidget(
	snapshot: WorkflowUiSnapshot,
	theme: WorkflowUiTheme,
	options: { width: number; rows: number; collapsed: boolean },
): string[] {
	const width = Math.max(0, Math.min(Math.floor(options.width), MAX_WIDGET_WIDTH));
	if (width === 0) return [];
	const budget = Math.min(12, Math.max(1, Math.floor(options.rows / 3)));
	const finish = (rows: string[]) => [...rows.slice(0, budget).map((row) => truncateToWidth(row, width, "…")), ""];
	if (snapshot.recovery !== undefined) return finish([theme.fg("warning", "! Tasks · state unavailable · /workflow-ui list")]);
	if (!snapshot.state) return [];
	const { state } = snapshot;
	const { view, active, accepted } = projection(state);
	const rows = [heading(state, accepted.size, active.length, view.deficits.some((deficit) => deficit.code === "needs_alignment"), theme, width)];
	if (state.workset.disposition === "closed") return finish(rows);
	if (options.collapsed) return finish([...rows, theme.fg("dim", "/workflow-ui to expand · /workflow-ui list")]);
	if (active.length === accepted.size && view.deficits.length > 0 && budget > 1) {
		rows.push(theme.fg("warning", `Remaining: ${view.deficits.map((deficit) => deficitLabels[deficit.code]).join("; ")}`));
	}
	const available = budget - rows.length;
	const overflow = active.length > available;
	const ordered = overflow ? [...active].sort((a, b) => priority(a, accepted) - priority(b, accepted)) : active;
	const shown = ordered.slice(0, Math.max(0, available - (overflow ? 1 : 0)));
	for (const [index, task] of shown.entries()) rows.push(theme.fg("dim", index === shown.length - 1 && !overflow ? "└─ " : "├─ ") + taskRow(task, accepted, theme, width - 2));
	if (overflow && available > 0) rows.push(theme.fg("dim", omittedSummary(ordered.slice(shown.length), accepted)));
	return finish(rows);
}

/** All rows are returned; the controller owns viewport and scrolling, never task state. */
export function workflowDetailRows(snapshot: WorkflowUiSnapshot, theme: WorkflowUiTheme, width: number): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];
	const add = (text: string) => rows.push(...wrapTextWithAnsi(text, width).map((row) => truncateToWidth(row, width, "…")));
	if (snapshot.recovery !== undefined) {
		add(theme.fg("warning", "Tasks · state unavailable"));
		add(theme.fg("dim", clean(snapshot.recovery)));
		return rows;
	}
	if (!snapshot.state) return [theme.fg("dim", stripTerminalSequences(truncateToWidth("No workflow workset.", width, "…")))];
	const { state } = snapshot;
	const { view, active, accepted } = projection(state);
	add(heading(state, accepted.size, active.length, view.deficits.some((deficit) => deficit.code === "needs_alignment"), theme, width));
	add(theme.fg("text", `Goal: ${clean(state.workset.goal)}`));
	add(theme.fg("dim", `Delivery: ${clean(state.workset.deliveryEndpoint)}`));
	if (state.workset.closeReason) add(theme.fg("dim", `Closed: ${clean(state.workset.closeReason)}`));
	for (const deficit of view.deficits) add(theme.fg("warning", clean(deficit.message)));
	const history = view.tasks.filter((task) => task.disposition === "cancelled" || task.disposition === "superseded");
	for (const [label, tasks] of [["Active tasks", active], ["History · cancelled / superseded", history]] as const) {
		if (tasks.length === 0) continue;
		add(theme.fg("accent", label));
		for (const task of tasks) {
			add(taskRow(task, accepted, theme));
			if (task.title !== undefined) add(theme.fg("dim", `  Outcome: ${clean(task.outcome)}`));
			if (task.dependsOn.length > 0) add(theme.fg("dim", `  Depends on: ${task.dependsOn.map(clean).join(", ")}`));
			if (task.reason) add(theme.fg("dim", `  Reason: ${clean(task.reason)}`));
			const record = state.tasks[task.id]!;
			if (record.blockClass) add(theme.fg("dim", `  Block: ${clean(record.blockClass)}`));
			if (record.nextUnblockCondition) add(theme.fg("dim", `  Unblocks when: ${clean(record.nextUnblockCondition)}`));
			for (const attempt of view.attempts.filter((attempt) => attempt.taskId === task.id)) {
				add(theme.fg("dim", `  ${clean(attempt.id)} · ${attempt.state}`));
			}
		}
	}
	return rows;
}
