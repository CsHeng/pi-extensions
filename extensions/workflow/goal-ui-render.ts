/** Read-only task presentation; protocol receipts belong to the tool, not the TUI. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GoalState, GoalTask, GoalView } from "./goal-contracts.ts";
import { accepted } from "./goal-state.ts";

export type GoalUiTheme = Pick<Theme, "fg" | "strikethrough">;
const plainTheme: GoalUiTheme = { fg: (_color, text) => text, strikethrough: text => text };

/** Task text is terminal data, never markup. Preserve emoji joiners. */
function clean(text: string): string {
 return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
}

type Progress = "pending" | "running" | "reported" | "recheck" | "blocked" | "done";
/** One read-only projection shared by the widget and list; history is not current acceptance. */
export function taskProgress(state: GoalState, task: GoalTask): Progress {
 if (task.blocker) return "blocked";
 const attempts = state.attempts.filter(a => a.task === task.key && a.revision === task.revision);
 if (attempts.some(a => a.status === "running")) return "running";
 if (accepted(state, `task:${task.key}`)) return "done";
 const latest = attempts.at(-1);
 const judgment = state.acceptance.find(j => j.subject === `task:${task.key}`);
 // Starting a dependent task required accepted predecessors. Losing one revokes that work's basis.
 if (latest && task.dependsOn?.some(dep => !accepted(state, `task:${dep}`))) return "recheck";
 if (latest?.status === "interrupted" || judgment?.accepted || (latest && state.facts.some(f => f.attempt === latest.id && !f.usable))
  || (!latest && state.attempts.some(a => a.task === task.key))) return "recheck";
 return latest?.status === "reported" ? "reported" : "pending";
}

/** The host has already selected a TUI: ambient stdout/Chalk detection must not erase SGR 9. */
function strike(title: string, theme: GoalUiTheme): string {
 if (theme === plainTheme || !title) return title;
 const styled = theme.strikethrough(title);
 return styled.includes("\x1b[9m") ? styled : `\x1b[9m${styled}\x1b[29m`;
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
  const status = taskProgress(s, task);
  const dependencies = task.dependsOn?.filter(key => !accepted(s, `task:${key}`)) ?? [];
  const suffix = task.blocker ? `blocked: ${clean(task.blocker.reason)}` : status === "reported" ? "reported · awaiting acceptance"
   : status === "recheck" ? "recheck · evidence stale or interrupted" : status === "pending" && dependencies.length ? `waits for ${dependencies.map(clean).join(", ")}` : "";
  return { task, status, suffix };
 });
 const doneCount = tasks.filter(t => t.status === "done").length;
 const outcome = s.fulfillment === "complete" ? " · completed" : s.fulfillment === "cancelled" ? " · cancelled" : s.fulfillment === "superseded" ? " · superseded" : "";
 const warnings = s.fulfillment === "pending" ? [
  ...(s.continuation.state !== "active" ? [s.continuation.state] : []), ...(!s.input.aligned ? ["needs alignment"] : []),
 ] : [];
 let prefix = warnings.length ? `! ${warnings.join(" · ")} · Tasks` : "● Tasks";
 const counts = ["running", "reported"].map(status => { const n = tasks.filter(t => t.status === status).length; return n ? ` · ${n} ${status}` : ""; }).join("");
 const end = ` (${doneCount}/${tasks.length} accepted)${outcome}`;
 if (warnings.length && visibleWidth(prefix + end) > width) prefix = `! ${warnings.map(w => w === "needs alignment" ? "align" : w).join("/")}`;
 if (warnings.length && visibleWidth(prefix + end) > width) prefix = "!";
 const detail = visibleWidth(prefix + end + counts) <= width ? counts : "";
 const goalWidth = width - visibleWidth(`${prefix} · ${end}${detail}`);
 const goal = goalWidth > 0 ? ` · ${truncateToWidth(clean(s.goal), goalWidth, "…")}` : "";
 const rows = [clip(theme.fg(warnings.length ? "warning" : "accent", `${prefix}${goal}${end}${detail}`))];
 if (warnings.length && s.continuation.reason && maxRows >= 5) rows.push(clip(theme.fg("warning", `  ${clean(s.continuation.reason)}`)));
 const available = maxRows - rows.length;
 const overflow = tasks.length > available;
 // Keep active and blocked tasks visible instead of filling the widget with completed work.
 const priority = (status: string) => status === "running" || status === "blocked" || status === "recheck" ? 0 : status === "done" ? 2 : 1;
 const ordered = overflow ? [...tasks].sort((a, b) => priority(a.status) - priority(b.status)) : tasks;
 const shown = ordered.slice(0, Math.max(0, available - (overflow ? 1 : 0)));
 for (const [index, { task, status, suffix }] of shown.entries()) {
  const glyph = { done: "✓", running: "◐", blocked: "!", pending: "○", reported: "◇", recheck: "↻" }[status];
  const color = status === "done" ? "success" : status === "running" || status === "blocked" || status === "recheck" ? "warning" : "dim";
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
  const text = status === "done" ? theme.fg("dim", strike(title, theme)) : theme.fg(status === "running" ? "accent" : "text", title);
  rows.push(clip(theme.fg("dim", branch) + theme.fg(color, glyph) + " " + theme.fg("dim", key) + text + theme.fg("dim", label)));
 }
 if (overflow && available > 0) rows.push(clip(theme.fg("dim", `… ${tasks.length - shown.length} more · /workflow-ui list`)));
 return rows;
}
