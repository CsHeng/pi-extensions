import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type TaskResult } from "../extensions/subagents/contracts.ts";
import { validateGraphRelationships, validateGraphStructure, type NormalizedTask } from "../extensions/subagents/graph.ts";
import { runScheduledTasks } from "../extensions/subagents/scheduler.ts";
import { createRunClock, workerIntervalTotals } from "../extensions/subagents/telemetry.ts";

function success(task: NormalizedTask, output = task.id): TaskResult {
	return {
		id: task.id,
		role: task.role,
		status: "succeeded",
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 1, turns: 1 },
		durationMs: 1,
		changedPaths: [],
		convergence: "not-applicable",
	};
}

function graph(tasks: Array<Record<string, unknown>>): NormalizedTask[] {
	const result = validateGraphStructure({ tasks } as never);
	assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
	return result.ok ? result.tasks : [];
}

test("v4 records serial child intervals and dependency waits on the parent clock", async () => {
	let now = 100;
	const clock = createRunClock(() => now);
	now = 120; // admission/preparation before scheduler entry
	const tasks = graph([
		{ id: "a", role: "worker", objective: "a", scope: ["."], writePaths: ["a"] },
		{ id: "b", role: "worker", objective: "b", scope: ["."], writePaths: ["b"], dependsOn: ["a"] },
	]);
	const result = await runScheduledTasks(tasks, {
		clock,
		execute: async (task, _predecessors, _signal, lifecycle) => {
			lifecycle.childStarted();
			now += 10;
			lifecycle.childSettled();
			return success(task);
		},
	});
	assert.equal(result.telemetry.runDurationMs, 40);
	assert.deepEqual(result.telemetry.timing?.scheduler, { startMs: 20, endMs: 40 });
	assert.deepEqual(result.telemetry.timing?.children.map(({ startMs, endMs }) => ({ startMs, endMs })), [
		{ startMs: 20, endMs: 30 }, { startMs: 30, endMs: 40 },
	]);
	assert.ok(result.telemetry.timing?.waits.some((span) => span.taskId === "b" && span.reasons.includes("dependency")));
	assert.deepEqual(workerIntervalTotals(result.telemetry.timing!), { effortMs: 20, occupiedMs: 20 });
});

test("v4 records overlapping slot and lock waits without interpreting provider queues", async () => {
	let now = 0;
	const tasks = graph([
		{ id: "a", role: "worker", objective: "a", scope: ["."], writePaths: ["a"], resourceLocks: ["fixture"] },
		{ id: "b", role: "worker", objective: "b", scope: ["."], writePaths: ["b"] },
		{ id: "c", role: "reviewer", objective: "c", scope: ["."], resourceLocks: ["fixture"] },
	]);
	const result = await runScheduledTasks(tasks, { maxConcurrency: 1, now: () => now,
		execute: async (task, _p, _s, lifecycle) => {
			lifecycle.childStarted();
			await Promise.resolve();
			now += 10;
			lifecycle.childSettled();
			return success(task);
		},
	});
	assert.ok(result.telemetry.timing?.waits.some((span) => span.taskId === "b" && span.reasons.includes("capacity") && span.reasons.includes("role-capacity") && span.endMs! > span.startMs!));
	assert.ok(result.telemetry.timing?.waits.some((span) => span.taskId === "c" && span.reasons.includes("resource-lock") && span.endMs! > span.startMs!));
	assert.deepEqual(workerIntervalTotals({ boundary: "scheduler", scheduler: null, complete: true, waits: [], children:
		[0, 1, 2].map((id) => ({ taskId: String(id), role: "worker", startMs: 0, endMs: 600000 })) }), { effortMs: 1800000, occupiedMs: 600000 });
	assert.deepEqual(workerIntervalTotals({ boundary: "scheduler", scheduler: null, complete: true, waits: [], children:
		[[0, 100], [50, 150], [200, 250]].map(([startMs, endMs], id) => ({ taskId: String(id), role: "worker", startMs: startMs!, endMs: endMs! })) }), { effortMs: 250, occupiedMs: 200 });
});

test("v4 marks unclosed child endpoints and backward clocks unavailable", async () => {
	const tasks = graph([{ id: "a", role: "worker", objective: "a", scope: ["."], writePaths: ["a"] }]);
	const unclosed = await runScheduledTasks(tasks, { execute: async (task, _p, _s, lifecycle) => { lifecycle.childStarted(); return success(task); } });
	assert.equal(unclosed.telemetry.timing?.children[0]?.endMs, null);
	assert.equal(unclosed.telemetry.timing?.complete, false);
	for (const invalidValue of [0, NaN, Infinity]) {
		let now = 10;
		const invalid = await runScheduledTasks(tasks, { now: () => now, execute: async (task) => { now = invalidValue; return success(task); } });
		assert.equal(invalid.telemetry.runDurationMs, null);
		assert.equal(invalid.telemetry.timing?.complete, false);
	}
});

test("canonical repository-relative writes stay contained and still conflict when overlapping", () => {
	const outsideScope = validateGraphRelationships(graph([
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["lib/a.ts"] },
	]));
	assert.equal(outsideScope.ok, false);
	if (outsideScope.ok) throw new Error("expected scope rejection");
	assert.equal(outsideScope.error.code, "write_outside_scope");
	assert.equal(validateGraphStructure({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/a.ts"] },
		{ id: "b", role: "worker", objective: "b", scope: ["src"], writePaths: ["src/a.ts"] },
	] }).ok, false);
	assert.equal(validateGraphRelationships(graph([
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/a.ts"] },
	])).ok, true);
	assert.equal(validateGraphRelationships(graph([
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/..config/a.ts"] },
	])).ok, true);
});

test("graph admission rejects cycles, unknown dependencies, role writes, and concurrent write overlap", () => {
	assert.equal(validateGraphStructure({ tasks: [
		{ id: "a", role: "explorer", objective: "a", scope: ["."], dependsOn: ["b"] },
		{ id: "b", role: "explorer", objective: "b", scope: ["."], dependsOn: ["a"] },
	] }).ok, false);
	assert.deepEqual(validateGraphStructure({ tasks: [
		{ id: "a", role: "explorer", objective: "a", scope: ["."], dependsOn: ["missing"] },
	] }), { ok: false, error: { code: "unknown_dependency", message: "Task a depends on unknown task missing." } });
	assert.equal(validateGraphStructure({ tasks: [
		{ id: "a", role: "reviewer", objective: "a", scope: ["."], writePaths: ["file.ts"] },
	] }).ok, false);
	assert.equal(validateGraphStructure({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/a.ts"] },
		{ id: "b", role: "worker", objective: "b", scope: ["src"], writePaths: ["src/a.ts"] },
	] }).ok, false);
});

test("graph admission rejects unknown semantic profiles before scheduling", () => {
	assert.deepEqual(validateGraphStructure({ tasks: [
		{ id: "a", role: "explorer", objective: "a", scope: ["."], executionProfile: "extreme" as never },
	] }), {
		ok: false,
		error: { code: "invalid_execution_profile", message: "Task a has an unsupported execution profile." },
	});
});

test("scheduler runs independent tasks concurrently and joins predecessors in stable order", async () => {
	const tasks = graph([
		{ id: "a", role: "explorer", objective: "a", scope: ["."] },
		{ id: "b", role: "explorer", objective: "b", scope: ["."] },
		{ id: "join", role: "reviewer", objective: "join", scope: ["."], dependsOn: ["a", "b"] },
	]);
	let active = 0;
	let peak = 0;
	const starts: string[] = [];
	const result = await runScheduledTasks(tasks, {
		async execute(task, predecessors, _signal, lifecycle) {
			starts.push(task.id);
			active += 1;
			lifecycle.childStarted();
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, task.id === "join" ? 1 : 15));
			active -= 1;
			lifecycle.childSettled();
			if (task.id === "join") assert.deepEqual(predecessors.map((item) => item.id), ["a", "b"]);
			return success(task);
		},
	});
	assert.equal(peak, 2);
	assert.deepEqual(starts, ["a", "b", "join"]);
	assert.equal(result.status, "succeeded");
	assert.equal(result.usage.turns, 3);
	assert.equal(result.telemetry.launchedChildren, 3);
	assert.equal(result.telemetry.peakConcurrency, 2);
});

test("resource locks serialize peers without reducing unrelated capacity", async () => {
	const tasks = graph([
		{ id: "a", role: "explorer", objective: "a", scope: ["."], resourceLocks: ["shared"] },
		{ id: "b", role: "explorer", objective: "b", scope: ["."], resourceLocks: ["shared"] },
		{ id: "c", role: "explorer", objective: "c", scope: ["."] },
	]);
	const running = new Set<string>();
	let lockOverlap = false;
	let peak = 0;
	await runScheduledTasks(tasks, {
		async execute(task) {
			running.add(task.id);
			peak = Math.max(peak, running.size);
			if (running.has("a") && running.has("b")) lockOverlap = true;
			await new Promise((resolve) => setTimeout(resolve, 5));
			running.delete(task.id);
			return success(task);
		},
	});
	assert.equal(lockOverlap, false);
	assert.equal(peak, 2);
});

test("failure blocks dependents while independent work succeeds", async () => {
	const tasks = graph([
		{ id: "bad", role: "explorer", objective: "bad", scope: ["."] },
		{ id: "blocked", role: "reviewer", objective: "blocked", scope: ["."], dependsOn: ["bad"] },
		{ id: "good", role: "explorer", objective: "good", scope: ["."] },
	]);
	const result = await runScheduledTasks(tasks, {
		async execute(task) {
			if (task.id === "bad") return { ...success(task), status: "failed", error: { code: "synthetic", message: "failed" } };
			return success(task);
		},
	});
	assert.equal(result.status, "partial");
	assert.deepEqual(result.tasks.map((item) => [item.id, item.status]), [
		["bad", "failed"],
		["blocked", "blocked"],
		["good", "succeeded"],
	]);
});

test("configured package defaults allow four explorers, four reviewers, and two workers", async () => {
	const tasks = graph([
		...Array.from({ length: 4 }, (_, index) => ({ id: `e${index}`, role: "explorer", objective: "e", scope: ["."] })),
		...Array.from({ length: 4 }, (_, index) => ({ id: `r${index}`, role: "reviewer", objective: "r", scope: ["."] })),
		...Array.from({ length: 2 }, (_, index) => ({ id: `w${index}`, role: "worker", objective: "w", scope: ["src"], writePaths: [`src/w${index}.ts`] })),
	]);
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let started = 0;
	let allStarted: (() => void) | undefined;
	const startedGate = new Promise<void>((resolve) => { allStarted = resolve; });
	const run = runScheduledTasks(tasks, {
		maxConcurrency: 10,
		roleLimits: { explorer: 4, reviewer: 4, worker: 2 },
		async execute(task, _predecessors, _signal, lifecycle) {
			started += 1;
			lifecycle.childStarted();
			if (started === 10) allStarted?.();
			await gate;
			lifecycle.childSettled();
			return success(task);
		},
	});
	await startedGate;
	release?.();
	const result = await run;
	assert.equal(result.telemetry.peakConcurrency, 10);
	assert.deepEqual(result.telemetry.peakConcurrencyByRole, { explorer: 4, reviewer: 4, worker: 2 });
	assert.equal(result.telemetry.launchedChildren, 10);
});

test("configured role concurrency above package defaults is bounded by global concurrency", async () => {
	const tasks = graph([
		...Array.from({ length: 4 }, (_, index) => ({ id: `w${index}`, role: "worker", objective: "w", scope: ["src"], writePaths: [`src/w${index}.ts`] })),
		...Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, role: "explorer", objective: "e", scope: ["."] })),
		{ id: "r0", role: "reviewer", objective: "r", scope: ["."] },
	]);
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let started = 0;
	let globalLimitReached: (() => void) | undefined;
	const globalLimitGate = new Promise<void>((resolve) => { globalLimitReached = resolve; });
	const run = runScheduledTasks(tasks, {
		maxConcurrency: 6,
		roleLimits: { explorer: 5, reviewer: 3, worker: 4 },
		async execute(task, _predecessors, _signal, lifecycle) {
			started += 1;
			lifecycle.childStarted();
			if (started === 6) globalLimitReached?.();
			await gate;
			lifecycle.childSettled();
			return success(task);
		},
	});
	await globalLimitGate;
	assert.equal(started, 6);
	release?.();
	const result = await run;
	assert.equal(result.telemetry.peakConcurrency, 6);
	assert.equal(result.telemetry.peakConcurrencyByRole.worker, 4);
	assert.equal(result.telemetry.launchedChildren, 10);
});

test("activity emits before settlement and injected heartbeat advances quiet evidence", async () => {
	const tasks = graph([{ id: "quiet", role: "explorer", objective: "quiet", scope: ["."] }]);
	let now = 0;
	let heartbeat: (() => void) | undefined;
	let cleared = false;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const updates: TaskResult[][] = [];
	const run = runScheduledTasks(tasks, {
		now: () => now,
		scheduleHeartbeat(callback, intervalMs) {
			assert.equal(intervalMs, 5_000);
			heartbeat = callback;
			return () => { cleared = true; };
		},
		onUpdate(results) { updates.push(results.map((result) => ({ ...result }))); },
		async execute(task, _predecessors, _signal, lifecycle) {
			lifecycle.childStarted();
			lifecycle.activity({ phase: "running", assistantTurns: 1, activeTools: ["read"], latestEventType: "tool_execution_start", errorObserved: false, errorCount: 0, agentEndObserved: false, agentSettledObserved: false, elapsedMs: 0, inactiveForMs: 0 });
			await gate;
			lifecycle.childSettled();
			return success(task);
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(updates.some((snapshot) => snapshot[0]?.activity?.activeTools[0] === "read"));
	now = 5_000;
	heartbeat?.();
	assert.equal(updates.at(-1)?.[0]?.durationMs, 5_000);
	assert.equal(updates.at(-1)?.[0]?.activity?.inactiveForMs, 5_000);
	release?.();
	await run;
	assert.equal(cleared, true);
});

test("abort stops pending work and forwards one signal to running tasks", async () => {
	const tasks = graph([
		{ id: "a", role: "explorer", objective: "a", scope: ["."] },
		{ id: "b", role: "explorer", objective: "b", scope: ["."] },
		{ id: "c", role: "explorer", objective: "c", scope: ["."] },
	]);
	const controller = new AbortController();
	let observed = 0;
	const promise = runScheduledTasks(tasks, {
		maxConcurrency: 1,
		signal: controller.signal,
		async execute(task, _predecessors, signal) {
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					observed += 1;
					resolve();
				}, { once: true });
			});
			return { ...success(task), status: "aborted", error: { code: "aborted", message: "aborted" } };
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	const result = await promise;
	assert.equal(result.status, "aborted");
	assert.equal(observed, 1);
	assert.deepEqual(result.tasks.map((item) => item.status), ["aborted", "aborted", "aborted"]);
});

test("task cancellation aborts pending work, blocks dependents, and leaves unrelated tasks running", async () => {
	const tasks = graph([
		{ id: "hold", role: "explorer", objective: "hold", scope: ["."] },
		{ id: "pending", role: "explorer", objective: "pending", scope: ["."] },
		{ id: "blocked", role: "reviewer", objective: "blocked", scope: ["."], dependsOn: ["pending"] },
	]);
	let control: import("../extensions/subagents/scheduler.ts").SchedulerControl | undefined;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const run = runScheduledTasks(tasks, {
		maxConcurrency: 1,
		onControl(value) { control = value; },
		async execute(task, _predecessors, signal) {
			if (task.id === "hold") {
				await gate;
				return success(task);
			}
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return { ...success(task), status: "aborted", error: { code: "aborted", message: "aborted" } };
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(control?.cancelTask("pending"), "accepted");
	assert.equal(control?.cancelTask("missing"), "unknown-task");
	release?.();
	const result = await run;
	assert.deepEqual(result.tasks.map((item) => [item.id, item.status]), [
		["hold", "succeeded"],
		["pending", "aborted"],
		["blocked", "blocked"],
	]);
	assert.equal(result.status, "aborted");
});

test("enterConvergence linearizes task and run cancellation", async () => {
	const tasks = graph([
		{ id: "worker", role: "worker", objective: "w", scope: ["src"], writePaths: ["src/a.ts"] },
		{ id: "other", role: "explorer", objective: "o", scope: ["."] },
	]);
	let control: import("../extensions/subagents/scheduler.ts").SchedulerControl | undefined;
	let otherSignal: AbortSignal | undefined;
	let releaseOther: (() => void) | undefined;
	const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
	let afterEnter: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => { afterEnter = resolve; });
	const run = runScheduledTasks(tasks, {
		onControl(value) { control = value; },
		async execute(task, _predecessors, signal) {
			if (task.id === "other") {
				otherSignal = signal;
				await otherGate;
				return signal.aborted
					? { ...success(task), status: "aborted", error: { code: "aborted", message: "aborted" } }
					: success(task);
			}
			assert.equal(control?.enterConvergence("worker"), true);
			assert.equal(control?.cancelTask("worker"), "too-late");
			afterEnter?.();
			await new Promise((resolve) => setTimeout(resolve, 5));
			return success(task);
		},
	});
	await entered;
	assert.equal(control?.cancelRun(), "accepted");
	assert.equal(otherSignal?.aborted, true);
	releaseOther?.();
	const result = await run;
	assert.equal(result.tasks.find((task) => task.id === "worker")?.status, "succeeded");
	assert.equal(result.tasks.find((task) => task.id === "other")?.status, "aborted");
	assert.equal(result.status, "aborted");
});

test("task cancellation before enterConvergence wins and prevents the critical section", async () => {
	const tasks = graph([{ id: "worker", role: "worker", objective: "w", scope: ["src"], writePaths: ["src/a.ts"] }]);
	let control: import("../extensions/subagents/scheduler.ts").SchedulerControl | undefined;
	let ready: (() => void) | undefined;
	const started = new Promise<void>((resolve) => { ready = resolve; });
	const run = runScheduledTasks(tasks, {
		onControl(value) { control = value; },
		async execute(task, _predecessors, signal) {
			ready?.();
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			assert.equal(control?.enterConvergence("worker"), false);
			return { ...success(task), status: "aborted", error: { code: "aborted", message: "aborted" } };
		},
	});
	await started;
	assert.equal(control?.cancelTask("worker"), "accepted");
	const result = await run;
	assert.equal(result.status, "aborted");
	assert.equal(result.tasks[0]?.status, "aborted");
});
