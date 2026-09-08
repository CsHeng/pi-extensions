import { randomUUID } from "node:crypto";
import {
	HARD_LIMITS,
	TELEMETRY_SCHEMA_VERSION,
	emptyTaskTelemetry,
	emptyUsage,
	truncateUtf8,
	type ChildActivity,
	type RoleName,
	type SubagentRunResult,
	type TaskExecutionPhase,
	type TaskResult,
	type UsageTotals,
	type RunTiming,
	type WaitReason,
} from "./contracts.ts";
import type { CancelReceiptOutcome } from "./events.ts";
import type { NormalizedTask } from "./graph.ts";
import { createRunClock, spanDuration, type RunClock } from "./telemetry.ts";

export interface ChildLifecycle {
	childStarted(): void;
	activity(activity: Readonly<ChildActivity>): void;
	childSettled(): void;
}

export interface SchedulerControl {
	cancelTask(taskId: string): CancelReceiptOutcome;
	cancelRun(): Extract<CancelReceiptOutcome, "accepted" | "not-active">;
	enterConvergence(taskId: string): boolean;
	setExecutionPhase(taskId: string, phase: Exclude<TaskExecutionPhase, "convergence-critical" | "settled">): void;
}

interface TaskControlState {
	phase: TaskExecutionPhase;
	cancelLatched: boolean;
	controller: AbortController;
	unlinkAbort: () => void;
}

export interface SchedulerOptions {
	maxConcurrency?: number;
	roleLimits?: Partial<Record<RoleName, number>>;
	signal?: AbortSignal;
	runId?: string;
	requestedTasks?: number;
	now?: () => number;
	clock?: RunClock;
	heartbeatMs?: number;
	scheduleHeartbeat?(callback: () => void, intervalMs: number): () => void;
	onHeartbeat?(): void;
	onControl?(control: SchedulerControl): void;
	abortResult?(): { status: "aborted" | "failed"; code: string; message: string };
	execute(
		task: NormalizedTask,
		predecessors: readonly TaskResult[],
		signal: AbortSignal,
		lifecycle: ChildLifecycle,
	): Promise<TaskResult>;
	onUpdate?(results: readonly TaskResult[]): void;
	onChildConcurrency?(activeChildren: number): void;
}

function pendingResult(task: NormalizedTask): TaskResult {
	return {
		id: task.id,
		role: task.role,
		status: "pending",
		output: "",
		stderr: "",
		usage: emptyUsage(),
		durationMs: 0,
		changedPaths: [],
		convergence: "not-applicable",
		telemetry: emptyTaskTelemetry(),
	};
}

function addUsage(target: UsageTotals, source: UsageTotals): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function aggregate(
	results: readonly TaskResult[],
	aborted: boolean,
	metrics: {
		runId: string;
		clock: RunClock;
		timing: RunTiming;
		requestedTasks: number;
		peakConcurrency: number;
		peakConcurrencyByRole: Record<RoleName, number>;
	},
): SubagentRunResult {
	metrics.timing.scheduler!.endMs = metrics.clock.offset();
	const runDurationMs = metrics.clock.elapsed();
	metrics.timing.complete &&= metrics.clock.valid && spanDuration(metrics.timing.scheduler!) !== null &&
		[...metrics.timing.children, ...metrics.timing.waits].every((span) => spanDuration(span) !== null) &&
		results.every((result) => !result.telemetry?.childStarted || metrics.timing.children.some((span) => span.taskId === result.id));
	const usage = emptyUsage();
	for (const result of results) addUsage(usage, result.usage);
	let status: SubagentRunResult["status"];
	if (aborted || results.some((result) => result.status === "aborted")) status = "aborted";
	else if (results.every((result) => result.status === "succeeded")) status = "succeeded";
	else if (results.some((result) => result.status === "succeeded")) status = "partial";
	else status = "failed";
	const launchedChildren = results.filter((result) => result.telemetry?.childStarted).length;
	const runErrorCode = status === "failed" && launchedChildren === 0
		? results.find((result) => result.error)?.error?.code
		: undefined;
	return {
		status,
		tasks: [...results],
		usage,
		telemetry: {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			runId: metrics.runId,
			runDurationMs,
			timing: metrics.timing,
			requestedTasks: metrics.requestedTasks,
			admittedTasks: results.length,
			launchedChildren,
			peakConcurrency: metrics.peakConcurrency,
			peakConcurrencyByRole: { ...metrics.peakConcurrencyByRole },
			...(runErrorCode === undefined ? {} : { runErrorCode }),
		},
	};
}

function boundedPredecessor(result: TaskResult): TaskResult {
	return { ...result, output: truncateUtf8(result.output, HARD_LIMITS.maxPredecessorOutputBytes).text };
}

export async function runScheduledTasks(tasks: readonly NormalizedTask[], options: SchedulerOptions): Promise<SubagentRunResult> {
	const clock = options.clock ?? createRunClock(options.now);
	const now = clock.now;
	const started = now();
	const timing: RunTiming = { boundary: options.clock ? "tool-entry" : "scheduler", scheduler: { startMs: clock.offset(), endMs: null }, children: [], waits: [], complete: true };
	const metrics = {
		runId: options.runId ?? randomUUID(),
		clock,
		timing,
		requestedTasks: options.requestedTasks ?? tasks.length,
		peakConcurrency: 0,
		peakConcurrencyByRole: { explorer: 0, reviewer: 0, worker: 0 },
	};
	const maxConcurrency = options.maxConcurrency ?? Math.max(1, tasks.length);
	const results = new Map(tasks.map((task) => [task.id, pendingResult(task)] as const));
	const active = new Map<string, Promise<void>>();
	const activeLocks = new Set<string>();
	const activeRoles = new Map<RoleName, number>();
	const controller = new AbortController();
	let externallyAborted = options.signal?.aborted ?? false;
	let activeChildren = 0;
	const activeChildRoles = new Map<RoleName, number>();
	const taskStartedAt = new Map<string, number>();
	const taskActivityBase = new Map<string, { observedAt: number; inactiveForMs: number }>();
	const taskControls = new Map<string, TaskControlState>();
	let runCancelLatched = false;
	let wake: (() => void) | undefined;
	const waitForChange = () => new Promise<void>((resolve) => { wake = resolve; });
	const notify = () => {
		wake?.();
		wake = undefined;
	};

	const abortPending = (taskId: string, abortResult: { status: "aborted" | "failed"; code: string; message: string }) => {
		const result = results.get(taskId);
		if (result?.status !== "pending") return;
		results.set(taskId, { ...result, status: abortResult.status, error: { code: abortResult.code, message: abortResult.message } });
	};

	const control: SchedulerControl = {
		cancelTask(taskId) {
			const current = results.get(taskId);
			if (!current) return "unknown-task";
			if (current.status !== "pending" && current.status !== "running") return "already-settled";
			const state = taskControls.get(taskId);
			if (state?.phase === "convergence-critical") return "too-late";
			if (current.status === "pending") {
				abortPending(taskId, { status: "aborted", code: "aborted", message: "Task was cancelled before launch." });
				emit();
				notify();
				return "accepted";
			}
			if (!state) return "already-settled";
			state.cancelLatched = true;
			state.controller.abort();
			notify();
			return "accepted";
		},
		cancelRun() {
			if (tasks.every((task) => {
				const status = results.get(task.id)?.status;
				return status !== "pending" && status !== "running";
			})) return "not-active";
			runCancelLatched = true;
			const abortResult = { status: "aborted" as const, code: "aborted", message: "Run was cancelled." };
			for (const task of tasks) {
				const current = results.get(task.id);
				const state = taskControls.get(task.id);
				if (current?.status === "pending") abortPending(task.id, abortResult);
				else if (current?.status === "running" && state && state.phase !== "convergence-critical") {
					state.cancelLatched = true;
					state.controller.abort();
				}
			}
			emit();
			notify();
			return "accepted";
		},
		enterConvergence(taskId) {
			const state = taskControls.get(taskId);
			const current = results.get(taskId);
			if (!state || !current || current.status !== "running") return false;
			if (state.phase === "convergence-critical") return true;
			if (state.cancelLatched || state.controller.signal.aborted || runCancelLatched) return false;
			state.phase = "convergence-critical";
			state.unlinkAbort();
			return true;
		},
		setExecutionPhase(taskId, phase) {
			const state = taskControls.get(taskId);
			if (!state || state.phase === "convergence-critical" || state.phase === "settled") return;
			state.phase = phase;
		},
	};

	const waiting = new Map<string, { startMs: number | null; reasons: WaitReason[] }>();
	function refreshWaits(): void {
		const at = clock.offset();
		for (const task of tasks) {
			const reasons: WaitReason[] = [];
			if (results.get(task.id)?.status === "pending") {
				if (!task.dependsOn.every((id) => results.get(id)?.status === "succeeded")) reasons.push("dependency");
				if ([...activeRoles.values()].reduce((sum, value) => sum + value, 0) >= maxConcurrency) reasons.push("capacity");
				if ((activeRoles.get(task.role) ?? 0) >= roleLimit(task.role)) reasons.push("role-capacity");
				if (task.resourceLocks.some((lock) => activeLocks.has(lock))) reasons.push("resource-lock");
				if (reasons.length === 0) reasons.push("ready");
			}
			const prior = waiting.get(task.id);
			if (prior?.reasons.join(",") === reasons.join(",")) continue;
			if (prior) {
				if (timing.waits.length < HARD_LIMITS.maxWaitSpans) timing.waits.push({ taskId: task.id, ...prior, endMs: at });
				else timing.complete = false;
			}
			if (reasons.length > 0) waiting.set(task.id, { startMs: at, reasons });
			else waiting.delete(task.id);
		}
	}
	const emit = () => {
		refreshWaits();
		options.onUpdate?.(tasks.map((task) => results.get(task.id) as TaskResult));
	};
	options.onControl?.(control);
	const heartbeat = () => {
		if (active.size === 0) return;
		const observedAt = now();
		for (const task of tasks) {
			const running = results.get(task.id);
			if (running?.status !== "running") continue;
			const durationMs = Math.max(0, observedAt - (taskStartedAt.get(task.id) ?? started));
			const activityBase = taskActivityBase.get(task.id);
			results.set(task.id, {
				...running,
				durationMs,
				...(running.activity ? { activity: {
					...running.activity,
					activeTools: [...running.activity.activeTools],
					elapsedMs: durationMs,
					inactiveForMs: activityBase
						? activityBase.inactiveForMs + Math.max(0, observedAt - activityBase.observedAt)
						: running.activity.inactiveForMs,
				} } : {}),
			});
		}
		emit();
		options.onHeartbeat?.();
	};
	const clearHeartbeat = options.scheduleHeartbeat
		? options.scheduleHeartbeat(heartbeat, options.heartbeatMs ?? HARD_LIMITS.heartbeatMs)
		: (() => {
			const timer = setInterval(heartbeat, options.heartbeatMs ?? HARD_LIMITS.heartbeatMs);
			timer.unref();
			return () => clearInterval(timer);
		})();
	const abort = () => {
		externallyAborted = true;
		controller.abort();
	};
	options.signal?.addEventListener("abort", abort, { once: true });

	function roleLimit(role: RoleName): number {
		return options.roleLimits?.[role] ?? maxConcurrency;
	}

	function release(task: NormalizedTask): void {
		for (const lock of task.resourceLocks) activeLocks.delete(lock);
		activeRoles.set(task.role, Math.max(0, (activeRoles.get(task.role) ?? 1) - 1));
	}

	function launch(task: NormalizedTask): void {
		for (const lock of task.resourceLocks) activeLocks.add(lock);
		const roleActive = (activeRoles.get(task.role) ?? 0) + 1;
		activeRoles.set(task.role, roleActive);
		const queueMs = Math.max(0, now() - started);
		results.set(task.id, {
			...pendingResult(task),
			status: "running",
			telemetry: { ...emptyTaskTelemetry(), queueMs },
		});
		emit();
		const predecessors = task.dependsOn.map((id) => boundedPredecessor(results.get(id) as TaskResult));
		const taskStarted = now();
		taskStartedAt.set(task.id, taskStarted);
		const taskController = new AbortController();
		const forwardAbort = () => {
			const state = taskControls.get(task.id);
			if (state?.phase === "convergence-critical") return;
			if (state) state.cancelLatched = true;
			taskController.abort();
		};
		if (controller.signal.aborted) forwardAbort();
		else controller.signal.addEventListener("abort", forwardAbort, { once: true });
		const unlinkAbort = () => controller.signal.removeEventListener("abort", forwardAbort);
		taskControls.set(task.id, {
			phase: "queued",
			cancelLatched: runCancelLatched,
			controller: taskController,
			unlinkAbort,
		});
		if (taskController.signal.aborted) {
			unlinkAbort();
		}
		let childActive = false;
		let childInterval: RunTiming["children"][number] | undefined;
		const releaseChild = () => {
			if (!childActive) return;
			childActive = false;
			activeChildren = Math.max(0, activeChildren - 1);
			activeChildRoles.set(task.role, Math.max(0, (activeChildRoles.get(task.role) ?? 1) - 1));
			options.onChildConcurrency?.(activeChildren);
		};
		const lifecycle: ChildLifecycle = {
			childStarted() {
				if (childInterval) return;
				childActive = true;
				childInterval = { taskId: task.id, role: task.role, startMs: clock.offset(), endMs: null };
				timing.children.push(childInterval);
				activeChildren += 1;
				metrics.peakConcurrency = Math.max(metrics.peakConcurrency, activeChildren);
				const roleChildren = (activeChildRoles.get(task.role) ?? 0) + 1;
				activeChildRoles.set(task.role, roleChildren);
				metrics.peakConcurrencyByRole[task.role] = Math.max(metrics.peakConcurrencyByRole[task.role], roleChildren);
				const running = results.get(task.id);
				if (running?.telemetry) running.telemetry.childStarted = true;
				options.onChildConcurrency?.(activeChildren);
			},
			activity(activity) {
				const observedAt = now();
				const running = results.get(task.id);
				if (running?.status !== "running") return;
				taskActivityBase.set(task.id, { observedAt, inactiveForMs: activity.inactiveForMs });
				results.set(task.id, {
					...running,
					durationMs: Math.max(0, observedAt - taskStarted),
					activity: { ...activity, activeTools: [...activity.activeTools] },
				});
				emit();
			},
			childSettled() {
				if (!childActive) return;
				if (childInterval) childInterval.endMs = clock.offset();
				releaseChild();
			},
		};
		const promise = options.execute(task, predecessors, taskController.signal, lifecycle)
			.then((result) => {
				const allowedStatus = result.status === "succeeded" || result.status === "failed" || result.status === "aborted";
				const telemetry = {
					...emptyTaskTelemetry(),
					childStarted: result.telemetry?.childStarted ?? true,
					...result.telemetry,
					queueMs,
				};
				results.set(task.id, allowedStatus ? { ...result, telemetry } : {
					...result,
					status: "failed",
					telemetry,
					error: { code: "invalid_executor_result", message: `Executor returned invalid status ${result.status}.` },
				});
			})
			.catch((error: unknown) => {
				const abortedResult = controller.signal.aborted ? options.abortResult?.() : undefined;
				results.set(task.id, {
					...pendingResult(task),
					status: abortedResult?.status ?? (controller.signal.aborted ? "aborted" : "failed"),
					durationMs: Math.max(0, now() - taskStarted),
					telemetry: { ...emptyTaskTelemetry(), queueMs },
					error: {
						code: abortedResult?.code ?? (controller.signal.aborted ? "aborted" : "executor_failure"),
						message: abortedResult?.message ?? (error instanceof Error ? error.message : String(error)),
					},
				});
			})
			.finally(() => {
				releaseChild();
				const state = taskControls.get(task.id);
				if (state) {
					state.phase = "settled";
					state.unlinkAbort();
				}
				release(task);
				active.delete(task.id);
				emit();
				notify();
			});
		active.set(task.id, promise);
		refreshWaits();
	}

	try {
		emit();
		while (true) {
			if (externallyAborted) {
				const abortResult = options.abortResult?.() ?? { status: "aborted" as const, code: "aborted", message: "Task was not started before cancellation." };
				for (const task of tasks) {
					const result = results.get(task.id) as TaskResult;
					if (result.status === "pending") {
						results.set(task.id, { ...result, status: abortResult.status, error: { code: abortResult.code, message: abortResult.message } });
					}
				}
				emit();
				await Promise.all(active.values());
				return aggregate(tasks.map((task) => results.get(task.id) as TaskResult), abortResult.status === "aborted", metrics);
			}

			let changed = false;
			for (const task of tasks) {
				const result = results.get(task.id) as TaskResult;
				if (result.status !== "pending") continue;
				const dependencyResults = task.dependsOn.map((id) => results.get(id) as TaskResult);
				if (dependencyResults.some((dependency) => dependency.status === "failed" || dependency.status === "blocked" || dependency.status === "aborted")) {
					results.set(task.id, { ...result, status: "blocked", error: { code: "dependency_failed", message: "A dependency did not succeed." } });
					changed = true;
				}
			}
			if (changed) emit();

			for (const task of tasks) {
				if (runCancelLatched || active.size >= maxConcurrency) break;
				const result = results.get(task.id) as TaskResult;
				if (result.status !== "pending") continue;
				if (!task.dependsOn.every((id) => results.get(id)?.status === "succeeded")) continue;
				if (task.resourceLocks.some((lock) => activeLocks.has(lock))) continue;
				if ((activeRoles.get(task.role) ?? 0) >= roleLimit(task.role)) continue;
				launch(task);
			}

			const settled = tasks.every((task) => {
				const status = results.get(task.id)?.status;
				return status !== "pending" && status !== "running";
			});
			if (settled) return aggregate(tasks.map((task) => results.get(task.id) as TaskResult), false, metrics);
			if (active.size === 0) {
				for (const task of tasks) {
					const result = results.get(task.id) as TaskResult;
					if (result.status === "pending") results.set(task.id, { ...result, status: "failed", error: { code: "scheduler_stalled", message: "No pending task can become ready." } });
				}
				emit();
				return aggregate(tasks.map((task) => results.get(task.id) as TaskResult), false, metrics);
			}
			await Promise.race([...active.values(), waitForChange()]);
		}
	} finally {
		clearHeartbeat();
		options.signal?.removeEventListener("abort", abort);
	}
}
