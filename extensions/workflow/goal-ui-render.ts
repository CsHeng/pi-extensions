/** Read-only task presentation; protocol receipts belong to the tool, not the TUI. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GoalView } from "./goal-contracts.ts";
import { accepted } from "./goal-state.ts";

export type GoalUiTheme = Pick<Theme, "fg" | "strikethrough">;
const plainTheme: GoalUiTheme = { fg: (_color, text) => text, strikethrough: text => text };

/** Task text is terminal data, never markup. Preserve emoji joiners. */
function clean(text: string): string {
 return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function goalRows(view: GoalView, width: number, maxRows = 12, theme: GoalUiTheme = plainTheme): string[] {
 width = Math.max(0, Math.floor(width));
 maxRows = Math.max(0, Math.floor(maxRows));
 if (!width || !maxRows) return [];
 const clip = (text: string) => truncateToWidth(text, width, "…");
 if (view.unavailable !== undefined) return [clip(theme.fg("warning", "! Tasks · state unavailable · /workflow-ui list"))];
 const s = view.state;
 if (!s) return [];
 const tasks = s.tasks.map(task => {
  const done = accepted(s, `task:${task.key}`);
  const running = s.attempts.some(a => a.task === task.key && a.status === "running");
  const status = task.blocker ? "blocked" : running ? "running" : done ? "done" : "pending";
  const dependencies = task.dependsOn?.filter(key => !accepted(s, `task:${key}`)) ?? [];
  const suffix = task.blocker ? `blocked: ${clean(task.blocker.reason)}` : status === "pending" && dependencies.length ? `waits for ${dependencies.map(clean).join(", ")}` : "";
  return { task, status, suffix };
 });
 const doneCount = tasks.filter(t => t.status === "done").length;
 const outcome = s.fulfillment === "complete" ? " · completed" : s.fulfillment === "cancelled" ? " · cancelled" : s.fulfillment === "superseded" ? " · superseded" : "";
 const end = ` (${doneCount}/${tasks.length})${outcome}`;
 const goalWidth = width - visibleWidth(`● Tasks · ${end}`);
 const goal = goalWidth > 0 ? ` · ${truncateToWidth(clean(s.goal), goalWidth, "…")}` : "";
 const rows = [clip(theme.fg("accent", `● Tasks${goal}${end}`))];
 const available = maxRows - 1;
 const overflow = tasks.length > available;
 // Keep active and blocked tasks visible instead of filling the widget with completed work.
 const priority = (status: string) => status === "running" || status === "blocked" ? 0 : status === "pending" ? 1 : 2;
 const ordered = overflow ? [...tasks].sort((a, b) => priority(a.status) - priority(b.status)) : tasks;
 const shown = ordered.slice(0, Math.max(0, available - (overflow ? 1 : 0)));
 for (const [index, { task, status, suffix }] of shown.entries()) {
  const glyph = status === "done" ? "✓" : status === "running" ? "◐" : status === "blocked" ? "!" : "○";
  const color = status === "done" ? "success" : status === "running" || status === "blocked" ? "warning" : "dim";
  const branch = index === shown.length - 1 && !overflow ? "└─ " : "├─ ";
  const prefix = `${branch}${glyph} `;
  const keyWidth = Math.min(16, Math.floor(Math.max(0, width - visibleWidth(prefix)) / 4));
  const key = keyWidth >= 3 ? `${truncateToWidth(clean(task.key), keyWidth, "…")} ` : "";
  const remaining = Math.max(0, width - visibleWidth(prefix + key));
  // Titles are the primary content; long keys and diagnostic hints must not crowd them out.
  const titleText = clean(task.title);
  const reserved = Math.min(visibleWidth(titleText), Math.max(12, Math.ceil(remaining * 0.6)));
  const suffixWidth = Math.min(48, remaining - reserved - 3);
  const label = suffix && suffixWidth >= 8 ? ` · ${truncateToWidth(suffix, suffixWidth, "…")}` : "";
  const titleWidth = remaining - visibleWidth(label);
  const title = titleWidth > 0 ? truncateToWidth(titleText, titleWidth, "…") : "";
  const text = status === "done" ? theme.fg("dim", theme.strikethrough(title)) : theme.fg(status === "running" ? "accent" : "text", title);
  rows.push(clip(theme.fg("dim", branch) + theme.fg(color, glyph) + " " + theme.fg("dim", key) + text + theme.fg("dim", label)));
 }
 if (overflow && available > 0) rows.push(clip(theme.fg("dim", `… ${tasks.length - shown.length} more · /workflow-ui list`)));
 return rows;
}
