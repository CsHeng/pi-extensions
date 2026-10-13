import type { GoalState } from "./goal-contracts.ts";
export const unfinished = (state: GoalState) => state.tasks.filter(task => !["done", "cancelled"].includes(task.status));
export const actionable = (state: GoalState) => state.tasks.some(task => task.status === "todo" || task.status === "doing");
export function taskOutcome(state: GoalState): string {
 if (state.cancelled) return "cancelled";
 if (unfinished(state).length) return state.paused ? "paused" : actionable(state) ? "active" : "blocked";
 if (!state.tasks.length) return "empty";
 return state.tasks.every(task => task.status === "done") ? "done" : "closed with cancelled work";
}
