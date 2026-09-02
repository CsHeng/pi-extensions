import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type TaskResult } from "../extensions/subagents/contracts.ts";
import { validateGraph, type NormalizedTask } from "../extensions/subagents/graph.ts";
import { runScheduledTasks } from "../extensions/subagents/scheduler.ts";

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
	const result = validateGraph({ tasks } as never);
	assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
	return result.ok ? result.tasks : [];
}

test("canonical repository-relative writes stay contained and still conflict when overlapping", () => {
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["lib/a.ts"] },
	] }).ok, false);
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/a.ts"] },
		{ id: "b", role: "worker", objective: "b", scope: ["src"], writePaths: ["src/a.ts"] },
	] }).ok, false);
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/a.ts"] },
	] }).ok, true);
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/..config/a.ts"] },
	] }).ok, true);
});

test("graph admission rejects cycles, unknown dependencies, role writes, and concurrent write overlap", () => {
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "explorer", objective: "a", scope: ["."], dependsOn: ["b"] },
		{ id: "b", role: "explorer", objective: "b", scope: ["."], dependsOn: ["a"] },
	] }).ok, false);
	assert.deepEqual(validateGraph({ tasks: [
		{ id: "a", role: "explorer", objective: "a", scope: ["."], dependsOn: ["missing"] },
	] }), { ok: false, error: { code: "unknown_dependency", message: "Task a depends on unknown task missing." } });
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "reviewer", objective: "a", scope: ["."], writePaths: [] },
	] }).ok, false);
	assert.equal(validateGraph({ tasks: [
		{ id: "a", role: "worker", objective: "a", scope: ["src"], writePaths: ["src/a.ts"] },
		{ id: "b", role: "worker", objective: "b", scope: ["src"], writePaths: ["src/a.ts"] },
	] }).ok, false);
});

test("graph admission rejects unknown semantic profiles before scheduling", () => {
	assert.deepEqual(validateGraph({ tasks: [
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

test("mixed ready tasks can reach ten while role ceilings remain four, four, and two", async () => {
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
			lifecycle.activity({ phase: "running", assistantTurns: 1, activeTools: ["read"], latestEventType: "tool_execution_start", errorObserved: false, agentEndObserved: false, agentSettledObserved: false, elapsedMs: 0, inactiveForMs: 0 });
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
