import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { defaultConfig, loadConfig, parseConfig, ROUTE_CONFIG_FILE } from "../extensions/subagents/config.ts";
import { emptyUsage, HARD_LIMITS, type TaskResult } from "../extensions/subagents/contracts.ts";
import { createSubagentsExtension, type SubagentDependencies } from "../extensions/subagents/index.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { SUBAGENT_SESSION_TOOL_NAME, type SessionActionResult } from "../extensions/subagents/session-contracts.ts";

const exec = promisify(execFile);
const fixtureRepo = await mkdtemp(join(tmpdir(), "subagent-adapter-repo-"));
await exec("git", ["init", "-q", fixtureRepo]);
after(() => rm(fixtureRepo, { recursive: true, force: true }));

/*
 * Old one-shot entry tests → managed-only owners
 *
 * PORT via this file (managed tool + ContinuationService/store fixtures):
 *   registration/status/guidance, trust-before-probe, parent/explicit/profile routes,
 *   user route-file immutability, cycle/prompt bounds before config, busy-batch,
 *   shutdown abort, canonical scope, path-admission redaction, external reads,
 *   worker external-root ban, progress without diagnostic leak, predecessor reports,
 *   repo-wide worker scope refusal, request duration spanning admission+child.
 *
 * RETIRED one-shot product (do not reintroduce):
 *   csheng_subagents, /subagents-debug, diagnostic store admission/limit abort,
 *   auto-convergence/worker_no_changes apply, writable-snapshot partial success,
 *   complete-prompt-after-alias-realpath, one-shot scheduler telemetry counters,
 *   blocked-task prelaunch route decoration, "Predecessor"-labeled prompts,
 *   subagent_run_active, missing-path create-file worker scope.
 *
 * COVERED by existing managed tests (not deleted invariants):
 *   continue trust/native-leaf/abort/replay/blocked dependents → tests/subagents-continuation.test.ts
 *   worker_no_changes snapshot failure → tests/subagents-workspace.test.ts
 *   no parent write before apply / no candidate on empty worker diff → tests/subagents-continuation.test.ts, tests/subagents-candidates.test.ts
 *   writable_isolation_unavailable → tests/subagents-workspace.test.ts
 *   diagnostic_session_limit → tests/subagents-runner.test.ts
 *   managed storage/history bounds → tests/subagents-managed-sessions.test.ts
 *   historical one-shot JSONL → tests/subagents-evaluator.test.ts
 */

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
			registerTool(tool: any) { value.tools.set(tool.name, tool); if (tool.name === SUBAGENT_SESSION_TOOL_NAME) value.tool = tool; },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			getActiveTools() { return [SUBAGENT_SESSION_TOOL_NAME]; },
			appendEntry() {},
			events: { on() {}, emit() {} },
		},
	};
	return value;
}

const parentModel = { provider: "synthetic", id: "parent", reasoning: true };

function context(trusted = true, models = [parentModel], cwd = fixtureRepo) {
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
		sessionManager: {
			getSessionId() { return "parent-session"; },
			getLeafId() { return "anchor"; },
			getBranch() { return [{ id: "anchor" }]; },
		},
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
		},
		notifications,
	};
}

function successful(task: { id: string; role: TaskResult["role"] }): TaskResult {
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
		reportComplete: true,
	};
}

function detailsOf(result: { details: SessionActionResult }): SessionActionResult {
	return result.details;
}

async function registered(t: test.TestContext, overrides: Partial<SubagentDependencies> = {}) {
	const base = await mkdtemp(join(tmpdir(), "subagent-extension-"));
	const store = new ManagedSessionStore(base);
	const state = harness();
	createSubagentsExtension({
		store,
		loadConfig: async () => ({ config: defaultConfig() }),
		createProvenance: () => ({
			observeExtension: async () => ({ available: false as const }),
			observeConfiguration: async () => ({ available: false as const }),
		}),
		runChild: async (options) => {
			options.onChildStarted?.();
			options.onChildSettled?.();
			return successful(options.task);
		},
		...overrides,
	})(state.pi);
	t.after(async () => {
		for (const handler of state.handlers.get("session_shutdown") ?? []) await handler({});
		for (const entry of await readdir(store.root).catch(() => [])) {
			if (!entry.startsWith("session_")) continue;
			const record = JSON.parse(await readFile(join(store.path(entry), "registry.json"), "utf8"));
			if (record.state === "closed") continue;
			try { await realpath(record.owner.repo); } catch { continue; } // A disposable parent already removed owns no remaining Git metadata.
			const closed = await state.tool.execute("cleanup", { action: "close", handle: entry, expectedEpisode: record.episode, disposition: "discard" }, undefined, undefined, context(true, [parentModel], record.owner.repo));
			assert.equal(closed.details.status, "succeeded", JSON.stringify(closed.details));
		}
		await rm(base, { recursive: true, force: true });
	});
	return { base, store, state };
}

function createInput(requestId: string, tasks: object[]) {
	return { action: "create", requestId, tasks };
}

async function emitBeforeAgentStart(state: Harness, event = { systemPrompt: "base" }, ctx = context()) {
	let result: unknown;
	for (const handler of state.handlers.get("before_agent_start") ?? []) {
		result = await handler(event, ctx) ?? result;
	}
	return result as { systemPrompt?: string } | undefined;
}

test("async terminal wakes coalesce until the public context consumes them and never reuse a settled tool progress callback", async t => {
	let releaseFast!: () => void, releaseSlow!: () => void, fastTerminal!: () => void;
	const fast = new Promise<void>(resolve => { releaseFast = resolve; }), slow = new Promise<void>(resolve => { releaseSlow = resolve; });
	const terminal = new Promise<void>(resolve => { fastTerminal = resolve; });
	t.after(() => { releaseFast(); releaseSlow(); });
	const { state } = await registered(t, { onExecution: event => { if (event.kind === "task-terminal" && event.sessions[0]?.result?.id === "fast") fastTerminal(); }, runChild: async options => { options.onChildStarted?.(); await (options.task.id === "fast" ? fast : slow); options.onChildSettled?.(); return successful(options.task); } });
	const sent: any[] = []; state.pi.sendMessage = (message: unknown) => { sent.push(message); };
	const ctx = { ...context(), mode: "rpc" }; let updates = 0;
	const receipt = await state.tool.execute("dispatch", createInput("wake", ["fast", "slow"].map(id => ({ id, role: "explorer", objective: "inspect", scope: ["."] }))), undefined, () => { updates++; }, ctx);
	assert.equal(receipt.details.status, "accepted"); releaseFast(); await terminal; await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 1);
	releaseSlow(); await state.tool.execute("join", { action: "join", runId: receipt.details.runId }, undefined, undefined, ctx); await new Promise(resolve => setImmediate(resolve));
	assert.equal(sent.length, 1); assert.equal(updates, 0);
	let messages = [{ ...sent[0], role: "custom", timestamp: Date.now() }];
	for (const handler of state.handlers.get("context") ?? []) messages = (await handler({ messages }, ctx))?.messages ?? messages;
	for (const view of receipt.details.sessions) assert.ok(messages[0].content.includes(view.handle), "consumption includes both independently persisted terminal facts");
	const next = await state.tool.execute("next", createInput("next-wake", [{ id: "next", role: "explorer", objective: "inspect", scope: ["."] }]), undefined, undefined, ctx);
	await state.tool.execute("join-next", { action: "join", runId: next.details.runId }, undefined, undefined, ctx); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 2);
});

test("extension registers only the managed tool and a redacted status command", async () => {
	const state = harness();
	createSubagentsExtension({
		loadConfig: async () => ({ config: defaultConfig() }),
	})(state.pi);
	assert.equal(state.tool.name, SUBAGENT_SESSION_TOOL_NAME);
	assert.deepEqual([...state.tools.keys()], [SUBAGENT_SESSION_TOOL_NAME]);
	assert.equal(state.tools.has("csheng_subagents"), false);
	assert.deepEqual([...state.commands.keys()], ["subagents"]);
	assert.equal(state.commands.has("subagents-debug"), false);
	const ctx = context();
	await state.commands.get("subagents").handler("", ctx);
	assert.match(ctx.notifications[0]?.message ?? "", /tool=csheng_subagent_sessions/);
	assert.match(ctx.notifications[0]?.message ?? "", /guidance=aggressive/);
	assert.doesNotMatch(ctx.notifications[0]?.message ?? "", /\/tmp\/agent/);
});

test("invalid route configuration is reported by status without launching work", async () => {
	const state = harness();
	createSubagentsExtension({
		loadConfig: async () => ({ diagnostic: { code: "invalid_route_config", message: "invalid overlay" } }),
	})(state.pi);
	const ctx = context();
	await state.commands.get("subagents").handler("", ctx);
	assert.equal(ctx.notifications[0]?.level, "error");
	assert.match(ctx.notifications[0]?.message ?? "", /invalid overlay/);
});

test("untrusted projects fail before a child or repository probe starts", async (t) => {
	let calls = 0;
	let probes = 0;
	const { state } = await registered(t, {
		runChild: async (options) => { calls += 1; return successful(options.task); },
		repositoryHost: {
			async findGitToplevel() { probes += 1; throw new Error("probed"); },
			async realpath() { probes += 1; throw new Error("probed"); },
			async lstat() { probes += 1; throw new Error("probed"); },
		},
	});
	const result = await state.tool.execute("call", createInput("trust", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), undefined, undefined, context(false));
	const details = detailsOf(result);
	assert.equal("isError" in result, false);
	assert.match(result.content[0].text, /project_trust_required/);
	assert.equal(details.error?.code, "project_trust_required");
	assert.equal(details.requestTelemetry?.launchedChildren, 0);
	assert.equal(details.sessions.length, 0);
	assert.equal(calls, 0);
	assert.equal(probes, 0);
});

test("trusted graph inherits the parent route, approves the child, and passes predecessor reports", async (t) => {
	const seen: any[] = [];
	const { state } = await registered(t, {
		runChild: async (options) => {
			options.onChildStarted?.();
			options.onChildSettled?.();
			seen.push(options);
			return { ...successful(options.task), route: options.route };
		},
	});
	const updates: string[] = [];
	const result = await state.tool.execute("call", createInput("graph", [
		{ id: "a", role: "explorer", objective: "a", scope: ["."] },
		{ id: "b", role: "reviewer", objective: "b", scope: ["."], dependsOn: ["a"] },
	]), undefined, (update: any) => updates.push(update.content[0].text), context());
	const details = detailsOf(result);
	assert.equal(details.status, "succeeded");
	assert.equal(seen.length, 2);
	assert.equal(seen[0].approveProject, true);
	assert.equal(seen[0].route.model, "parent");
	assert.equal(seen[0].route.selectionSource, "role-default");
	assert.match(seen[1].prompt, /result:a/);
	assert.equal(details.requestTelemetry?.launchedChildren, 2);
	assert.ok(updates.some((message) => /running/.test(message)));
});

test("child activity reaches host progress before settlement without leaking diagnostics", async (t) => {
	const { state } = await registered(t, {
		runChild: async (options) => {
			options.onChildStarted?.();
			options.onActivity?.({ phase: "running", assistantTurns: 1, activeTools: ["read"], latestEventType: "tool_execution_start", errorObserved: false, errorCount: 0, agentEndObserved: false, agentSettledObserved: false, elapsedMs: 5, inactiveForMs: 0 });
			options.onChildSettled?.();
			return { ...successful(options.task), route: options.route };
		},
	});
	const updates: string[] = [];
	const result = await state.tool.execute("call", createInput("progress", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), undefined, (update: any) => updates.push(update.content[0].text), context());
	assert.equal(detailsOf(result).status, "succeeded");
	assert.ok(updates.some((message) => /turns=1 tool=read/.test(message)));
	assert.ok(updates.every((message) => !/subagent-sessions|private|jsonl/.test(message)));
	assert.doesNotMatch(result.content[0].text, /subagent-sessions|private|jsonl/);
});

test("request duration spans configuration admission and child work", async (t) => {
	let now = 0;
	const { state } = await registered(t, {
		now: () => now,
		loadConfig: async () => { now += 10; return { config: defaultConfig() }; },
		runChild: async (options) => {
			options.onChildStarted?.();
			now += 30;
			options.onChildSettled?.();
			return successful(options.task);
		},
	});
	const details = detailsOf(await state.tool.execute("clock", createInput("clock", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), undefined, undefined, context()));
	assert.equal(details.status, "succeeded");
	assert.ok((details.requestTelemetry?.durationMs ?? 0) >= 40);
	assert.equal(details.requestTelemetry?.launchedChildren, 1);
});

test("a failed predecessor does not launch its dependent", async (t) => {
	const launched: string[] = [];
	const { state } = await registered(t, {
		runChild: async (options) => {
			launched.push(options.task.id);
			options.onChildStarted?.();
			options.onChildSettled?.();
			return options.task.id === "first"
				? { ...successful(options.task), status: "failed", error: { code: "synthetic_failure", message: "failed" } }
				: successful(options.task);
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("blocked", [
		{ id: "first", role: "explorer", objective: "first", scope: ["."] },
		{ id: "blocked", role: "reviewer", objective: "blocked", scope: ["."], dependsOn: ["first"] },
	]), undefined, undefined, context()));
	assert.equal(details.status, "failed");
	assert.deepEqual(launched, ["first"]);
	assert.equal(details.sessions[1]?.requestError?.code, "dependency_failed");
	assert.equal(details.requestTelemetry?.launchedChildren, 1);
});

test("task semantic profiles are projected into route resolution without plan coupling", async (t) => {
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
	const { state } = await registered(t, {
		loadConfig: async () => ({ config }),
		runChild: async (options) => {
			route = options.route;
			options.onChildStarted?.();
			options.onChildSettled?.();
			return { ...successful(options.task), route: options.route };
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("profiles", [{
		id: "scan",
		role: "explorer",
		objective: "scan",
		scope: ["."],
		executionProfile: "deep",
		reasoningProfile: "deep",
	}]), undefined, undefined, context(true, [parentModel, deepModel])));
	assert.equal(details.status, "succeeded");
	assert.equal(route?.model, "deep");
	assert.equal(route?.thinking, "high");
	assert.equal(route?.executionProfileApplied, true);
	assert.equal(route?.reasoningProfileApplied, true);
	assert.equal(details.requestTelemetry?.launchedChildren, 1);
});

test("mixed explicit and default routes keep selection sources on the managed result", async (t) => {
	const explicitModel = { provider: "synthetic", id: "explicit-4.6", name: "Explicit 4.6", reasoning: true };
	const seen = new Map<string, TaskResult["route"]>();
	const { state } = await registered(t, {
		runChild: async (options) => {
			seen.set(options.task.id, options.route);
			options.onChildStarted?.();
			options.onChildSettled?.();
			return { ...successful(options.task), route: options.route };
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("routes", [
		{ id: "explicit", role: "explorer", objective: "scan", scope: ["."], model: "Explicit 4.6", thinking: "high" },
		{ id: "default", role: "reviewer", objective: "review", scope: ["."] },
	]), undefined, undefined, context(true, [parentModel, explicitModel])));
	assert.equal(details.status, "succeeded");
	assert.equal(seen.size, 2);
	assert.deepEqual([seen.get("explicit"), seen.get("default")].map((route) => [route?.model, route?.thinking, route?.selectionSource]), [
		["explicit-4.6", "high", "explicit-task"],
		["parent", "high", "role-default"],
	]);
	assert.equal(details.requestTelemetry?.launchedChildren, 2);
});

test("explicit route success and failure leave the user route file byte-identical", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "subagent-ephemeral-route-"));
	t.after(async () => rm(agentDir, { recursive: true, force: true }));
	const configPath = join(agentDir, ROUTE_CONFIG_FILE);
	const configBytes = `${JSON.stringify({ guidance: "balanced" }, null, 2)}\n`;
	await writeFile(configPath, configBytes, { mode: 0o600 });
	const explicitModel = { provider: "synthetic", id: "explicit-4.6", name: "Explicit 4.6", reasoning: true };
	let calls = 0;
	const { state } = await registered(t, {
		loadConfig: () => loadConfig(agentDir),
		runChild: async (options) => {
			calls += 1;
			options.onChildStarted?.();
			options.onChildSettled?.();
			return { ...successful(options.task), route: options.route };
		},
	});
	const ctx = context(true, [parentModel, explicitModel]);
	const success = detailsOf(await state.tool.execute("success", createInput("explicit", [{ id: "explicit", role: "explorer", objective: "scan", scope: ["."], model: "Explicit 4.6", thinking: "high" }]), undefined, undefined, ctx));
	assert.equal(success.sessions[0]?.result?.route?.selectionSource, "explicit-task");
	const failure = detailsOf(await state.tool.execute("failure", createInput("missing", [{ id: "missing", role: "explorer", objective: "scan", scope: ["."], model: "missing-model", thinking: "high" }]), undefined, undefined, ctx));
	assert.equal(failure.error?.code, "model_not_found");
	assert.equal(failure.requestTelemetry?.launchedChildren, 0);
	assert.equal(calls, 1);
	assert.equal(await readFile(configPath, "utf8"), configBytes);
});

test("rejected graphs fail before configuration or child launch", async (t) => {
	let configCalls = 0;
	let childCalls = 0;
	const { state } = await registered(t, {
		loadConfig: async () => {
			configCalls += 1;
			return { config: defaultConfig() };
		},
		runChild: async (options) => {
			childCalls += 1;
			return successful(options.task);
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("cycle", [
		{ id: "a", role: "explorer", objective: "a", scope: ["."], dependsOn: ["b"] },
		{ id: "b", role: "reviewer", objective: "b", scope: ["."], dependsOn: ["a"] },
	]), undefined, undefined, context()));
	assert.equal(details.error?.code, "dependency_cycle");
	assert.equal(details.requestTelemetry?.launchedChildren, 0);
	assert.equal(details.sessions.length, 0);
	assert.equal(configCalls, 0);
	assert.equal(childCalls, 0);
});

test("a concurrent duplicate submission returns its receipt without launching another child", async (t) => {
	let releaseChild: (() => void) | undefined;
	let markStarted: (() => void) | undefined;
	const childStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	const childReleased = new Promise<void>((resolve) => { releaseChild = resolve; });
	t.after(() => releaseChild?.());
	const { state } = await registered(t, {
		runChild: async (options) => {
			options.onChildStarted?.();
			markStarted?.();
			await childReleased;
			options.onChildSettled?.();
			return { ...successful(options.task), route: options.route };
		},
	});
	const input = createInput("busy", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]);
	const first = state.tool.execute("first", input, undefined, undefined, context());
	await childStarted;
	const second = detailsOf(await state.tool.execute("second", input, undefined, undefined, context()));
	assert.equal(second.status, "accepted");
	assert.equal(second.kind, "submission");
	releaseChild?.();
	assert.equal(detailsOf(await first).status, "succeeded");
});

test("managed guidance appears only while the tool is active and follows the configured level", async () => {
	const options = () => ({ systemPromptOptions: { promptGuidelines: [] as string[] } });
	const state = harness();
	createSubagentsExtension({
		loadConfig: async () => ({ config: defaultConfig() }),
	})(state.pi);
	const aggressiveEvent = { systemPrompt: "base", ...options() };
	assert.equal(await emitBeforeAgentStart(state, aggressiveEvent), undefined);
	assert.ok(aggressiveEvent.systemPromptOptions.promptGuidelines.some((line) => line.includes("flat csheng_subagent_sessions create batch")));
	assert.ok(aggressiveEvent.systemPromptOptions.promptGuidelines.some((line) => line.includes("three or more independent files")));
	assert.ok(aggressiveEvent.systemPromptOptions.promptGuidelines.every((line) => !line.includes("csheng_subagents")));
	await emitBeforeAgentStart(state, aggressiveEvent);
	assert.equal(aggressiveEvent.systemPromptOptions.promptGuidelines.length, 2);
	const balancedState = harness();
	createSubagentsExtension({
		loadConfig: async () => ({ config: { ...defaultConfig(), guidance: "balanced" } }),
	})(balancedState.pi);
	const balancedEvent = { systemPrompt: "base", ...options() };
	await emitBeforeAgentStart(balancedState, balancedEvent);
	assert.ok(balancedEvent.systemPromptOptions.promptGuidelines.some((line) => line.includes("flat csheng_subagent_sessions create batch")));
	assert.ok(balancedEvent.systemPromptOptions.promptGuidelines.every((line) => !line.includes("three or more independent files")));
	const fallback = await emitBeforeAgentStart(state);
	assert.match(fallback?.systemPrompt ?? "", /flat csheng_subagent_sessions create batch/);
	assert.match(fallback?.systemPrompt ?? "", /explicit parent apply/);
	assert.match(fallback?.systemPrompt ?? "", /three or more independent files/);
	assert.doesNotMatch(fallback?.systemPrompt ?? "", /csheng_subagents/);
	state.pi.getActiveTools = () => [];
	assert.equal(await emitBeforeAgentStart(state, { systemPrompt: "base", ...options() }), undefined);
	const off = harness();
	createSubagentsExtension({
		loadConfig: async () => ({ config: { ...defaultConfig(), guidance: "off" } }),
	})(off.pi);
	assert.equal(await emitBeforeAgentStart(off, { systemPrompt: "base", ...options() }), undefined);
});

test("session shutdown waits for the aborted run before a later create", async (t) => {
	let markStarted: (() => void) | undefined;
	let markAborted: (() => void) | undefined;
	let childRuns = 0;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
	const { state } = await registered(t, {
		runChild: async (options) => {
			childRuns += 1;
			options.onChildStarted?.();
			if (childRuns > 1) {
				options.onChildSettled?.();
				return successful(options.task);
			}
			return new Promise<TaskResult>((resolve) => {
				markStarted?.();
				options.signal?.addEventListener("abort", () => {
					markAborted?.();
					options.onChildSettled?.();
					resolve({ ...successful(options.task), status: "aborted", error: { code: "aborted", message: "aborted" } });
				}, { once: true });
			});
		},
	});
	const execution = state.tool.execute("call", createInput("abort", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), undefined, undefined, context());
	await started;

	let shutdownSettled = false;
	const shutdown = Promise.all((state.handlers.get("session_shutdown") ?? []).map((handler) => handler({}))).then(() => { shutdownSettled = true; });
	await aborted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(shutdownSettled, false);

	await shutdown;
	const result = detailsOf(await execution);
	assert.equal(shutdownSettled, true);
	assert.equal(result.status, "aborted");

	const closed = detailsOf(await state.tool.execute("closed", createInput("closed", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), undefined, undefined, context()));
	assert.equal(closed.error?.code, "supervisor_closed");
	for (const handler of state.handlers.get("session_start") ?? []) await handler({}, context());
	const next = detailsOf(await state.tool.execute("next", createInput("next", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), undefined, undefined, context()));
	assert.equal(next.status, "succeeded");
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
	const { state } = await registered(t, {
		runChild: async (options) => {
			options.onChildStarted?.();
			options.onChildSettled?.();
			seen.push(options);
			return { ...successful(options.task), route: options.route };
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("canon", [{
		id: "scan",
		role: "explorer",
		objective: "scan",
		scope: [gitRoot, join(gitRoot, "src"), `../${basename(current)}/src/tracked.ts`],
	}]), undefined, undefined, context(true, [parentModel], current)));
	assert.equal(details.status, "succeeded");
	assert.deepEqual(seen[0]?.task.scope, [".", "src", "src/tracked.ts"]);
	assert.notEqual(seen[0]?.cwd, gitRoot);
	assert.equal(seen[0]?.capability.root, seen[0]?.cwd);
	assert.equal(await readFile(join(seen[0]!.cwd, "src/tracked.ts"), "utf8"), "tracked\n");
	assert.equal(seen[0]?.capability.version, 2);
	assert.deepEqual(seen[0]?.capability.externalReadRoots, []);
});

test("narrow worker scope is refused as repo-wide managed worker authority", async (t) => {
	const { current } = await gitPair(t);
	let childCalls = 0;
	const { state } = await registered(t, {
		runChild: async (options) => {
			childCalls += 1;
			return successful(options.task);
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("narrow", [{
		id: "write",
		role: "worker",
		objective: "write",
		scope: ["src/new.ts"],
		writePaths: ["src/new.ts"],
	}]), undefined, undefined, context(true, [parentModel], current)));
	assert.equal(details.error?.code, "full_worker_scope_required");
	assert.equal(details.requestTelemetry?.launchedChildren, 0);
	assert.equal(childCalls, 0);
});

test("sibling, non-Git, unsafe, and invalid external roots fail without child work", async (t) => {
	const { current, sibling } = await gitPair(t);
	const plain = await mkdtemp(join(tmpdir(), "subagent-ext-plain-"));
	t.after(async () => rm(plain, { recursive: true, force: true }));
	for (const [cwd, tasks, code, configBeforeAdmit] of [
		[current, [{ id: "scan", role: "explorer", objective: "scan", scope: [sibling] }], "scope_outside_repository", true],
		[plain, [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }], "repository_root_unavailable", false],
		[current, [{ id: "scan", role: "explorer", objective: "scan", scope: ["bad\0path"] }], "invalid_scope", false],
		[current, [{ id: "scan", role: "explorer", objective: "scan", scope: ["."], externalReadRoots: [join(current, "src")] }], "external_read_root_not_external", true],
	] as const) {
		let configCalls = 0;
		let childCalls = 0;
		const { state } = await registered(t, {
			loadConfig: async () => {
				configCalls += 1;
				return { config: defaultConfig() };
			},
			runChild: async (options) => {
				childCalls += 1;
				return successful(options.task);
			},
		});
		const result = await state.tool.execute("call", createInput(`admit-${code}`, [...tasks]), undefined, undefined, context(true, [parentModel], cwd));
		const details = detailsOf(result);
		assert.equal(details.error?.code, code, code);
		assert.equal(details.requestTelemetry?.launchedChildren, 0);
		assert.equal(details.sessions.length, 0);
		assert.doesNotMatch(result.content[0].text, /\/tmp\/|secret\.ts/);
		assert.equal(configCalls > 0, configBeforeAdmit, code);
		assert.equal(childCalls, 0);
	}
});

test("projected prompt bounds reject the whole batch before config or launch", async (t) => {
	let configCalls = 0;
	let childCalls = 0;
	const { state } = await registered(t, {
		loadConfig: async () => {
			configCalls += 1;
			return { config: defaultConfig() };
		},
		runChild: async (options) => {
			childCalls += 1;
			return successful(options.task);
		},
	});
	const predecessors = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, role: "explorer" as const, objective: "p", scope: ["."] }));
	const details = detailsOf(await state.tool.execute("call", createInput("prompt", [
		...predecessors,
		{ id: "oversized", role: "reviewer", objective: "review", scope: ["."], dependsOn: predecessors.map((task) => task.id) },
	]), undefined, undefined, context()));
	assert.equal(details.error?.code, "prompt_too_large");
	assert.ok(8 * HARD_LIMITS.maxPredecessorOutputBytes + "review".length > HARD_LIMITS.maxPromptBytes);
	assert.equal(details.requestTelemetry?.launchedChildren, 0);
	assert.equal(details.sessions.length, 0);
	assert.equal(configCalls, 0);
	assert.equal(childCalls, 0);
});

test("explorer and reviewer external roots reach only task and capability fields", async (t) => {
	const { current, siblingFile } = await gitPair(t);
	const seen: any[] = [];
	const updates: string[] = [];
	const { state } = await registered(t, {
		runChild: async (options) => {
			options.onChildStarted?.();
			options.onChildSettled?.();
			seen.push(options);
			return {
				...successful(options.task),
				output: `echo:${siblingFile}`,
				route: options.route,
			};
		},
	});
	const result = await state.tool.execute("call", createInput("external", [
		{ id: "scan", role: "explorer", objective: "scan", scope: ["."], externalReadRoots: [siblingFile] },
		{ id: "review", role: "reviewer", objective: "review", scope: ["src"], externalReadRoots: [siblingFile] },
	]), undefined, (update: any) => updates.push(update.content[0].text), context(true, [parentModel], current));
	const details = detailsOf(result);
	assert.equal(details.status, "succeeded", JSON.stringify(details.sessions.map(view => ({ error: view.requestError, resultError: view.result?.error }))));
	assert.deepEqual(seen[0]?.task.externalReadRoots, [siblingFile]);
	assert.deepEqual(seen[0]?.capability.externalReadRoots, [siblingFile]);
	assert.notEqual(seen[0]?.cwd, await realpath(current));
	assert.equal(seen[0]?.capability.root, seen[0]?.cwd);
	assert.deepEqual(seen[0]?.capability.writePaths, []);
	assert.deepEqual(seen[1]?.task.externalReadRoots, [siblingFile]);
	assert.ok(updates.every((message) => !message.includes(siblingFile)));
	assert.equal(JSON.stringify(details.requestTelemetry).includes(siblingFile), false);
	assert.equal(details.sessions[0]?.result?.output, `echo:${siblingFile}`);
});

test("managed TUI progress publishes route and actual launches; replay publishes no new run", async (t) => {
	const snapshots: import("../extensions/subagents/observer-events.ts").ObserverSnapshot[] = [];
	const { state } = await registered(t, { onObserver: value => snapshots.push(value), runChild: async options => {
		options.onChildStarted?.(); options.onChildSettled?.();
		return { ...successful(options.task), route: options.route };
	} });
	const ctx = { ...context(), mode: "tui" };
	const input = { ...createInput("observer", [{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }]), mode: "foreground" };
	const first = await state.tool.execute("call", input, undefined, undefined, ctx);
	assert.equal(first.details.status, "succeeded");
	assert.ok(snapshots.some(value => value.activeChildren === 1));
	assert.equal(snapshots.at(-1)?.phase, "settled");
	assert.equal(snapshots.at(-1)?.launchedChildren, 1);
	assert.equal(snapshots.at(-1)?.tasks[0]?.route?.model, parentModel.id);
	assert.equal(snapshots.at(-1)?.tasks[0]?.assistantTurns, 1);
	assert.equal(snapshots.at(-1)?.tasks[0]?.headline, "scan");
	const length = snapshots.length;
	const replay = await state.tool.execute("replay", input, undefined, undefined, ctx);
	assert.equal(replay.details.requestTelemetry.launchedChildren, 0);
	assert.equal(snapshots.length, length);
	const second = await state.tool.execute("second", { ...createInput("second", [{ id: "other", role: "reviewer", objective: "other", scope: ["."] }]), mode: "foreground" }, undefined, undefined, ctx);
	assert.equal(second.details.status, "succeeded");
	assert.ok(snapshots[length]!.revision > snapshots[length - 1]!.revision, "revisions must increase across runs in one generation");
	assert.equal(snapshots[length]!.generation, snapshots[0]!.generation);
	const handle = first.details.sessions[0]!.handle;
	const episode = { handle, requestId: "episode-two", expectedEpisode: 1, message: "second scan" };
	const two = await state.tool.execute("two", { action: "continue", mode: "foreground", episodes: [episode] }, undefined, undefined, ctx);
	assert.equal(two.details.status, "succeeded");
	const three = await state.tool.execute("three", { action: "continue", mode: "foreground", episodes: [{ handle, requestId: "episode-three", expectedEpisode: 2, message: "third scan" }] }, undefined, undefined, ctx);
	assert.equal(three.details.status, "succeeded");
	const mixedStart = snapshots.length;
	const mixed = await state.tool.execute("mixed", { action: "continue", mode: "foreground", episodes: [episode, { handle: second.details.sessions[0]!.handle, requestId: "other-two", expectedEpisode: 1, message: "fresh review" }] }, undefined, undefined, ctx);
	assert.equal(mixed.details.status, "succeeded");
	assert.equal(mixed.details.requestTelemetry.launchedChildren, 1);
	for (const snapshot of snapshots.slice(mixedStart)) {
		const cached = snapshot.tasks.find(row => row.id === handle)!;
		assert.equal(cached.episode, 2, "cached evidence retains its historical episode, not current ep3");
		assert.equal(cached.replayed, true);
	}
});

test("worker external roots are rejected before a child starts", async (t) => {
	const { current, siblingFile } = await gitPair(t);
	let childCalls = 0;
	const { state } = await registered(t, {
		runChild: async (options) => {
			childCalls += 1;
			return successful(options.task);
		},
	});
	const details = detailsOf(await state.tool.execute("call", createInput("worker-external", [{
		id: "write",
		role: "worker",
		objective: "write",
		scope: ["."],
		writePaths: ["src/tracked.ts"],
		externalReadRoots: [siblingFile],
	}]), undefined, undefined, context(true, [parentModel], current)));
	assert.equal(details.error?.code, "external_read_roots_forbidden");
	assert.equal(details.requestTelemetry?.launchedChildren, 0);
	assert.equal(childCalls, 0);
});
