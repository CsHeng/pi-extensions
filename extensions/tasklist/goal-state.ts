import type { TasklistState, TasklistTaskStatus } from "./goal-contracts.ts";

export const unfinished = (state: TasklistState) => state.tasks.filter(task => !["done", "cancelled"].includes(task.status));

const SUMMARY_ORDER: readonly TasklistTaskStatus[] = ["doing", "blocked", "todo", "done", "cancelled"];

/** Derived item counts only. The list keeps no global engine state and this never changes item status. */
export function taskSummary(state: TasklistState): string {
	const counts = SUMMARY_ORDER
		.map(status => [status, state.tasks.filter(task => task.status === status).length] as const)
		.filter(([, count]) => count > 0)
		.map(([status, count]) => String(count) + " " + status);
	return counts.length ? counts.join(" · ") : "no items";
}
