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
	const appendSnapshot = (retrying = false): void => {
		const view = store.view();
		if (!view.state && !view.unavailable) return;
		delete view.observation; // Ephemeral tool telemetry is not recovery state.
		// Native custom messages remain at their original transcript position. A context
		// transform's temporary tail would move or disappear on the next request.
		pi.sendMessage({ customType: "csheng-workflow-tasks",
			content: "Task-state snapshot for continuity. Follow the user's current instructions; this read-only snapshot adds no requirements or authority. " + goalReceipt(view, 12), display: false },
			retrying ? { deliverAs: "steer" } : { triggerTurn: false });
	};
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
		appendSnapshot();
		tasksView.bind(ctx);
		publish();
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", event => {
		// Overflow already has a host-owned retry. Join its native input queue so the
		// snapshot precedes that request; otherwise append without starting a turn.
		appendSnapshot(event.willRetry);
	});
	pi.on("agent_start", () => { wakeStopped = false; });
	pi.on("message_end", event => {
		if (event.message.role !== "assistant") return;
		if (["aborted", "error"].includes(event.message.stopReason)) wakeStopped = true;
	});
	pi.on("tool_execution_end", event => {
		if (event.toolName === "csheng_workflow") return;
		store.observe(event.toolName, event.isError);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!wakeStopped && !ctx.signal?.aborted) return;
		const revision = store.current()?.revision;
		const paused = store.pause("Host interruption; resume only when continuing the work.");
		if (paused?.ok && paused.view.state?.revision !== revision) appendSnapshot();
	});
	pi.on("session_shutdown", () => { bound = false; tasksView.unbind(); unsubscribe(); });
}
