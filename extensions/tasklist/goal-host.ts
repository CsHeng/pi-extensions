/** Pi owns the loop. Tasklist records model-managed items and publishes facts; it never schedules or gates work. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyLoopFacts, LOOP_FACTS_EVENT, LOOP_SNAPSHOT_REQUEST, type LoopFacts, type LoopSnapshotRequest, type LoopTaskSnapshot } from "../shared/loop-facts.ts";
import { createTasklistStore, type TasklistStore } from "./goal-store.ts";
import { registerTasklistTool, tasklistReceipt } from "./goal-tool.ts";
import { registerTasksView } from "./tasks-view.ts";
import type { TasklistView } from "./goal-contracts.ts";

function taskSnapshot(view: TasklistView): LoopTaskSnapshot | undefined {
	const state = view.state;
	if (!state) return undefined;
	// The shared fact contract is unchanged by this passive rename: the list title is reported as
	// `goal`, `paused` is always false because no pause exists, and `cancelled` reports item data.
	return {
		revision: state.revision,
		goal: state.title,
		paused: false,
		cancelled: state.tasks.length > 0 && state.tasks.every(task => task.status === "cancelled"),
		tasks: state.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })),
	};
}

export function workflowLoopFacts(store: TasklistStore, sessionId: string | null, branchAnchor: string | null, bound: boolean): LoopFacts {
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
	const store = createTasklistStore((type, data) => pi.appendEntry(type, data));
	const tasksView = registerTasksView(pi, store);
	let sessionId: string | null = null;
	let branchAnchor: string | null = null;
	let bound = false;
	const appendSnapshot = (retrying = false): void => {
		const view = store.view();
		if (!view.state && !view.unavailable) return;
		// Native custom messages remain at their original transcript position. A context
		// transform's temporary tail would move or disappear on the next request.
		pi.sendMessage({ customType: "csheng-workflow-tasks",
			content: "Task-state snapshot for continuity. Follow the user's current instructions; this read-only snapshot adds no requirements or authority. " + tasklistReceipt(view, 12), display: false },
			retrying ? { deliverAs: "steer" } : { triggerTurn: false });
	};
	const publish = (): void => {
		try { pi.events.emit(LOOP_FACTS_EVENT, workflowLoopFacts(store, sessionId, branchAnchor, bound)); }
		catch { /* Consumer failure cannot roll back a committed task edit. */ }
	};
	const unsubscribe = store.subscribe(() => publish());
	registerTasklistTool(pi, store);
	pi.events.on(LOOP_SNAPSHOT_REQUEST, (raw) => {
		const accept = (raw as Partial<LoopSnapshotRequest> | undefined)?.accept;
		if (typeof accept === "function") accept(workflowLoopFacts(store, sessionId, branchAnchor, bound));
	});
	const restore = (ctx: ExtensionContext) => {
		tasksView.hold();
		bound = true;
		sessionId = ctx.sessionManager.getSessionId();
		branchAnchor = ctx.sessionManager.getLeafId();
		// A restored branch is immediately usable data: known older snapshots are normalized in
		// memory and written in the current form only by the next explicit model edit.
		store.replay(ctx.sessionManager.getBranch());
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
	pi.on("session_shutdown", () => { bound = false; tasksView.unbind(); unsubscribe(); });
}
