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
export function registerGoalTool(pi: ExtensionAPI, store: GoalStore) {
 pi.registerTool({
  name: "csheng_workflow", label: "Task tracking",
  description: "Optionally track the current goal and tasks for focus and recovery, with or without Skills. set(goal,tasks) replaces the list; new tasks need id/title and default to todo. update(tasks, optional goal) patches existing tasks by id. Statuses are todo, doing, blocked, done and cancelled; blocked needs a note, and note:null clears it. inspect reads the list. Mark done when the work meets the user's completion criteria based on the available evidence; the tool requires no structured fact, attempt, review or test receipt. Revise or remove unnecessary inferred steps with set. When only running executions remain, leave tasks unfinished and finish the model turn so an execution event can resume work. Use blocked for a genuine obstacle. pause(reason), resume and cancel manage task tracking separately from shell and subagent execution; recovered lists start paused. Tool results inform your judgment rather than completing tasks automatically. Tracking records work, not additional requirements, verification obligations or permission. Cancelled work remains distinct from done.",
  parameters: goalParameters,
  async execute(_id, params, signal) {
   const result = store.mutate(params, signal ? { signal } : {});
   return { content: [{ type: "text", text: [result.message, goalReceipt(result.view)].filter(Boolean).join("\n") }], details: result, isError: !result.ok };
  },
 });
}
