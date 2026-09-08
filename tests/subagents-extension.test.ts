import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig, loadConfig, parseConfig, ROUTE_CONFIG_FILE } from "../extensions/subagents/config.ts";
import { emptyUsage, HARD_LIMITS, SUBAGENT_TOOL_NAME, type TaskResult } from "../extensions/subagents/contracts.ts";
import { createSubagentsExtension, type SubagentDependencies } from "../extensions/subagents/index.ts";
import type { NormalizedTask } from "../extensions/subagents/graph.ts";

const exec = promisify(execFile);

interface Harness {
	tool?: any;
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, Array<(...args: any[]) => any>>;
	pi: any;
}

function harness(): Harness {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const value: Harness = {
		tools: new Map(),
		commands,
		handlers,
		pi: {
			registerTool(tool: any) { value.tools.set(tool.name, tool); if (tool.name === SUBAGENT_TOOL_NAME) value.tool = tool; },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			getActiveTools() { return [SUBAGENT_TOOL_NAME]; },
			events: { on() {}, emit() {} },
		},
	};
	return value;
}

const parentModel = { provider: "synthetic", id: "parent", reasoning: true };

function context(trusted = true, models = [parentModel], cwd = process.cwd()) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		cwd,
		model: parentModel,
		thinkingLevel: "high",
		scopedModels: [],
		modelRegistry: {
			getAll() { return models; },
			getAvailable() { return models; },
		},
		isProjectTrusted() { return trusted; },
		sessionManager: { getSessionId() { return "parent-session"; } },
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
		createProvenance: () => ({
			observeExtension: async () => ({ available: false as const }),
			observeConfiguration: async () => ({ available: false as const }),
		}),
		createDiagnosticStore: () => ({
			async allocateRun(parentSessionId, runId) {
				return {
					path: `/private/${parentSessionId}/${runId}`,
					ref: `subagent-sessions/${parentSessionId}/${runId}`,
					parentSegment: parentSessionId,
					runSegment: runId,
					async createTask(taskId) { return { path: `/private/${taskId}.jsonl`, ref: `subagent-sessions/${parentSessionId}/${runId}/${taskId}.jsonl`, async removeUnused() {} }; },
					async checkLimits() { return { ok: true }; },
					async settle() {},
				};
			},
			async discover() { return []; },
			async inspect() { throw new Error("not configured"); },
		}),
		runChild: async (options) => ({ ...successful(options.task), route: options.route, diagnosticSessionRef: options.diagnosticSession.ref }),
		guardExtensionPath: "/tmp/guard.ts",
		...overrides,
	};
}

test("tool-entry timing includes admission and diagnostic settlement rather than scheduler alone", async () => {
	let now = 0;
	const state = harness();
	const store = dependencies().createDiagnosticStore!();
	createSubagentsExtension(dependencies({
		now: () => now,
		loadConfig: async () => { now += 10; return { config: defaultConfig() }; },
		createDiagnosticStore: () => ({ ...store, async allocateRun(parent, run) {
			const allocated = await store.allocateRun(parent, run);
			return { ...allocated, async settle() { now += 20; await allocated.settle(); } };
		} }),
		runChild: async (options) => {
			options.onChildStarted?.();
			now += 30;
			options.onChildSettled?.();
			return successful(options.task);
		},
	}))(state.pi);
	const result = await state.tool.execute("clock", { tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }] }, undefined, undefined, context());
	assert.equal(result.details.telemetry.runDurationMs, 60);
	assert.deepEqual(result.details.telemetry.timing.scheduler, { startMs: 10, endMs: 40 });
	assert.equal(result.details.telemetry.timing.boundary, "tool-entry");
	assert.equal(result.details.telemetry.timing.complete, true);
});

test("extension registers bounded one-shot and managed tools with redacted status commands", async () => {
	const state = harness();
	createSubagentsExtension(dependencies())(state.pi);
	assert.equal(state.tool.name, SUBAGENT_TOOL_NAME);
	assert.deepEqual([...state.tools.keys()], [SUBAGENT_TOOL_NAME, "csheng_subagent_sessions"]);
	assert.deepEqual([...state.commands.keys()], ["subagents", "subagents-debug"]);
	const ctx = context();
	await state.commands.get("subagents").handler("", ctx);
	assert.match(ctx.notifications[0]?.message ?? "", /guidance=aggressive/);
	assert.doesNotMatch(ctx.notifications[0]?.message ?? "", /\/tmp\/agent/);
});

test("debug command renders user-only bounded metadata and not raw session content", async () => {
	const state = harness();
	createSubagentsExtension(dependencies({
		createDiagnosticStore: () => ({
			async allocateRun() { throw new Error("unused"); },
			async discover() { return [{ ref: "subagent-sessions/parent/run", path: "/private/run", active: false, staleActive: false, mtimeMs: 1, bytes: 2 }]; },
			async inspect(reference) {
				return { path: "/private/run/task.jsonl", ref: reference, entries: [{ entryType: "message", role: "assistant", stopReason: "stop" }], truncated: false, transcriptComplete: true };
			},
		}),
	}))(state.pi);
	const ctx = context();
	await state.commands.get("subagents-debug").handler("parent/run/task.jsonl", ctx);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /\/private\/run\/task\.jsonl/);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /ordinary continuable Pi session/);
	assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /prompt|result content/);
});

test("untrusted projects fail before a child starts", async () => {
	let calls = 0;
	let probes = 0;
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => { calls += 1; return successful(options.task); },
		repositoryHost: {
			async findGitToplevel() { probes += 1; throw new Error("probed"); },
			async realpath() { probes += 1; throw new Error("probed"); },
			async lstat() { probes += 1; throw new Error("probed"); },
		},
	}))(state.pi);
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
	assert.equal(probes, 0);
});

test("diagnostic admission failure blocks every child without fallback", async () => {
	let calls = 0;
	const state = harness();
	createSubagentsExtension(dependencies({
		createDiagnosticStore: () => ({
			async allocateRun() { throw Object.assign(new Error("sensitive path"), { code: "diagnostic_storage_unavailable" }); },
			async discover() { return []; },
			async inspect() { throw new Error("unused"); },
		}),
		runChild: async (options) => { calls += 1; return successful(options.task); },
	}))(state.pi);
	const result = await state.tool.execute("call", { tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }] }, undefined, undefined, context());
	assert.equal(result.details.telemetry.runErrorCode, "diagnostic_storage_unavailable");
	assert.equal(result.details.telemetry.launchedChildren, 0);
	assert.equal(calls, 0);
	assert.doesNotMatch(result.content[0].text, /sensitive path/);
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

test("child activity reaches host progress before final settlement without leaking diagnostics", async () => {
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			options.onChildStarted?.();
			options.onActivity?.({ phase: "running", assistantTurns: 1, activeTools: ["read"], latestEventType: "tool_execution_start", errorObserved: false, errorCount: 0, agentEndObserved: false, agentSettledObserved: false, elapsedMs: 5, inactiveForMs: 0 });
			options.onChildSettled?.();
			return { ...successful(options.task), route: options.route, diagnosticSessionRef: "subagent-sessions/private/run/task.jsonl" };
		},
	}))(state.pi);
	const updates: string[] = [];
	const result = await state.tool.execute("call", { tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }] }, undefined, (update: any) => updates.push(update.content[0].text), context());
	assert.equal(result.details.status, "succeeded");
	assert.ok(updates.some((message) => /turns=1 tool=read/.test(message)));
	assert.ok(updates.every((message) => !/subagent-sessions|private|jsonl/.test(message)));
	assert.doesNotMatch(result.content[0].text, /subagent-sessions|private|jsonl/);
});

test("event-boundary run limit aborts remaining children with typed storage failure", async () => {
	let started = 0;
	let releaseFirst: (() => void) | undefined;
	const bothStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			started += 1;
			options.onChildStarted?.();
			if (started === 2) releaseFirst?.();
			await bothStarted;
			if (options.task.id === "first") {
				options.onRunDiagnosticLimit?.();
				options.onChildSettled?.();
				return { ...successful(options.task), status: "failed", error: { code: "diagnostic_session_limit", message: "limit" } };
			}
			if (!options.signal?.aborted) await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
			options.onChildSettled?.();
			return { ...successful(options.task), status: "failed", error: { code: options.abortCause?.() ?? "aborted", message: "stopped" } };
		},
	}))(state.pi);
	const result = await state.tool.execute("call", { tasks: [
		{ id: "first", role: "explorer", objective: "first", scope: ["."] },
		{ id: "second", role: "reviewer", objective: "second", scope: ["."] },
	] }, undefined, undefined, context());
	assert.equal(result.details.status, "failed");
	assert.deepEqual(result.details.tasks.map((task: TaskResult) => task.error?.code), ["diagnostic_session_limit", "diagnostic_session_limit"]);
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

async function gitPair(t: test.TestContext): Promise<{ current: string; sibling: string; siblingFile: string }> {
	const parent = await mkdtemp(join(tmpdir(), "subagent-ext-repo-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const current = join(parent, "current");
	const sibling = join(parent, "sibling");
	await mkdir(join(current, "src"), { recursive: true });
	await mkdir(sibling);
	await exec("git", ["init", "-q", current]);
	await exec("git", ["init", "-q", sibling]);
	await writeFile(join(current, "src", "tracked.ts"), "tracked\n");
	const siblingFile = join(sibling, "secret.ts");
	await writeFile(siblingFile, "secret\n");
	return { current, sibling, siblingFile: await realpath(siblingFile) };
}

test("current-repository absolute and returning-parent scope reach children in canonical form", async (t) => {
	const { current } = await gitPair(t);
	const gitRoot = await realpath(current);
	const seen: any[] = [];
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			seen.push(options);
			return { ...successful(options.task), route: options.route };
		},
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [{
			id: "scan",
			role: "explorer",
			objective: "scan",
			scope: [gitRoot, join(gitRoot, "src"), `../${basename(current)}/src/tracked.ts`],
		}],
	}, undefined, undefined, context(true, [parentModel], current));
	assert.equal(result.details.status, "succeeded");
	assert.deepEqual(seen[0]?.task.scope, [".", "src", "src/tracked.ts"]);
	assert.equal(seen[0]?.cwd, gitRoot);
	assert.equal(seen[0]?.capability.version, 2);
	assert.deepEqual(seen[0]?.capability.externalReadRoots, []);
});

test("missing internal new-file worker scope remains admissible", async (t) => {
	const { current } = await gitPair(t);
	let workspaceCreated = 0;
	const state = harness();
	createSubagentsExtension(dependencies({
		createWorkerWorkspace: async (_cwd, task) => {
			workspaceCreated += 1;
			return {
				sourceRoot: current,
				root: current,
				task,
				parentBaselines: new Map(),
				workspaceBaseline: new Map(),
				cleanup: async () => {},
			};
		},
		convergeWorkerWorkspace: async () => ({ ok: true, changedPaths: ["src/new.ts"] }),
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [{ id: "write", role: "worker", objective: "write", scope: ["src/new.ts"], writePaths: ["src/new.ts"] }],
	}, undefined, undefined, context(true, [parentModel], current));
	assert.equal(result.details.status, "succeeded");
	assert.equal(workspaceCreated, 1);
});

test("sibling, non-Git, unsafe, and invalid external roots fail before config and child work", async (t) => {
	const { current, sibling } = await gitPair(t);
	const plain = await mkdtemp(join(tmpdir(), "subagent-ext-plain-"));
	t.after(async () => rm(plain, { recursive: true, force: true }));
	for (const [cwd, tasks, code] of [
		[current, [{ id: "scan", role: "explorer", objective: "scan", scope: [sibling] }], "scope_outside_repository"],
		[plain, [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }], "repository_root_unavailable"],
		[current, [{ id: "scan", role: "explorer", objective: "scan", scope: ["bad\0path"] }], "invalid_scope"],
		[current, [{ id: "scan", role: "explorer", objective: "scan", scope: ["."], externalReadRoots: [join(current, "src")] }], "external_read_root_not_external"],
	] as const) {
		let configCalls = 0;
		let diagnosticCalls = 0;
		let childCalls = 0;
		const state = harness();
		createSubagentsExtension(dependencies({
			loadConfig: async () => {
				configCalls += 1;
				return { config: defaultConfig() };
			},
			createDiagnosticStore: () => ({
				async allocateRun() {
					diagnosticCalls += 1;
					throw new Error("unused");
				},
				async discover() { return []; },
				async inspect() { throw new Error("unused"); },
			}),
			runChild: async (options) => {
				childCalls += 1;
				return successful(options.task);
			},
		}))(state.pi);
		const result = await state.tool.execute("call", { tasks: [...tasks] }, undefined, undefined, context(true, [parentModel], cwd));
		assert.equal(result.details.telemetry.runErrorCode, code, code);
		assert.equal(result.details.telemetry.admittedTasks, 0);
		assert.equal(result.details.telemetry.launchedChildren, 0);
		assert.equal(result.details.tasks.length, 0);
		assert.doesNotMatch(result.content[0].text, /\/tmp\/|secret\.ts/);
		assert.equal(configCalls, 0);
		assert.equal(diagnosticCalls, 0);
		assert.equal(childCalls, 0);
	}
});

test("canonical complete prompt bounds reject the whole batch before config or launch", async () => {
	const longRelative = "a".repeat(HARD_LIMITS.maxPathBytes);
	let configCalls = 0;
	let diagnosticAllocations = 0;
	let childCalls = 0;
	const state = harness();
	createSubagentsExtension(dependencies({
		loadConfig: async () => {
			configCalls += 1;
			return { config: defaultConfig() };
		},
		createDiagnosticStore: () => ({
			async allocateRun() {
				diagnosticAllocations += 1;
				throw new Error("unused");
			},
			async discover() { return []; },
			async inspect() { throw new Error("unused"); },
		}),
		runChild: async (options) => {
			childCalls += 1;
			return successful(options.task);
		},
		repositoryHost: {
			async findGitToplevel() { return "/repo"; },
			async realpath(path) { return path === "/repo/alias" ? `/repo/${longRelative}` : path; },
			async lstat() { return {} as never; },
		},
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "small", role: "explorer", objective: "small", scope: ["."] },
			{ id: "oversized", role: "reviewer", objective: "review", scope: Array.from({ length: 32 }, () => "alias") },
		],
	}, undefined, undefined, context(true, [parentModel], "/repo"));
	assert.equal(result.details.telemetry.runErrorCode, "prompt_too_large");
	assert.equal(result.details.telemetry.admittedTasks, 0);
	assert.equal(result.details.telemetry.launchedChildren, 0);
	assert.deepEqual(result.details.tasks, []);
	assert.equal(configCalls, 0);
	assert.equal(diagnosticAllocations, 0);
	assert.equal(childCalls, 0);
});

test("explorer and reviewer external roots reach only task and capability fields", async (t) => {
	const { current, siblingFile } = await gitPair(t);
	const seen: any[] = [];
	const updates: string[] = [];
	const state = harness();
	createSubagentsExtension(dependencies({
		runChild: async (options) => {
			seen.push(options);
			return {
				...successful(options.task),
				output: `echo:${siblingFile}`,
				route: options.route,
			};
		},
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [
			{ id: "scan", role: "explorer", objective: "scan", scope: ["."], externalReadRoots: [siblingFile] },
			{ id: "review", role: "reviewer", objective: "review", scope: ["src"], externalReadRoots: [siblingFile] },
		],
	}, undefined, (update: any) => updates.push(update.content[0].text), context(true, [parentModel], current));
	assert.equal(result.details.status, "succeeded");
	assert.equal(result.details.telemetry.schemaVersion, 4);
	assert.deepEqual(seen[0]?.task.externalReadRoots, [siblingFile]);
	assert.deepEqual(seen[0]?.capability.externalReadRoots, [siblingFile]);
	assert.equal(seen[0]?.cwd, await realpath(current));
	assert.deepEqual(seen[0]?.capability.writePaths, []);
	assert.deepEqual(seen[1]?.task.externalReadRoots, [siblingFile]);
	assert.ok(updates.every((message) => !message.includes(siblingFile)));
	assert.equal(JSON.stringify(result.details.telemetry).includes(siblingFile), false);
	assert.equal(result.details.tasks[0]?.output, `echo:${siblingFile}`);
});

test("worker external roots are rejected before workspace creation", async (t) => {
	const { current, siblingFile } = await gitPair(t);
	let workspaceCalls = 0;
	const state = harness();
	createSubagentsExtension(dependencies({
		createWorkerWorkspace: async (_cwd, task) => {
			workspaceCalls += 1;
			return {
				sourceRoot: current,
				root: current,
				task,
				parentBaselines: new Map(),
				workspaceBaseline: new Map(),
				cleanup: async () => {},
			};
		},
	}))(state.pi);
	const result = await state.tool.execute("call", {
		tasks: [{
			id: "write",
			role: "worker",
			objective: "write",
			scope: ["."],
			writePaths: ["src/tracked.ts"],
			externalReadRoots: [siblingFile],
		}],
	}, undefined, undefined, context(true, [parentModel], current));
	assert.equal(result.details.telemetry.runErrorCode, "external_read_roots_forbidden");
	assert.equal(result.details.telemetry.launchedChildren, 0);
	assert.equal(workspaceCalls, 0);
});
