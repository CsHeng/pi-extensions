/** Pi owns the loop. Tasklist records model-managed items and publishes facts; it never schedules or gates work. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyProducerFacts, EXECUTION_FACTS_EVENT, EXECUTION_FACTS_REQUEST, type ProducerFacts, type ProducerFactsRequest, type TaskFacts } from "../shared/execution-facts.ts";
import { createTasklistStore, type TasklistStore } from "./store.ts";
import { registerTasklistTool, tasklistReceipt } from "./tool.ts";
import { registerTasksView } from "./tasks-view.ts";
import type { TasklistView } from "./contracts.ts";

function taskSnapshot(view: TasklistView): TaskFacts | undefined {
	const state = view.state;
	if (!state) return undefined;
	return {
		revision: state.revision,
		title: state.title,
		tasks: state.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })),
	};
}

export function tasklistFacts(store: TasklistStore, sessionId: string | null, branchAnchor: string | null, bound: boolean): ProducerFacts {
	if (!bound) return emptyProducerFacts("tasklist", "unknown", sessionId, branchAnchor);
	const tasks = taskSnapshot(store.view());
	return {
		version: 1,
		producer: "tasklist",
		availability: store.view().unavailable ? "unavailable" : "ready",
		sessionId,
		branchAnchor,
		generation: String(tasks?.revision ?? 0),
		executions: [],
		...(tasks ? { tasks } : {}),
	};
}

export default function tasklist(pi: ExtensionAPI): void {
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
		pi.sendMessage({ customType: "tasklist.tasks",
			content: "Task-state snapshot for continuity. Follow the user's current instructions; this read-only snapshot adds no requirements or authority. " + tasklistReceipt(view, 12), display: false },
			retrying ? { deliverAs: "steer" } : { triggerTurn: false });
	};
	const publish = (): void => {
		try { pi.events.emit(EXECUTION_FACTS_EVENT, tasklistFacts(store, sessionId, branchAnchor, bound)); }
		catch { /* Consumer failure cannot roll back a committed task edit. */ }
	};
	const unsubscribe = store.subscribe(() => publish());
	registerTasklistTool(pi, store);
	pi.events.on(EXECUTION_FACTS_REQUEST, (raw) => {
		const accept = (raw as Partial<ProducerFactsRequest> | undefined)?.accept;
		if (typeof accept === "function") accept(tasklistFacts(store, sessionId, branchAnchor, bound));
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
