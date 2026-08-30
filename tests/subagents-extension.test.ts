import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, loadConfig, parseConfig, ROUTE_CONFIG_FILE } from "../extensions/subagents/config.ts";
import { emptyUsage, SUBAGENT_TOOL_NAME, type TaskResult } from "../extensions/subagents/contracts.ts";
import { createSubagentsExtension, type SubagentDependencies } from "../extensions/subagents/index.ts";
import type { NormalizedTask } from "../extensions/subagents/graph.ts";

interface Harness {
	tool?: any;
	commands: Map<string, any>;
	handlers: Map<string, Array<(...args: any[]) => any>>;
	pi: any;
}

function harness(): Harness {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const value: Harness = {
		commands,
		handlers,
		pi: {
			registerTool(tool: any) { value.tool = tool; },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			getActiveTools() { return [SUBAGENT_TOOL_NAME]; },
		},
	};
	return value;
}

const parentModel = { provider: "synthetic", id: "parent", reasoning: true };

function context(trusted = true, models = [parentModel]) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		cwd: process.cwd(),
		model: parentModel,
		thinkingLevel: "high",
		scopedModels: [],
		modelRegistry: {
			getAll() { return models; },
			getAvailable() { return models; },
		},
		isProjectTrusted() { return trusted; },
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
		},
		notifications,
	};
}

function successful(task: NormalizedTask): TaskResult {
	return {
		id: task.id,
		role: task.role,
		status: "succeeded",
		output: `result:${task.id}`,
		stderr: "",
		usage: { ...emptyUsage(), turns: 1 },
		durationMs: 1,
		changedPaths: [],
		convergence: "not-applicable",
	};
}

function dependencies(overrides: Partial<SubagentDependencies> = {}): Partial<SubagentDependencies> {
	return {
		loadConfig: async () => ({ config: defaultConfig() }),
		runChild: async (options) => ({ ...successful(options.task), route: options.route }),
		guardExtensionPath: "/tmp/guard.ts",
		...overrides,
	};
}

test("extension registers one bounded tool and redacted status command", async () => {
	const state = harness();
	createSubagentsExtension(dependencies())(state.pi);
	assert.equal(state.tool.name, SUBAGENT_TOOL_NAME);
	assert.deepEqual([...state.commands.keys()], ["subagents"]);
	const ctx = context();
	await state.commands.get("subagents").handler("", ctx);
	assert.match(ctx.notifications[0]?.message ?? "", /guidance=aggressive/);
	assert.doesNotMatch(ctx.notifications[0]?.message ?? "", /\/tmp\/agent/);
});

test("untrusted projects fail before a child starts", async () => {
	let calls = 0;
	const state = harness();
	createSubagentsExtension(dependencies({ runChild: async (options) => { calls += 1; return successful(options.task); } }))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }],
	}, undefined, undefined, context(false));
	assert.equal("isError" in result, false);
	assert.match(result.content[0].text, /project_trust_required/);
	assert.equal(result.details.telemetry.runErrorCode, "project_trust_required");
	assert.equal(result.details.telemetry.launchedChildren, 0);
	assert.equal(result.details.telemetry.requestedDependencyEdges, 0);
	assert.equal(result.details.telemetry.admittedDependencyEdges, 0);
	assert.equal(result.details.telemetry.explicitModelTasks, 0);
	assert.equal(result.details.telemetry.explicitThinkingTasks, 0);
	assert.equal(calls, 0);
});

test("trusted graph inherits parent route and passes explicit child approval", async () => {
	const seen: any[] = [];
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			seen.push(options);
			return { ...successful(options.task), route: options.route };
		},
	}))(state.pi);
	const updates: string[] = [];
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "a", role: "explorer", objective: "a", scope: ["."] },
			{ id: "b", role: "reviewer", objective: "b", scope: ["."], dependsOn: ["a"] },
		],
	}, undefined, (update: any) => updates.push(update.content[0].text), context());
	assert.equal("isError" in result, false);
	assert.equal(result.details.status, "succeeded");
	assert.equal(seen.length, 2);
	assert.equal(seen[0].approveProject, true);
	assert.equal(seen[0].route.model, "parent");
	assert.equal(seen[0].route.selectionSource, "role-default");
	assert.match(seen[1].prompt, /Predecessor a/);
	assert.equal(result.details.telemetry.requestedDependencyEdges, 1);
	assert.equal(result.details.telemetry.admittedDependencyEdges, 1);
	assert.ok(updates.some((message) => /running/.test(message)));
});

test("resolved route evidence survives dependency blocking before child launch", async () => {
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => options.task.id === "first"
			? { ...successful(options.task), status: "failed", error: { code: "synthetic_failure", message: "failed" } }
			: successful(options.task),
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "first", role: "explorer", objective: "first", scope: ["."] },
			{ id: "blocked", role: "reviewer", objective: "blocked", scope: ["."], dependsOn: ["first"] },
		],
	}, undefined, undefined, context());
	const blocked = result.details.tasks.find((task: TaskResult) => task.id === "blocked");
	assert.equal(blocked?.status, "blocked");
	assert.equal(blocked?.route?.model, "parent");
	assert.equal(blocked?.route?.source, "parent");
	assert.equal(blocked?.route?.selectionSource, "role-default");
	assert.equal(blocked?.telemetry?.childStarted, false);
});

test("task semantic profiles are projected into route resolution without plan coupling", async () => {
	const deepModel = { provider: "synthetic", id: "deep", reasoning: true };
	const config = parseConfig({
		reasoningProfiles: { deep: "high" },
		routes: {
			explorer: {
				executionProfiles: {
					deep: { candidates: [{ model: "synthetic/deep", thinking: "medium" }] },
				},
			},
		},
	});
	let route: TaskResult["route"];
	const state = harness();
	createSubagentsExtension(dependencies({
		loadConfig: async () => ({ config }),
		runChild: async (options) => {
			route = options.route;
			return { ...successful(options.task), route: options.route };
		},
	}))(state.pi);
	const ctx = context(true, [parentModel, deepModel]);
	const result = await state.tool.execute("call", {
		tasks: [{
			id: "scan",
			role: "explorer",
			objective: "scan",
			scope: ["."],
			executionProfile: "deep",
			reasoningProfile: "deep",
		}],
	}, undefined, undefined, ctx);
	assert.equal("isError" in result, false);
	assert.equal(route?.model, "deep");
	assert.equal(route?.thinking, "high");
	assert.equal(route?.executionProfileApplied, true);
	assert.equal(route?.reasoningProfileApplied, true);
	assert.equal(result.details.telemetry.launchedChildren, 1);
});

test("mixed explicit and default routes emit exact ephemeral telemetry", async () => {
	const explicitModel = { provider: "synthetic", id: "explicit-4.6", name: "Explicit 4.6", reasoning: true };
	const seen: TaskResult["route"][] = [];
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			seen.push(options.route);
			return { ...successful(options.task), route: options.route };
		},
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "explicit", role: "explorer", objective: "scan", scope: ["."], model: "Explicit 4.6", thinking: "high" },
			{ id: "default", role: "reviewer", objective: "review", scope: ["."] },
		],
	}, undefined, undefined, context(true, [parentModel, explicitModel]));
	assert.equal(result.details.status, "succeeded");
	assert.deepEqual(seen.map((route) => [route?.model, route?.thinking, route?.selectionSource]), [
		["explicit-4.6", "high", "explicit-task"],
		["parent", "high", "role-default"],
	]);
	assert.equal(result.details.telemetry.explicitModelTasks, 1);
	assert.equal(result.details.telemetry.explicitThinkingTasks, 1);
	assert.equal(result.details.telemetry.requestedDependencyEdges, 0);
	assert.equal(result.details.telemetry.admittedDependencyEdges, 0);
});

test("explicit route success and failure leave the user route file byte-identical", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "subagent-ephemeral-route-"));
	t.after(async () => rm(agentDir, { recursive: true, force: true }));
	const configPath = join(agentDir, ROUTE_CONFIG_FILE);
	const configBytes = `${JSON.stringify({ guidance: "balanced" }, null, 2)}\n`;
	await writeFile(configPath, configBytes, { mode: 0o600 });
	const explicitModel = { provider: "synthetic", id: "explicit-4.6", name: "Explicit 4.6", reasoning: true };
	let calls = 0;
	const state = harness();
	createSubagentsExtension(dependencies({
		loadConfig: () => loadConfig(agentDir),
		createWorkerWorkspace: async (_cwd, task) => ({
			sourceRoot: process.cwd(),
			root: process.cwd(),
			task,
			parentBaselines: new Map(),
			workspaceBaseline: new Map(),
			cleanup: async () => {},
		}),
		convergeWorkerWorkspace: async () => ({ ok: true, changedPaths: ["result.txt"] }),
		runChild: async (options) => {
			calls += 1;
			return { ...successful(options.task), route: options.route };
		},
	}))(state.pi);
	const ctx = context(true, [parentModel, explicitModel]);
	const success = await state.tool.execute("success", {
		tasks: [{ id: "explicit", role: "worker", objective: "write", scope: ["."], writePaths: ["result.txt"], model: "Explicit 4.6", thinking: "high" }],
	}, undefined, undefined, ctx);
	assert.equal(success.details.tasks[0]?.route?.selectionSource, "explicit-task");
	const failure = await state.tool.execute("failure", {
		tasks: [{ id: "missing", role: "explorer", objective: "scan", scope: ["."], model: "missing-model", thinking: "high" }],
	}, undefined, undefined, ctx);
	assert.equal(failure.details.telemetry.runErrorCode, "model_not_found");
	assert.equal(failure.details.telemetry.launchedChildren, 0);
	assert.equal(calls, 1);
	assert.equal(await readFile(configPath, "utf8"), configBytes);
});

test("rejected graphs retain requested but not admitted dependency evidence", async () => {
	const state = harness();
	createSubagentsExtension(dependencies())(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "a", role: "explorer", objective: "a", scope: ["."], dependsOn: ["b"] },
			{ id: "b", role: "reviewer", objective: "b", scope: ["."], dependsOn: ["a"] },
		],
	}, undefined, undefined, context());
	assert.equal(result.details.telemetry.runErrorCode, "dependency_cycle");
	assert.equal(result.details.telemetry.requestedDependencyEdges, 2);
	assert.equal(result.details.telemetry.admittedDependencyEdges, 0);
});

test("a concurrent graph is rejected before it can exceed session caps", async () => {
	let releaseChild: (() => void) | undefined;
	let markStarted: (() => void) | undefined;
	const childStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	const childReleased = new Promise<void>((resolve) => { releaseChild = resolve; });
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			markStarted?.();
			await childReleased;
			return { ...successful(options.task), route: options.route };
		},
	}))(state.pi);
	const input = { tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }] };
	const first = state.tool.execute("first", input, undefined, undefined, context());
	await childStarted;
	const second = await state.tool.execute("second", input, undefined, undefined, context());
	assert.equal("isError" in second, false);
	assert.match(second.content[0].text, /subagent_run_active/);
	releaseChild?.();
	assert.equal((await first).details.status, "succeeded");
});

test("a true zero-diff worker fails aggregate convergence as not applied", async () => {
	const state = harness();
	createSubagentsExtension(dependencies({
		createWorkerWorkspace: async (_cwd, task) => ({
			sourceRoot: process.cwd(),
			root: process.cwd(),
			task,
			parentBaselines: new Map(),
			workspaceBaseline: new Map(),
			cleanup: async () => {},
		}),
		convergeWorkerWorkspace: async () => ({
			ok: false,
			changedPaths: [],
			error: { code: "worker_no_changes", message: "no changes" },
		}),
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [{ id: "write", role: "worker", objective: "write", scope: ["."], writePaths: ["result.txt"] }],
	}, undefined, undefined, context());
	assert.equal(result.details.status, "failed");
	assert.equal(result.details.tasks[0]?.error?.code, "worker_no_changes");
	assert.equal(result.details.tasks[0]?.convergence, "not-applied");
	assert.deepEqual(result.details.tasks[0]?.changedPaths, []);
});

test("a non-Git worker fails without suppressing an independent read-only task", async () => {
	const isolationError = Object.assign(new Error("Git repository required"), { code: "writable_isolation_unavailable" });
	const state = harness();
	createSubagentsExtension(dependencies({
		createWorkerWorkspace: async () => { throw isolationError; },
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "write", role: "worker", objective: "write", scope: ["src"], writePaths: ["src/a.ts"] },
			{ id: "read", role: "explorer", objective: "read", scope: ["."] },
		],
	}, undefined, undefined, context());
	assert.equal(result.details.status, "partial");
	assert.deepEqual(result.details.tasks.map((item: TaskResult) => [item.id, item.status]), [
		["write", "failed"],
		["read", "succeeded"],
	]);
});

test("aggressive guidance appears only while the tool is active", async () => {
	const state = harness();
	createSubagentsExtension(dependencies())(state.pi);
	const handler = state.handlers.get("before_agent_start")?.[0];
	const modified = await handler?.({ systemPrompt: "base" });
	assert.match(modified.systemPrompt, /flat csheng_subagents batch/);
	state.pi.getActiveTools = () => [];
	assert.equal(await handler?.({ systemPrompt: "base" }), undefined);
});

test("session shutdown waits for the aborted run and workspace cleanup", async () => {
	let markStarted: (() => void) | undefined;
	let markAborted: (() => void) | undefined;
	let releaseCleanup: (() => void) | undefined;
	let childRuns = 0;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
	const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = resolve; });
	const state = harness();
	createSubagentsExtension(dependencies({
		createWorkerWorkspace: async (_cwd, task) => ({
			sourceRoot: process.cwd(),
			root: process.cwd(),
			task,
			parentBaselines: new Map(),
			workspaceBaseline: new Map(),
			cleanup: async () => cleanupReleased,
		}),
		runChild: async (options) => {
			childRuns += 1;
			if (childRuns > 1) return successful(options.task);
			return new Promise<TaskResult>((resolve) => {
				markStarted?.();
				options.signal?.addEventListener("abort", () => {
					markAborted?.();
					resolve({ ...successful(options.task), status: "aborted", error: { code: "aborted", message: "aborted" } });
				}, { once: true });
			});
		},
	}))(state.pi);
	const execution = state.tool.execute("call", {
		tasks: [{ id: "write", role: "worker", objective: "write", scope: ["."], writePaths: ["result.txt"] }],
	}, undefined, undefined, context());
	await started;

	let shutdownSettled = false;
	const shutdown = state.handlers.get("session_shutdown")?.[0]?.({}).then(() => { shutdownSettled = true; });
	await aborted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(shutdownSettled, false);

	releaseCleanup?.();
	await shutdown;
	const result = await execution;
	assert.equal(shutdownSettled, true);
	assert.equal(result.details.status, "aborted");

	const next = await state.tool.execute("next", {
		tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }],
	}, undefined, undefined, context());
	assert.equal(next.details.status, "succeeded");
	assert.equal(childRuns, 2);
});
