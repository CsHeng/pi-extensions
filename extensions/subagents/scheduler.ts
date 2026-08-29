import {
	HARD_LIMITS,
	emptyUsage,
	truncateUtf8,
	type RoleName,
	type SubagentRunResult,
	type TaskResult,
	type UsageTotals,
} from "./contracts.ts";
import type { NormalizedTask } from "./graph.ts";

export interface SchedulerOptions {
	maxConcurrency?: number;
	roleLimits?: Partial<Record<RoleName, number>>;
	signal?: AbortSignal;
	execute(task: NormalizedTask, predecessors: readonly TaskResult[], signal: AbortSignal): Promise<TaskResult>;
	onUpdate?(results: readonly TaskResult[]): void;
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

function aggregate(results: readonly TaskResult[], aborted: boolean): SubagentRunResult {
	const usage = emptyUsage();
	for (const result of results) addUsage(usage, result.usage);
	let status: SubagentRunResult["status"];
	if (aborted || results.some((result) => result.status === "aborted")) status = "aborted";
	else if (results.every((result) => result.status === "succeeded")) status = "succeeded";
	else if (results.some((result) => result.status === "succeeded")) status = "partial";
	else status = "failed";
	return { status, tasks: [...results], usage };
}

function boundedPredecessor(result: TaskResult): TaskResult {
	return { ...result, output: truncateUtf8(result.output, HARD_LIMITS.maxPredecessorOutputBytes).text };
}

export async function runScheduledTasks(tasks: readonly NormalizedTask[], options: SchedulerOptions): Promise<SubagentRunResult> {
	const maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? HARD_LIMITS.maxConcurrency, HARD_LIMITS.maxConcurrency));
	const results = new Map(tasks.map((task) => [task.id, pendingResult(task)] as const));
	const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
	const active = new Map<string, Promise<void>>();
	const activeLocks = new Set<string>();
	const activeRoles = new Map<RoleName, number>();
	const controller = new AbortController();
	let externallyAborted = options.signal?.aborted ?? false;

	const emit = () => options.onUpdate?.(tasks.map((task) => results.get(task.id) as TaskResult));
	const abort = () => {
		externallyAborted = true;
		controller.abort();
	};
	options.signal?.addEventListener("abort", abort, { once: true });

	function roleLimit(role: RoleName): number {
		const configured = options.roleLimits?.[role];
		const hard = role === "worker" ? HARD_LIMITS.maxWorkers : HARD_LIMITS.maxConcurrency;
		return Math.max(1, Math.min(configured ?? hard, hard));
	}

	function release(task: NormalizedTask): void {
		for (const lock of task.resourceLocks) activeLocks.delete(lock);
		activeRoles.set(task.role, Math.max(0, (activeRoles.get(task.role) ?? 1) - 1));
	}

	function launch(task: NormalizedTask): void {
		for (const lock of task.resourceLocks) activeLocks.add(lock);
		activeRoles.set(task.role, (activeRoles.get(task.role) ?? 0) + 1);
		results.set(task.id, { ...pendingResult(task), status: "running" });
		emit();
		const predecessors = task.dependsOn.map((id) => boundedPredecessor(results.get(id) as TaskResult));
		const started = Date.now();
		const promise = options.execute(task, predecessors, controller.signal)
			.then((result) => {
				const allowedStatus = result.status === "succeeded" || result.status === "failed" || result.status === "aborted";
				results.set(task.id, allowedStatus ? result : {
					...result,
					status: "failed",
					error: { code: "invalid_executor_result", message: `Executor returned invalid status ${result.status}.` },
				});
			})
			.catch((error: unknown) => {
				results.set(task.id, {
					...pendingResult(task),
					status: controller.signal.aborted ? "aborted" : "failed",
					durationMs: Date.now() - started,
					error: {
						code: controller.signal.aborted ? "aborted" : "executor_failure",
						message: error instanceof Error ? error.message : String(error),
					},
				});
			})
			.finally(() => {
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
				for (const task of tasks) {
					const result = results.get(task.id) as TaskResult;
					if (result.status === "pending") {
						results.set(task.id, { ...result, status: "aborted", error: { code: "aborted", message: "Task was not started before cancellation." } });
					}
				}
				emit();
				await Promise.all(active.values());
				return aggregate(tasks.map((task) => results.get(task.id) as TaskResult), true);
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
			if (settled) return aggregate(tasks.map((task) => results.get(task.id) as TaskResult), false);
			if (active.size === 0) {
				for (const task of tasks) {
					const result = results.get(task.id) as TaskResult;
					if (result.status === "pending") results.set(task.id, { ...result, status: "failed", error: { code: "scheduler_stalled", message: "No pending task can become ready." } });
				}
				emit();
				return aggregate(tasks.map((task) => results.get(task.id) as TaskResult), false);
			}
			await Promise.race(active.values());
		}
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}
}
