import type { LoopFacts, LoopTaskSnapshot } from "../shared/loop-facts.ts";

export type DeliveryKind = "notices" | "reminder";

export interface PendingNotice {
	producer: "retained-shell" | "subagents";
	id: string;
	summary: string;
}

export interface DeliveryDecision {
	kind: DeliveryKind | "none";
	text: string;
	notices: PendingNotice[];
	reminderSignature: string | null;
}

export interface DeliveryView {
	facts: ReadonlyMap<string, LoopFacts>;
	/** Producers that have replied. A missing producer is absent, not unknown. */
	seen: ReadonlySet<string>;
	consumed: ReadonlySet<string>;
	suppressed: ReadonlySet<string>;
	remindedSignature: string | null;
}

const EXECUTION_PRODUCERS = ["retained-shell", "subagents"] as const;

export function noticeKey(producer: string, id: string): string {
	return producer + ":" + id;
}

/** Actionable identity. Notes are excluded so a note-only update cannot renew a consumed opportunity. */
export function reminderSignature(tasks: LoopTaskSnapshot): string {
	const actionable = tasks.tasks.filter(task => task.status === "todo" || task.status === "doing");
	return JSON.stringify([tasks.goal, tasks.paused, tasks.cancelled, actionable.map(task => [task.id, task.title, task.status])]);
}

export function reminderText(tasks: LoopTaskSnapshot): string {
	const rows = tasks.tasks.filter(task => task.status === "todo" || task.status === "doing")
		.map(task => "- [" + task.status + "] " + task.id + ": " + task.title);
	return [
		"Continue the tracked work under the user's current instructions: review newly available results, advance independent work, and revise unnecessary inferred steps. Update task status when your assessment of the work changes. If only running executions remain, leave tasks unfinished and finish the model turn for their completion event. This reminder adds no requirements or authority; completion and acceptance remain your evidence-based judgment, not an automatic consequence of tool results.",
		"Goal: " + tasks.goal,
		...rows,
	].join("\n");
}

function executionFacts(view: DeliveryView, producer: "retained-shell" | "subagents"): LoopFacts | undefined {
	return view.seen.has(producer) ? view.facts.get(producer) : undefined;
}

/** Unknown or unavailable execution state is not evidence of zero executions. Absent and inactive are. */
export function executionStateUnknown(view: DeliveryView): boolean {
	return EXECUTION_PRODUCERS.some(producer => {
		if (!view.seen.has(producer)) return false;
		const facts = view.facts.get(producer);
		return !facts || facts.availability === "unknown" || facts.availability === "unavailable";
	});
}

export function unfinishedExecutions(view: DeliveryView): boolean {
	if (executionStateUnknown(view)) return true;
	return EXECUTION_PRODUCERS.some(producer => {
		const facts = executionFacts(view, producer);
		if (!facts || facts.availability === "inactive") return false;
		return facts.executions.some(execution => execution.phase !== "terminal");
	});
}

export function pendingNotices(view: DeliveryView): PendingNotice[] {
	const notices: PendingNotice[] = [];
	for (const producer of EXECUTION_PRODUCERS) {
		const facts = executionFacts(view, producer);
		if (!facts || facts.availability !== "ready") continue;
		for (const execution of facts.executions) {
			if (execution.phase !== "terminal" || execution.disposition !== "pending" || !execution.summary) continue;
			const key = noticeKey(producer, execution.id);
			if (view.consumed.has(key) || view.suppressed.has(key)) continue;
			notices.push({ producer, id: execution.id, summary: execution.summary });
		}
	}
	return notices;
}

export function canRemind(view: DeliveryView): boolean {
	const workflow = view.seen.has("workflow") ? view.facts.get("workflow") : undefined;
	if (!workflow || workflow.availability !== "ready" || !workflow.tasks) return false;
	const tasks = workflow.tasks;
	if (tasks.paused || tasks.cancelled) return false;
	if (!tasks.tasks.some(task => task.status === "todo" || task.status === "doing")) return false;
	if (unfinishedExecutions(view) || pendingNotices(view).length > 0) return false;
	return view.remindedSignature !== reminderSignature(tasks);
}

/**
 * One decision. Notices are delivered even while other executions remain.
 * A task-list renewal is separate and only when nothing unfinished or unknown remains.
 * `project` never starts a reminder; settlement does.
 */
export function decideDelivery(view: DeliveryView, reason: "project" | "settle"): DeliveryDecision {
	const notices = pendingNotices(view);
	if (notices.length > 0) {
		return { kind: "notices", text: notices.map(notice => notice.summary.trim()).join("\n"), notices, reminderSignature: null };
	}
	if (reason === "settle" && canRemind(view)) {
		const tasks = view.facts.get("workflow")!.tasks!;
		return { kind: "reminder", text: reminderText(tasks), notices: [], reminderSignature: reminderSignature(tasks) };
	}
	return { kind: "none", text: "", notices: [], reminderSignature: null };
}
