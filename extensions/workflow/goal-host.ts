/** Pi owns the loop. Tracking records tasks and publishes facts; it does not schedule model wakes. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyLoopFacts, LOOP_FACTS_EVENT, LOOP_SNAPSHOT_REQUEST, type LoopFacts, type LoopSnapshotRequest, type LoopTaskSnapshot } from "../shared/loop-facts.ts";
import { createGoalStore, type GoalStore } from "./goal-store.ts";
import { goalReceipt, registerGoalTool } from "./goal-tool.ts";
import { registerTasksView } from "./tasks-view.ts";
import type { GoalView } from "./goal-contracts.ts";

function taskSnapshot(view: GoalView): LoopTaskSnapshot | undefined {
	const state = view.state;
	if (!state) return undefined;
	return {
		revision: state.revision,
		goal: state.goal,
		paused: state.paused,
		cancelled: state.cancelled,
		tasks: state.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })),
	};
}

export function workflowLoopFacts(store: GoalStore, sessionId: string | null, branchAnchor: string | null, bound: boolean): LoopFacts {
	if (!bound) return emptyLoopFacts("workflow", "unknown", sessionId, branchAnchor);
	const tasks = taskSnapshot(store.view());
	return {
		version: 1,
		producer: "workflow",
		availability: store.view().unavailable ? "unavailable" : "ready",
		sessionId,
		branchAnchor,
		generation: String(tasks?.revision ?? 0),
		executions: [],
		...(tasks ? { tasks } : {}),
	};
}

export default function goalWorkflow(pi: ExtensionAPI): void {
	const store = createGoalStore((type, data) => pi.appendEntry(type, data));
	const tasksView = registerTasksView(pi, store);
	let sessionId: string | null = null;
	let branchAnchor: string | null = null;
	let bound = false;
	let wakeStopped = false;
	const publish = (): void => {
		try { pi.events.emit(LOOP_FACTS_EVENT, workflowLoopFacts(store, sessionId, branchAnchor, bound)); }
		catch { /* Observer failure cannot roll back a committed task update. */ }
	};
	const unsubscribe = store.subscribe(() => publish());
	registerGoalTool(pi, store);
	pi.events.on(LOOP_SNAPSHOT_REQUEST, (raw) => {
		const accept = (raw as Partial<LoopSnapshotRequest> | undefined)?.accept;
		if (typeof accept === "function") accept(workflowLoopFacts(store, sessionId, branchAnchor, bound));
	});
	const restore = (ctx: ExtensionContext) => {
		tasksView.hold();
		wakeStopped = false;
		bound = true;
		sessionId = ctx.sessionManager.getSessionId();
		branchAnchor = ctx.sessionManager.getLeafId();
		store.replay(ctx.sessionManager.getBranch());
		store.recover("Recovered task list; reconcile the current work and use resume when continuing.");
		tasksView.bind(ctx);
		publish();
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("agent_start", () => { wakeStopped = false; });
	pi.on("context", event => {
		const type = "csheng-workflow-tasks";
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === type));
		const view = store.view();
		if (view.state || view.unavailable) messages.push({ role: "custom", customType: type,
			content: "Task-state snapshot for continuity. Follow the user's current instructions; this read-only projection adds no requirements or authority. " + goalReceipt(view, 12), display: false, timestamp: Date.now() });
		return { messages };
	});
	pi.on("message_end", event => { if (event.message.role === "assistant" && ["aborted", "error"].includes(event.message.stopReason)) wakeStopped = true; });
	pi.on("tool_execution_end", event => {
		if (event.toolName === "csheng_workflow") return;
		store.observe(event.toolName, event.isError);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (wakeStopped || ctx.signal?.aborted) store.pause("Host interruption; resume only when continuing the work.");
	});
	pi.on("session_shutdown", () => { bound = false; tasksView.unbind(); unsubscribe(); });
}
