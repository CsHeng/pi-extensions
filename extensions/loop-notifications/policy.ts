import type { LoopFacts } from "../shared/loop-facts.ts";

export interface PendingNotice {
	producer: "retained-shell" | "subagents";
	id: string;
	summary: string;
}

export interface DeliveryDecision {
	kind: "notices" | "none";
	text: string;
	notices: PendingNotice[];
}

export interface DeliveryView {
	facts: ReadonlyMap<string, LoopFacts>;
	/** Producers that have replied. A missing producer is absent, not unknown. */
	seen: ReadonlySet<string>;
	consumed: ReadonlySet<string>;
	suppressed: ReadonlySet<string>;
}

const EXECUTION_PRODUCERS = ["retained-shell", "subagents"] as const;

export function noticeKey(producer: string, id: string): string {
	return producer + ":" + id;
}

export function pendingNotices(view: DeliveryView): PendingNotice[] {
	const notices: PendingNotice[] = [];
	for (const producer of EXECUTION_PRODUCERS) {
		const facts = view.seen.has(producer) ? view.facts.get(producer) : undefined;
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

/** Deliver actual results even while siblings run. Task state alone never starts a model turn. */
export function decideDelivery(view: DeliveryView): DeliveryDecision {
	const notices = pendingNotices(view);
	if (notices.length > 0) {
		return { kind: "notices", text: notices.map(notice => notice.summary.trim()).join("\n"), notices };
	}
	return { kind: "none", text: "", notices: [] };
}
