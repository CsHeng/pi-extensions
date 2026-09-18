import type { ReduceResult, WorksetState } from "./contracts.ts";

const text = (value: string, limit = 1000): string => value.length > limit ? `${value.slice(0, limit - 1)}… [inspect for details]` : value;
const list = (items: string[]): string => items.length > 12 ? `${items.slice(0, 12).join(", ")}, +${items.length - 12} more (inspect)` : items.join(", ");

/** Only model-facing mutation receipts. The committed view remains available to host UI/details. */
export function renderMutationResult(operation: string, before: WorksetState | undefined, result: ReduceResult, notices: readonly string[] = []): string {
	if (!result.ok) {
		const revision = before?.revision;
		return [
			`workflow ${operation} rejected: ${result.code}${revision === undefined ? "" : ` at revision ${revision}`}: ${text(result.message, 2400)}`,
			...(result.deficits?.length ? [`deficits: ${list(result.deficits.map((d) => `${d.code}(${list(d.ids)})`))}`] : []),
		].join("\n");
	}
	const state = result.state;
	const lines = [`workflow ${operation} ok at revision ${state.revision}; ${state.workset.id} ${state.workset.disposition}${state.workset.closeOutcome ? ` (${state.workset.closeOutcome})` : ""}; alignment ${state.workset.alignment.state} generation ${state.workset.inputGeneration}`];
	if (result.mapping && Object.keys(result.mapping).length) lines.push(`allocated ids: ${list(Object.entries(result.mapping).map(([key, id]) => `${text(key, 80)}=${id}`))}`);
	for (const name of ["tasks", "criteria", "attempts", "evidence"] as const) {
		const changes: string[] = [];
		for (const [id, record] of Object.entries(state[name])) {
			if (record.worksetId !== state.workset.id) continue;
			const previous = before?.[name][id];
			if (previous && JSON.stringify(previous) === JSON.stringify(record)) continue;
			if (name === "tasks") {
				const task = state.tasks[id]!;
				changes.push(`${id} r${task.semanticRevision} ${task.disposition}${task.currentAttemptId ? ` attempt=${task.currentAttemptId}` : ""}`);
			} else if (name === "criteria") changes.push(`${id} r${state.criteria[id]!.semanticRevision} ${state.criteria[id]!.disposition}`);
			else if (name === "attempts") changes.push(`${id} ${state.attempts[id]!.state}`);
			else {
				const evidence = state.evidence[id]!;
				changes.push(`${id} ${evidence.subject.kind}:${evidence.subject.id} ${evidence.check.result}/${evidence.freshness}`);
			}
		}
		if (changes.length) lines.push(`${name}: ${list(changes)}`);
	}
	if (state.workset.alignment.deliveryUnavailable && !before?.workset.alignment.deliveryUnavailable) lines.push("Input origin unconfirmed; alignment grants no authority or review credit.");
	for (const notice of [...notices, ...(result.notice ? [result.notice] : [])].slice(0, 4)) lines.push(text(notice, 300));
	if (notices.length > 4) lines.push("Additional notices omitted; inspect for details.");
	return lines.join("\n");
}
