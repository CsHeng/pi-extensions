import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tasklistParameters, type TasklistView } from "./goal-contracts.ts";
import type { TasklistStore } from "./goal-store.ts";
import { taskSummary } from "./goal-state.ts";

export function tasklistReceipt(view: TasklistView, limit = 100): string {
	if (view.unavailable) return view.unavailable;
	const state = view.state;
	if (!state) return "No task list. Tracking is optional.";
	const ordered = limit < state.tasks.length ? [...state.tasks].sort((a, b) => Number(["done", "cancelled"].includes(a.status)) - Number(["done", "cancelled"].includes(b.status))) : state.tasks;
	const rows = ordered.slice(0, limit).map(task => task.id + " [" + task.status + "] " + task.title.slice(0, 200) + (task.note ? " — " + task.note.slice(0, 300) : ""));
	return ["Tasklist: " + state.title.slice(0, 500) + " (" + taskSummary(state) + ")", ...rows,
		...(state.tasks.length > limit ? [String(state.tasks.length - limit) + " more items; inspect for the full list."] : [])].join("\n");
}

export function registerTasklistTool(pi: ExtensionAPI, store: TasklistStore) {
	pi.registerTool({
		name: "tasklist", label: "Tasklist",
		description: "Maintain the session's task list as plain data for focus and recovery, with or without Skills. set(title,tasks) starts or replaces the list; each new item needs id and title, status defaults to todo. update(title?,tasks) patches existing items by id. inspect reads the list. cancel marks every unfinished item cancelled without stopping anything. Statuses are todo, doing, blocked, done and cancelled; blocked needs a note describing the real blocker, and note:null clears it. Record done when the work meets the user's completion criteria based on the available evidence; the tool stores that judgment and never infers completion from other tool results. Revise or remove inferred steps with set as your understanding changes, and keep cancelled work distinct from completed work. Unfinished, blocked or cancelled items neither block nor continue a model turn, and the tool requires no structured fact, attempt, review or test receipt. Tracking records work, not additional requirements, verification obligations or permission.",
		parameters: tasklistParameters,
		async execute(_id, params, signal) {
			const result = store.mutate(params, signal ? { signal } : {});
			return { content: [{ type: "text", text: [result.message, tasklistReceipt(result.view)].filter(Boolean).join("\n") }], details: result, isError: !result.ok };
		},
	});
}
