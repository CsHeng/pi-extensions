import { randomUUID } from "node:crypto";

export type ExecutionRole = "worker" | "reviewer" | "explorer";
export interface ExecutionOwner { repository: string; sessionId: string; branchAnchor: string | null }
export type ExecutionPhase = "preparing" | "queued" | "running" | "completed" | "failed" | "cancelled";
export interface SupervisorLimits { concurrency: number; roles: Record<ExecutionRole, number>; maxRuns?: number }
export interface TaskExecution<R = unknown> {
	taskId: string; role: ExecutionRole; phase: ExecutionPhase;
	queuedAt: number; startedAt: number | null; finishedAt: number | null;
	result?: R; error?: { name: string; message: string };
}
export interface RunExecution<R = unknown> {
	runId: string; requestId: string; generation: string; owner: ExecutionOwner;
	phase: ExecutionPhase; submittedAt: number; preparedAt: number | null; finishedAt: number | null;
	tasks: TaskExecution[]; result?: R; error?: { name: string; message: string };
}
export interface SubmissionReceipt {
	kind: "submission"; status: "accepted"; runId: string; requestId: string;
	generation: string; owner: ExecutionOwner; replayed: boolean;
}
export interface ExecutionEvent {
	version: 1; eventId: string; kind: "task-terminal" | "run-terminal";
	generation: string; owner: ExecutionOwner; runId: string;
	task?: TaskExecution; run?: RunExecution;
}
export interface ExecutionContext {
	runId: string;
	signal: AbortSignal;
	/** Dependencies remain with the existing graph scheduler; this only leases shared capacity. */
	runTask<T>(task: { id: string; role: ExecutionRole; resourceLocks?: readonly string[] }, execute: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface Submission<P, R> {
	requestId: string;
	/** The caller's existing canonical request identity; no new content-hash protocol is introduced. */
	requestKey: string;
	prepare(signal: AbortSignal): Promise<P>;
	execute(prepared: P, context: ExecutionContext): Promise<R>;
}
export interface SupervisorHooks {
	/** Persists owner-tagged terminal facts, including cancellation during shutdown. Filter by owner before projecting to a current UI/workflow. */
	onEvent?(event: ExecutionEvent): void | Promise<void>;
	onWake?(events: readonly ExecutionEvent[]): void | Promise<void>;
	onDeliveryError?(error: unknown): void;
	now?(): number;
}
export class SupervisorError extends Error {
	readonly code: string;
	constructor(code: string) { super(code); this.name = "SupervisorError"; this.code = code; }
}
interface Ticket { role: ExecutionRole; locks: string[]; signal: AbortSignal; resolve(release: () => void): void; reject(error: unknown): void; abort(): void }
/** One shared capacity owner across submissions. No model loop, timer polling, or semantic DAG. */
class Capacity {
	private active = 0;
	private byRole: Record<ExecutionRole, number> = { worker: 0, reviewer: 0, explorer: 0 };
	private held = new Set<string>();
	private queue: Ticket[] = [];
	private limits: SupervisorLimits;
	constructor(limits: SupervisorLimits) { this.limits = structuredClone(limits); }
	acquire(role: ExecutionRole, locks: readonly string[], signal: AbortSignal): Promise<() => void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) { reject(new SupervisorError("execution_cancelled")); return; }
			const ticket: Ticket = { role, locks: [...new Set(locks)], signal, resolve, reject, abort: () => {} };
			ticket.abort = () => {
				const index = this.queue.indexOf(ticket);
				if (index < 0) return;
				this.queue.splice(index, 1); signal.removeEventListener("abort", ticket.abort);
				reject(new SupervisorError("execution_cancelled")); this.drain();
			};
			this.queue.push(ticket); signal.addEventListener("abort", ticket.abort, { once: true }); this.drain();
		});
	}
	private drain(): void {
		for (let index = 0; index < this.queue.length && this.active < this.limits.concurrency;) {
			const ticket = this.queue[index]!;
			if (this.byRole[ticket.role] >= this.limits.roles[ticket.role] || ticket.locks.some(lock => this.held.has(lock))) { index++; continue; }
			this.queue.splice(index, 1); ticket.signal.removeEventListener("abort", ticket.abort);
			this.active++; this.byRole[ticket.role]++; ticket.locks.forEach(lock => this.held.add(lock));
			let released = false;
			ticket.resolve(() => {
				if (released) return; released = true;
				this.active--; this.byRole[ticket.role]--; ticket.locks.forEach(lock => this.held.delete(lock)); this.drain();
			});
		}
	}
}
interface Entry {
	key: string;
	view: RunExecution;
	controller: AbortController;
	ready: Promise<void>;
	completion: Promise<void>;
	jobs: Set<Promise<unknown>>;
	cancelled: boolean;
}
const terminal = (phase: ExecutionPhase) => ["completed", "failed", "cancelled"].includes(phase);
function errorFact(error: unknown): { name: string; message: string } {
	return { name: error instanceof Error ? error.name : "Error", message: (error instanceof Error ? error.message : String(error)).slice(0, 2048) };
}

/** Session-local mechanical execution. Integrators persist outcomes before forwarding onWake to Pi. */
export class SessionExecutionSupervisor {
	private owner: ExecutionOwner;
	private generation = randomUUID();
	private entries = new Map<string, Entry>();
	private requests = new Map<string, Entry>();
	private capacity: Capacity;
	private limits: SupervisorLimits;
	private hooks: SupervisorHooks;
	private wakeEnabled = true;
	private closed = false;
	private notifications = new Map<string, ExecutionEvent>();
	private wakeScheduled = false;
	constructor(owner: ExecutionOwner, limits: SupervisorLimits, hooks: SupervisorHooks = {}) {
		if (!Number.isSafeInteger(limits.concurrency) || limits.concurrency < 1 || Object.values(limits.roles).length !== 3 || ["worker", "reviewer", "explorer"].some(role => !Number.isSafeInteger(limits.roles[role as ExecutionRole]) || limits.roles[role as ExecutionRole] < 1) || (limits.maxRuns !== undefined && (!Number.isSafeInteger(limits.maxRuns) || limits.maxRuns < 1))) throw new SupervisorError("invalid_capacity");
		this.owner = structuredClone(owner); this.limits = structuredClone(limits); this.hooks = hooks; this.capacity = new Capacity(limits);
	}
	private now(): number { return (this.hooks.now ?? (() => performance.now()))(); }
	get currentGeneration(): string { return this.generation; }
	get hasActiveWork(): boolean { return [...this.entries.values()].some(entry => !terminal(entry.view.phase)); }
	inspect(runId?: string): RunExecution[] { return structuredClone(runId ? (this.entries.has(runId) ? [this.entries.get(runId)!.view] : []) : [...this.entries.values()].map(entry => entry.view)); }
	/** The tool signal only owns admission/preparation, not execution after the receipt is returned. */
	async submit<P, R>(submission: Submission<P, R>, signal?: AbortSignal): Promise<SubmissionReceipt> {
		if (this.closed) throw new SupervisorError("supervisor_closed");
		if (!submission.requestId || !submission.requestKey || submission.requestId.length > 128 || submission.requestKey.length > 4096) throw new SupervisorError("invalid_request_identity");
		const replay = this.requests.get(submission.requestId);
		if (replay) {
			if (replay.key !== submission.requestKey) throw new SupervisorError("request_id_conflict");
			await replay.ready; return this.receipt(replay, true);
		}
		if (this.entries.size >= (this.limits.maxRuns ?? 256)) throw new SupervisorError("session_run_limit");
		const controller = new AbortController();
		let readyResolve!: () => void; let readyReject!: (error: unknown) => void;
		const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
		// Keep failed preparations inspectable without an unhandled rejection before a replay arrives.
		void ready.catch(() => {});
		const entry: Entry = { key: submission.requestKey, controller, ready, completion: Promise.resolve(), jobs: new Set(), cancelled: false,
			view: { runId: randomUUID(), requestId: submission.requestId, generation: this.generation, owner: structuredClone(this.owner), phase: "preparing", submittedAt: this.now(), preparedAt: null, finishedAt: null, tasks: [] } };
		this.entries.set(entry.view.runId, entry); this.requests.set(submission.requestId, entry);
		const cancelPreparation = () => { entry.cancelled = true; controller.abort(); };
		signal?.addEventListener("abort", cancelPreparation, { once: true });
		if (signal?.aborted) cancelPreparation();
		let prepared!: P;
		const preparation = (async () => {
			try {
				controller.signal.throwIfAborted(); prepared = await submission.prepare(controller.signal); controller.signal.throwIfAborted();
				entry.view.preparedAt = this.now(); entry.view.phase = "queued"; readyResolve();
			} catch (error) {
				entry.view.phase = controller.signal.aborted ? "cancelled" : "failed"; entry.view.error = errorFact(error); entry.view.finishedAt = this.now();
				readyReject(error); await this.event(entry, "run-terminal"); throw error;
			} finally { signal?.removeEventListener("abort", cancelPreparation); }
		})();
		entry.completion = preparation.then(() => this.execute(entry, () => submission.execute(prepared, {
			runId: entry.view.runId, signal: controller.signal,
			runTask: (task, execute) => this.task(entry, task, execute),
		}))).catch(() => {});
		await ready; return this.receipt(entry, false);
	}
	private receipt(entry: Entry, replayed: boolean): SubmissionReceipt {
		return { kind: "submission", status: "accepted", runId: entry.view.runId, requestId: entry.view.requestId, generation: entry.view.generation, owner: structuredClone(entry.view.owner), replayed };
	}
	private async execute<R>(entry: Entry, execute: () => Promise<R>): Promise<void> {
		try {
			entry.controller.signal.throwIfAborted(); entry.view.phase = "running";
			entry.view.result = await execute();
			// A caller that forgets to await a started task cannot settle its run prematurely.
			while (entry.jobs.size) await Promise.allSettled([...entry.jobs]);
			entry.view.phase = entry.controller.signal.aborted ? "cancelled" : entry.view.tasks.some(task => task.phase === "failed") ? "failed" : "completed";
		} catch (error) {
			entry.view.error = errorFact(error);
			const cancelled = entry.cancelled || entry.controller.signal.aborted;
			entry.controller.abort(); while (entry.jobs.size) await Promise.allSettled([...entry.jobs]);
			entry.view.phase = cancelled ? "cancelled" : "failed";
		} finally {
			entry.view.finishedAt = this.now(); await this.event(entry, "run-terminal");
		}
	}
	private task<T>(entry: Entry, task: { id: string; role: ExecutionRole; resourceLocks?: readonly string[] }, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (entry.view.phase !== "running") return Promise.reject(new SupervisorError("run_not_active"));
		if (!task.id || task.id.length > 128 || !["worker", "reviewer", "explorer"].includes(task.role) || entry.view.tasks.some(item => item.taskId === task.id) || (task.resourceLocks ?? []).some(lock => !lock || lock.length > 256)) return Promise.reject(new SupervisorError("invalid_task_identity"));
		const view: TaskExecution = { taskId: task.id, role: task.role, phase: "queued", queuedAt: this.now(), startedAt: null, finishedAt: null };
		entry.view.tasks.push(view);
		const job = (async () => {
			let release: (() => void) | undefined;
			try {
				release = await this.capacity.acquire(task.role, task.resourceLocks ?? [], entry.controller.signal);
				entry.controller.signal.throwIfAborted(); view.phase = "running"; view.startedAt = this.now();
				const result = await execute(entry.controller.signal); view.result = result;
				view.phase = entry.controller.signal.aborted ? "cancelled" : "completed";
				return result;
			} catch (error) { view.error = errorFact(error); view.phase = entry.controller.signal.aborted ? "cancelled" : "failed"; throw error; }
			finally { release?.(); view.finishedAt = this.now(); await this.event(entry, "task-terminal", view); }
		})();
		entry.jobs.add(job);
		// Keep rejected jobs observed even when a scheduler delays inspecting their result.
		void job.then(() => entry.jobs.delete(job), () => entry.jobs.delete(job));
		return job;
	}
	/** Join is explicit and can be used by one-shot/foreground hosts without a second executor. */
	async join(runId: string): Promise<RunExecution> {
		const entry = this.entries.get(runId); if (!entry) throw new SupervisorError("unknown_run");
		await entry.completion; return structuredClone(entry.view);
	}
	cancel(runId: string): boolean {
		const entry = this.entries.get(runId); if (!entry) throw new SupervisorError("unknown_run");
		if (terminal(entry.view.phase)) return false;
		entry.cancelled = true; entry.controller.abort();
		for (const [key, event] of this.notifications) if (event.runId === runId) this.notifications.delete(key);
		return true;
	}
	/** Use on an explicit parent abort/provider error, not on ordinary agent_end or compaction. */
	suppressWake(): void { this.wakeEnabled = false; this.notifications.clear(); }
	allowWake(): void { if (!this.closed) this.wakeEnabled = true; }
	private async event(entry: Entry, kind: ExecutionEvent["kind"], task?: TaskExecution): Promise<void> {
		// Retention is distinct from re-entry: an old/cancelled owner still has a terminal outcome.
		const event: ExecutionEvent = { version: 1, eventId: randomUUID(), kind, generation: entry.view.generation,
			owner: structuredClone(entry.view.owner), runId: entry.view.runId,
			...(task ? { task: structuredClone(task) } : { run: structuredClone(entry.view) }) };
		try { await this.hooks.onEvent?.(structuredClone(event)); } catch (error) { this.deliveryError(error); return; }
		if (this.closed || entry.view.generation !== this.generation) return;
		if (!this.wakeEnabled || entry.cancelled || (task ? task.phase : entry.view.phase) === "cancelled") return;
		// Task results already wake the parent; a successful run summary is not a second obligation.
		if (!task && entry.view.tasks.length && entry.view.phase === "completed") return;
		this.notifications.set(`${event.runId}:${task?.taskId ?? "run"}`, event);
		if (this.wakeScheduled) return; this.wakeScheduled = true;
		queueMicrotask(() => {
			this.wakeScheduled = false;
			const events = [...this.notifications.values()].filter(item => item.generation === this.generation); this.notifications.clear();
			if (this.closed || !this.wakeEnabled || !events.length) return;
			try { Promise.resolve(this.hooks.onWake?.(events)).catch(error => this.deliveryError(error)); } catch (error) { this.deliveryError(error); }
		});
	}
	private deliveryError(error: unknown): void { try { this.hooks.onDeliveryError?.(error); } catch { /* Diagnostics cannot alter execution facts. */ } }
	/** Synchronous fencing precedes cancellation; delayed old-owner outcomes cannot wake a new owner. */
	async replaceOwner(owner: ExecutionOwner): Promise<void> {
		if (this.closed) throw new SupervisorError("supervisor_closed");
		this.generation = randomUUID(); this.owner = structuredClone(owner); this.notifications.clear();
		const previous = [...this.entries.values()];
		for (const entry of previous) { entry.cancelled = true; entry.controller.abort(); }
		this.requests.clear(); this.entries.clear(); this.wakeEnabled = true;
		await Promise.allSettled(previous.map(entry => entry.completion));
	}
	/** Runner callbacks must honor cancellation / use their existing bounded process cleanup. */
	async shutdown(): Promise<void> {
		this.closed = true; this.suppressWake();
		for (const entry of this.entries.values()) { if (!terminal(entry.view.phase)) { entry.cancelled = true; entry.controller.abort(); } }
		await Promise.allSettled([...this.entries.values()].map(entry => entry.completion));
	}
}