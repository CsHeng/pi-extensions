import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { goalParameters, type GoalView } from "./goal-contracts.ts";
import type { GoalStore } from "./goal-store.ts";
import { taskOutcome } from "./goal-state.ts";
export function goalReceipt(view: GoalView, limit = 100): string {
 if (view.unavailable) return view.unavailable;
 const state = view.state;
 if (!state) return "No task list. Tracking is optional.";
 const ordered = limit < state.tasks.length ? [...state.tasks].sort((a, b) => Number(["done", "cancelled"].includes(a.status)) - Number(["done", "cancelled"].includes(b.status))) : state.tasks;
 const rows = ordered.slice(0, limit).map(task => task.id + " [" + task.status + "] " + task.title.slice(0, 200) + (task.note ? " — " + task.note.slice(0, 300) : ""));
 return ["Tasks: " + state.goal.slice(0, 500) + " (" + taskOutcome(state) + ")", ...(state.reason ? [state.reason.slice(0, 300)] : []), ...rows,
  ...(state.tasks.length > limit ? [String(state.tasks.length - limit) + " more tasks; inspect for the full list."] : []),
  ...(view.observation ? ["Last observed tool: " + view.observation.tool + " (" + (view.observation.failed ? "failed" : "returned") + "); this does not update task completion."] : [])].join("\n");
}
export function registerGoalTool(pi: ExtensionAPI, store: GoalStore, fenced: () => boolean) {
 pi.registerTool({
  name: "csheng_workflow", label: "Task tracking",
  description: "Optional Pi task list for tracking, focus and recovery; works with any Skills or without Skills. set(goal,tasks) replaces the list explicitly; new tasks need id/title and default to todo. update(tasks, optional goal) patches existing tasks by id; statuses are todo, doing, blocked, done, cancelled. blocked needs a note; note:null clears it. inspect reads current tasks; pause(reason), resume and cancel control reminders. Recovered lists start paused. You own task meaning, completion and the user's actual requirements. Mark done from your judgment without facts, attempts, review or test receipts. Revise or remove unnecessary model-derived steps using set. Tracking adds no tests, reviews, delivery obligations or permission. Tool results are observations, not automatic task completion. Record meaningful progress when useful; do not repeat completed work to repair tracking. Cancelled work stays distinct from done. Automatic reminders stop after an unchanged list; real task updates or new user input permit another reminder.",
  parameters: goalParameters,
  async execute(_id, params, signal) {
   const result = store.mutate(params, { ...(signal ? { signal } : {}), fenced });
   return { content: [{ type: "text", text: [result.message, goalReceipt(result.view)].filter(Boolean).join("\n") }], details: result, isError: !result.ok };
  },
 });
}
