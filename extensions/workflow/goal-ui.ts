/** Default-visible read-only projection. It cannot enroll, mutate, resume or complete a contract. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalStore } from "./goal-store.ts";
import { goalRows } from "./goal-ui-render.ts";
export { goalRows } from "./goal-ui-render.ts";
export function registerGoalUi(pi: ExtensionAPI, store: GoalStore) {
 let ctx: ExtensionContext | undefined; let visible = true; let failed = false;
 const render = () => {
  if (!ctx || ctx.mode !== "tui" || !ctx.hasUI || failed) return;
  const view = store.view();
  const hasContract = view.state !== undefined || view.legacy !== undefined || view.unavailable !== undefined;
  try {
   ctx.ui.setWidget("csheng-workflow", visible && hasContract ? (tui) => ({
    render: (width: number) => [...goalRows(store.view(), Math.min(width, 120), Math.min(12, Math.max(1, Math.floor((tui?.terminal.rows || 36) / 3))), ctx?.ui.theme), ""],
    invalidate() {},
   }) : undefined, { placement: "aboveEditor" });
  }
  catch { failed = true; try { ctx.ui.setWidget("csheng-workflow", undefined); } catch { /* View only. */ } }
 };
 store.subscribe(render);
 pi.registerCommand("workflow-ui", {
  description: "Toggle the read-only implementation contract view (show/hide/list)",
  async handler(args, commandCtx) {
   ctx = commandCtx;
   if (ctx.mode !== "tui" || !ctx.hasUI) return;
   if (args.trim() === "list") { await ctx.ui.select("Tasks · workflow", goalRows(store.view(), 120, 66)); return; }
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
