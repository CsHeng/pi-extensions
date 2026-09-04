import { formatDuration } from "../subagents/render.ts";
import type { CancelReceiptV1, SnapshotV1 } from "../subagents/events.ts";

export const SUBAGENTS_UI_STATUS_KEY = "csheng.subagents.status";
export const SUBAGENTS_UI_PANEL_KEY = "csheng.subagents.panel";
export const SUBAGENTS_UI_ENTRY_TYPE = "csheng-subagents-run";
export const SUBAGENTS_UI_COMMAND = "subagents-ui";

export function formatStatus(snapshot: SnapshotV1): string {
	return `SA ${snapshot.activeChildren}/${snapshot.admittedTasks} active · ${snapshot.aggregateAssistantTurns} turns · ${formatDuration(snapshot.elapsedMs)}`;
}

export function formatPanel(snapshot: SnapshotV1): string[] {
	const lines = [formatStatus(snapshot)];
	for (const task of snapshot.tasks) {
		if (task.status !== "pending" && task.status !== "running") continue;
		const tools = task.activeTools.length > 0 ? ` ${task.activeTools.join(",")}` : "";
		lines.push(`${task.ordinal}. ${task.role} ${task.executionPhase}${tools} ${formatDuration(task.elapsedMs)}`);
	}
	const hidden = snapshot.admittedTasks - snapshot.tasks.length;
	if (hidden > 0) lines.push(`+${hidden} more`);
	return lines;
}

export function formatReceipt(receipt: CancelReceiptV1): string {
	return receipt.target === "task"
		? `cancel ${receipt.taskId ?? "task"}: ${receipt.outcome}`
		: `cancel run: ${receipt.outcome}`;
}

export interface SubagentsRunEntryData {
	version: 1;
	status: SnapshotV1["phase"];
	requestedTasks: number;
	admittedTasks: number;
	launchedChildren: number;
	settledTasks: number;
	aggregateAssistantTurns: number;
	elapsedMs: number;
	peakConcurrency: number;
	cancellationRequested: boolean;
}

export function entryFromSnapshot(snapshot: SnapshotV1): SubagentsRunEntryData {
	return {
		version: 1,
		status: snapshot.phase,
		requestedTasks: snapshot.requestedTasks,
		admittedTasks: snapshot.admittedTasks,
		launchedChildren: snapshot.launchedChildren,
		settledTasks: snapshot.settledTasks,
		aggregateAssistantTurns: snapshot.aggregateAssistantTurns,
		elapsedMs: snapshot.elapsedMs,
		peakConcurrency: snapshot.peakConcurrency,
		cancellationRequested: snapshot.cancellationRequested,
	};
}

export function formatEntry(data: SubagentsRunEntryData, expanded: boolean): string {
	const base = `Subagents ${data.status} ${data.settledTasks}/${data.admittedTasks} settled · ${data.aggregateAssistantTurns} turns · ${formatDuration(data.elapsedMs)}`;
	if (!expanded) return base;
	return `${base} · launched ${data.launchedChildren} peak ${data.peakConcurrency}${data.cancellationRequested ? " · cancel requested" : ""}`;
}
