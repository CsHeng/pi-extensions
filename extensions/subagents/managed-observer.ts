import { THINKING_LEVELS, type ThinkingLevel, type EffectiveRoute, type TaskResult } from "./contracts.ts";
import type { CurrentOwner } from "./session-contracts.ts";
import {
	OBSERVER_VERSION,
	observerHeadline,
	observerTools,
	parseObserverSnapshot,
	type ObserverSnapshot,
	type ObserverTask,
} from "./observer-events.ts";

export const OBSERVER_HEARTBEAT_MS = 5_000;
interface RowInput {
	id: string;
	role: ObserverTask["role"];
	episode: number;
	route?: EffectiveRoute;
	replayed: boolean;
	objective?: string;
}
function displayRoute(route: EffectiveRoute | undefined): ObserverTask["route"] {
	if (!route || !THINKING_LEVELS.includes(route.thinking as ThinkingLevel)
		|| [route.provider, route.model].some(value => !value || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(value))) return null;
	return { provider: route.provider, model: route.model, thinking: route.thinking as ThinkingLevel };
}

/** Ephemeral projection only. Never reads native storage or controls a child. */
export class ManagedObserver {
	private revision = 0;
	private phase: ObserverSnapshot["phase"] = "accepted";
	private rows: ObserverTask[];
	private readonly started = new Map<string, number | null>();
	private readonly active = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	readonly runId: string;
	private readonly owner: CurrentOwner;
	private readonly generation: string;
	private readonly elapsed: () => number | null;
	private readonly publish: (snapshot: ObserverSnapshot) => void;
	private readonly nextRevision: () => number;
	constructor(
		runId: string,
		owner: CurrentOwner,
		generation: string,
		input: readonly RowInput[],
		elapsed: () => number | null,
		publish: (snapshot: ObserverSnapshot) => void,
		nextRevision?: () => number,
	) {
		this.runId = runId; this.owner = owner; this.generation = generation;
		this.elapsed = elapsed; this.publish = publish;
		this.nextRevision = nextRevision ?? (() => ++this.revision);
		this.rows = input.map((row, index) => ({ id: row.id, ordinal: index + 1, role: row.role,
			episode: row.episode, route: displayRoute(row.route),
			status: "pending", executionPhase: "queued", assistantTurns: 0, elapsedMs: null, replayed: row.replayed,
			headline: observerHeadline(row.objective ?? ""), activeTools: [] }));
	}
	begin(): void {
		this.emit();
		this.timer = setInterval(() => this.emit(), OBSERVER_HEARTBEAT_MS);
		this.timer.unref?.();
	}
	childStarted(id: string): void {
		if (this.closed || this.started.has(id)) return;
		this.started.set(id, this.elapsed()); this.active.add(id); this.phase = "running";
		const row = this.rows.find(row => row.id === id);
		if (row) { row.status = "running"; row.executionPhase = "child-execution"; }
		this.emit();
	}
	childStopped(id: string): void {
		if (this.closed || !this.active.delete(id)) return;
		const row = this.rows.find(row => row.id === id);
		if (row) {
			row.elapsedMs = this.taskElapsed(id);
			row.activeTools = [];
		}
		if (this.active.size === 0) this.phase = "settling";
		this.emit();
	}
	update(results: readonly TaskResult[]): void {
		if (this.closed) return;
		this.rows = this.rows.map((row, index) => {
			const result = results[index];
			if (!result) return row;
			const terminal = result.status !== "running" && result.status !== "pending";
			// A cached result is evidence, never live child activity.
			if (row.replayed && !terminal) return row;
			const live = !terminal && !row.replayed && this.active.has(row.id);
			return { ...row, status: result.status,
				executionPhase: terminal ? "settled" : (this.active.has(row.id) ? "child-execution" : this.started.has(row.id) ? "convergence-critical" : result.status === "running" ? "workspace-preparation" : row.executionPhase),
				assistantTurns: result.activity?.assistantTurns ?? result.usage.turns,
				elapsedMs: row.replayed ? null : this.active.has(row.id) ? this.taskElapsed(row.id) : row.elapsedMs,
				activeTools: live ? (result.activity ? observerTools(result.activity.activeTools) : row.activeTools) : [] };
		});
		this.emit();
	}
	finish(failed: boolean, aborted: boolean): void {
		if (this.closed) return;
		if (this.timer) clearInterval(this.timer); this.timer = undefined;
		this.rows = this.rows.map(row => ({ ...row, activeTools: [],
			elapsedMs: row.replayed ? null : this.started.has(row.id) ? this.active.has(row.id) ? this.taskElapsed(row.id) : row.elapsedMs : null,
			...(["running", "pending"].includes(row.status) ? { status: aborted ? "aborted" as const : "failed" as const, executionPhase: "settled" as const } : {}),
		}));
		// A required final commit failure must not look like a wholly successful dispatch.
		if (failed && this.rows.every(row => row.status === "succeeded") && this.rows[0]) this.rows[0] = { ...this.rows[0], status: aborted ? "aborted" : "failed" };
		this.active.clear(); this.phase = "settled"; this.emit(); this.closed = true;
	}
	private taskElapsed(id: string): number | null {
		const now = this.elapsed(); const start = this.started.get(id);
		return now !== null && start != null && now >= start ? now - start : null;
	}
	private emit(): void {
		if (this.closed) return;
		const tasks = this.rows.map(row => ({ ...row, elapsedMs: this.active.has(row.id) ? this.taskElapsed(row.id) : row.elapsedMs }));
		const snapshot: ObserverSnapshot = { version: OBSERVER_VERSION, parentSessionId: this.owner.parentSessionId, anchor: this.owner.anchor,
			generation: this.generation, runId: this.runId, revision: this.nextRevision(), phase: this.phase,
			requestedTasks: tasks.length, admittedTasks: tasks.length, launchedChildren: this.started.size,
			activeChildren: this.active.size, settledTasks: tasks.filter(row => row.status !== "pending" && row.status !== "running").length,
			aggregateAssistantTurns: tasks.reduce((sum, row) => sum + row.assistantTurns, 0), elapsedMs: this.elapsed(), tasks };
		try { const parsed = parseObserverSnapshot(snapshot); if (parsed.ok) this.publish(parsed.value); } catch { /* Display failures cannot affect execution. */ }
	}
}
