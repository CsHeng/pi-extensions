import { randomUUID } from "node:crypto";
import {
	HARD_LIMITS,
	TELEMETRY_SCHEMA_VERSION,
	emptyTaskTelemetry,
	emptyUsage,
	roleConcurrencyCeiling,
	truncateUtf8,
	type ChildActivity,
	type RoleName,
	type SubagentRunResult,
	type TaskResult,
	type UsageTotals,
} from "./contracts.ts";
import type { NormalizedTask } from "./graph.ts";

export interface ChildLifecycle {
	childStarted(): void;
	activity(activity: Readonly<ChildActivity>): void;
	childSettled(): void;
}

export interface SchedulerOptions {
	maxConcurrency?: number;
	roleLimits?: Partial<Record<RoleName, number>>;
	signal?: AbortSignal;
	runId?: string;
	requestedTasks?: number;
	now?: () => number;
	heartbeatMs?: number;
	scheduleHeartbeat?(callback: () => void, intervalMs: number): () => void;
	onHeartbeat?(): void;
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
		started: number;
		now: () => number;
		requestedTasks: number;
		peakConcurrency: number;
		peakConcurrencyByRole: Record<RoleName, number>;
	},
): SubagentRunResult {
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
			runDurationMs: Math.max(0, metrics.now() - metrics.started),
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
	const now = options.now ?? Date.now;
	const started = now();
	const metrics = {
		runId: options.runId ?? randomUUID(),
		started,
		now,
		requestedTasks: options.requestedTasks ?? tasks.length,
		peakConcurrency: 0,
		peakConcurrencyByRole: { explorer: 0, reviewer: 0, worker: 0 },
	};
	const maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? HARD_LIMITS.maxConcurrency, HARD_LIMITS.maxConcurrency));
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

	const emit = () => options.onUpdate?.(tasks.map((task) => results.get(task.id) as TaskResult));
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
		const hard = roleConcurrencyCeiling(role);
		return Math.max(1, Math.min(options.roleLimits?.[role] ?? hard, hard));
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
		let childActive = false;
		const lifecycle: ChildLifecycle = {
			childStarted() {
				if (childActive) return;
				childActive = true;
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
				childActive = false;
				activeChildren = Math.max(0, activeChildren - 1);
				activeChildRoles.set(task.role, Math.max(0, (activeChildRoles.get(task.role) ?? 1) - 1));
				options.onChildConcurrency?.(activeChildren);
			},
		};
		const promise = options.execute(task, predecessors, controller.signal, lifecycle)
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
				lifecycle.childSettled();
				release(task);
				active.delete(task.id);
				emit();
			});
		active.set(task.id, promise);
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
				if (active.size >= maxConcurrency) break;
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
			await Promise.race(active.values());
		}
	} finally {
		clearHeartbeat();
		options.signal?.removeEventListener("abort", abort);
	}
}
