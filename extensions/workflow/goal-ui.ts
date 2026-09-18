/** Optional read-only projection. It cannot enroll, mutate, resume or complete a contract. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { accepted } from "./goal-state.ts";
import type { GoalView } from "./goal-contracts.ts";
import type { GoalStore } from "./goal-store.ts";
import { goalReceipt } from "./goal-tool.ts";

export function goalRows(view: GoalView, width: number, maxRows = 12): string[] {
 const s = view.state;
 const rows = [goalReceipt(view).split("\n")[0]!];
 if (s) for (const task of s.tasks) {
  const mark = accepted(s, `task:${task.key}`) ? "✓" : s.attempts.some(a => a.task === task.key && a.status === "running") ? "▶" : "·";
  rows.push(`${mark} ${task.title}`);
 }
 const bounded = rows.length > maxRows ? [...rows.slice(0, Math.max(1, maxRows - 1)), `… ${rows.length - maxRows + 1} more; /workflow-ui list`] : rows;
 return bounded.map(row => truncateToWidth(row.replace(/[\r\n\t\x00-\x1f\x7f]/g, " "), Math.max(1, width)));
}
export function registerGoalUi(pi: ExtensionAPI, store: GoalStore) {
 let ctx: ExtensionContext | undefined; let visible = false; let failed = false;
 const render = () => {
  if (!ctx || ctx.mode !== "tui" || !ctx.hasUI || failed) return;
  try { ctx.ui.setWidget("csheng-workflow", visible ? () => ({ render: (width: number) => goalRows(store.view(), width), invalidate() {} }) : undefined); }
  catch { failed = true; try { ctx.ui.setWidget("csheng-workflow", undefined); } catch { /* View only. */ } }
 };
 store.subscribe(render);
 pi.registerCommand("workflow-ui", {
  description: "Toggle the optional read-only implementation contract view (show/hide/list)",
  async handler(args, commandCtx) {
   ctx = commandCtx;
   if (ctx.mode !== "tui" || !ctx.hasUI) return;
   if (args.trim() === "list") { await ctx.ui.select("Implementation contract (read-only)", goalRows(store.view(), 120, 66)); return; }
   if (args.trim() === "show") visible = true;
   else if (args.trim() === "hide") visible = false;
   else visible = !visible;
   failed = false; render();
  },
 });
 return {
  attach(context: ExtensionContext) { ctx = context; failed = false; render(); },
  detach() { if (ctx?.mode === "tui" && ctx.hasUI) try { ctx.ui.setWidget("csheng-workflow", undefined); } catch { /* View only. */ } ctx = undefined; },
 };
}
