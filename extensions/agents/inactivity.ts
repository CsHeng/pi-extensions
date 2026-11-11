import { mintProductId } from "./identity.ts";
import { formatDuration } from "./render.ts";
import type { ChildActivity } from "./contracts.ts";
import { noticeExecutionId, type ExecutionCheckpoint } from "../shared/execution-facts.ts";

export const AGENT_INACTIVITY_CHECKPOINT_MS = 10 * 60 * 1_000;
export type ScheduleCheckpoint = (callback: () => void, delayMs: number) => () => void;
export const scheduleCheckpoint: ScheduleCheckpoint = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs); timer.unref?.();
	return () => clearTimeout(timer);
};
interface Watch {
	runId: string; handle: string; label: string; lastActivityAt: number;
	calls: string; checkpoint?: ExecutionCheckpoint; clearTimer?: () => void;
}

/** Session-owned attention checkpoints. Observation changes delivery, never execution. */
export class AgentInactivityCheckpoints {
	private readonly watches = new Map<string, Watch>();
	constructor(private readonly now: () => number, private readonly publish: () => void, private readonly schedule: ScheduleCheckpoint = scheduleCheckpoint) {}
	start(runId: string, handle: string, label: string): void {
		const id = `${runId}:${handle}`;
		this.stop(runId, handle);
		const watch: Watch = { runId, handle, label, lastActivityAt: this.now(), calls: "" };
		this.watches.set(id, watch); this.arm(watch);
	}
	activity(runId: string, handle: string, activity: Readonly<ChildActivity>): void {
		const watch = this.watches.get(`${runId}:${handle}`); if (!watch) return;
		watch.calls = (activity.calls ?? []).slice(0, 4).map(call => `${call.tool} ${call.status}${call.summary ? ` ${call.summary.slice(0, 160)}` : ""}`).join("; ") || activity.activeTools.join(", ");
		const lastActivityAt = this.now() - activity.inactiveForMs;
		if (lastActivityAt <= watch.lastActivityAt) return;
		watch.lastActivityAt = lastActivityAt;
		const hadCheckpoint = !!watch.checkpoint;
		delete watch.checkpoint; watch.clearTimer?.(); this.arm(watch);
		if (hadCheckpoint) this.changed();
	}
	private arm(watch: Watch): void {
		const remaining = Math.max(0, AGENT_INACTIVITY_CHECKPOINT_MS - (this.now() - watch.lastActivityAt));
		watch.clearTimer = this.schedule(() => {
			delete watch.clearTimer;
			if (this.watches.get(`${watch.runId}:${watch.handle}`) !== watch || watch.checkpoint) return;
			const inactiveForMs = Math.max(0, this.now() - watch.lastActivityAt);
			if (inactiveForMs < AGENT_INACTIVITY_CHECKPOINT_MS) { this.arm(watch); return; }
			watch.checkpoint = { id: mintProductId(), disposition: "pending", summary: `Agent task ${watch.label} (handle ${watch.handle}) in run ${watch.runId}: inactive for ${formatDuration(inactiveForMs)}${watch.calls ? `; current tool calls: ${watch.calls}` : ""}; still running; it is not killed. Next actions: keep waiting, inspect, or cancel.` };
			this.changed();
		}, remaining);
	}
	checkpoint(runId: string, handle: string): ExecutionCheckpoint | undefined {
		const checkpoint = this.watches.get(`${runId}:${handle}`)?.checkpoint;
		return checkpoint ? { ...checkpoint } : undefined;
	}
	observe(handles: readonly string[]): void {
		const selected = new Set(handles);
		let changed = false;
		for (const watch of this.watches.values()) if (selected.has(watch.handle) && watch.checkpoint?.disposition === "pending") { watch.checkpoint.disposition = "observed"; changed = true; }
		if (changed) this.changed();
	}
	acknowledge(ids: readonly string[]): void {
		let changed = false;
		for (const id of ids) {
			const { executionId, checkpointId } = noticeExecutionId(id);
			const checkpoint = this.watches.get(executionId)?.checkpoint;
			if (checkpoint && checkpoint.id === checkpointId && checkpoint.disposition === "pending") { checkpoint.disposition = "observed"; changed = true; }
		}
		if (changed) this.changed();
	}
	private changed(): void { try { this.publish(); } catch { /* Observation cannot affect execution. */ } }
	stop(runId: string, handle?: string): void {
		for (const [id, watch] of this.watches) if (watch.runId === runId && (!handle || watch.handle === handle)) { watch.clearTimer?.(); this.watches.delete(id); }
	}
	clear(): void { for (const watch of this.watches.values()) watch.clearTimer?.(); this.watches.clear(); }
}
