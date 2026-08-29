import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_STATUS_COMMAND,
	SUBAGENT_TOOL_NAME,
	SubagentToolSchema,
	TELEMETRY_SCHEMA_VERSION,
	emptyTaskTelemetry,
	emptyUsage,
	type ChildCapabilityManifest,
	type RunTelemetry,
	type RoleName,
	type SubagentRunResult,
	type SubagentToolInput,
	type TaskResult,
} from "./contracts.ts";
import { loadConfig, type ConfigLoadResult, type EffectiveSubagentConfig } from "./config.ts";
import { validateGraph, type NormalizedTask } from "./graph.ts";
import { boundToolContent, formatProgress, formatRunResult } from "./render.ts";
import { resolveRoute, type RouteContext, type RouteResolution } from "./routing.ts";
import { getRole } from "./roles.ts";
import { runChild, type ChildRunOptions } from "./runner.ts";
import { runScheduledTasks } from "./scheduler.ts";
import {
	convergeWorkerWorkspace,
	createWorkerWorkspace,
	type ConvergenceResult,
	type WorkerWorkspace,
} from "./workspace.ts";

const GUARD_EXTENSION_PATH = fileURLToPath(new URL("./child-capability-guard.ts", import.meta.url));

export interface SubagentDependencies {
	loadConfig(): Promise<ConfigLoadResult>;
	createWorkerWorkspace(cwd: string, task: NormalizedTask): Promise<WorkerWorkspace>;
	convergeWorkerWorkspace(workspace: WorkerWorkspace): Promise<ConvergenceResult>;
	runChild(options: ChildRunOptions): Promise<TaskResult>;
	guardExtensionPath: string;
}

const DEFAULT_DEPENDENCIES: SubagentDependencies = {
	loadConfig,
	createWorkerWorkspace,
	convergeWorkerWorkspace,
	runChild,
	guardExtensionPath: GUARD_EXTENSION_PATH,
};

function failureResult(task: NormalizedTask, code: string, message: string, route?: TaskResult["route"]): TaskResult {
	return {
		id: task.id,
		role: task.role,
		status: "failed",
		output: "",
		stderr: "",
		usage: emptyUsage(),
		durationMs: 0,
		changedPaths: [],
		convergence: "not-applicable",
		telemetry: emptyTaskTelemetry(),
		...(route === undefined ? {} : { route }),
		error: { code, message },
	};
}

interface RunIdentity {
	runId: string;
	started: number;
	requestedTasks: number;
}

function failedTelemetry(identity: RunIdentity, admittedTasks: number, code: string): RunTelemetry {
	return {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		runId: identity.runId,
		runDurationMs: Math.max(0, Date.now() - identity.started),
		requestedTasks: identity.requestedTasks,
		admittedTasks,
		launchedChildren: 0,
		peakConcurrency: 0,
		peakConcurrencyByRole: { explorer: 0, reviewer: 0, worker: 0 },
		runErrorCode: code,
	};
}

function aggregateFailure(
	tasks: readonly NormalizedTask[],
	code: string,
	message: string,
	identity: RunIdentity,
	admittedTasks = tasks.length,
): SubagentRunResult {
	return {
		status: "failed",
		tasks: tasks.map((task) => failureResult(task, code, message)),
		usage: emptyUsage(),
		telemetry: failedTelemetry(identity, admittedTasks, code),
	};
}

function finalToolResult(result: SubagentRunResult, text = formatRunResult(result)): AgentToolResult<SubagentRunResult> {
	return { content: [{ type: "text", text: boundToolContent(text) }], details: result };
}

function isSubagentRunResult(value: unknown): value is SubagentRunResult {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.status === "succeeded" || record.status === "partial" || record.status === "failed" || record.status === "aborted") &&
		Array.isArray(record.tasks) &&
		typeof record.usage === "object" && record.usage !== null &&
		typeof record.telemetry === "object" && record.telemetry !== null
	);
}

function routeContext(ctx: ExtensionContext): RouteContext {
	return {
		...(ctx.model === undefined ? {} : { parentModel: ctx.model as NonNullable<RouteContext["parentModel"]> }),
		...(ctx.thinkingLevel === undefined ? {} : { parentThinking: ctx.thinkingLevel }),
		scopedModels: ctx.scopedModels as RouteContext["scopedModels"],
		modelRegistry: ctx.modelRegistry as unknown as RouteContext["modelRegistry"],
	};
}

function buildInputs(task: NormalizedTask, predecessors: readonly TaskResult[]): string {
	const blocks = [...task.inputs];
	for (const predecessor of predecessors) {
		blocks.push(`Predecessor ${predecessor.id} (${predecessor.status}):\n${predecessor.output || "(no output)"}`);
	}
	return blocks.join("\n\n");
}

function capability(root: string, task: NormalizedTask): ChildCapabilityManifest {
	return {
		version: 1,
		root,
		role: task.role,
		readRoots: task.scope.map((entry) => resolve(root, entry)),
		writePaths: task.writePaths.map((entry) => resolve(root, entry)),
	};
}

function guidance(config: EffectiveSubagentConfig): string | undefined {
	if (config.guidance === "off") return undefined;
	if (config.guidance === "balanced") {
		return "When repository work has clearly independent bounded slices, consider csheng_subagents. Keep synthesis, verification, authority, and continuation in the parent turn.";
	}
	return "Prefer csheng_subagents when two or more independent bounded repository slices can run concurrently. Do not delegate trivial work or parent-owned synthesis, verification, authority, adjudication, repair decisions, continuation, or the final response.";
}

function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	const abort = () => target.abort();
	if (source.aborted) abort();
	else source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

export function createSubagentsExtension(overrides: Partial<SubagentDependencies> = {}): (pi: ExtensionAPI) => void {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	return function subagentsExtension(pi: ExtensionAPI): void {
		let activeController: AbortController | undefined;
		let activeRun: Promise<void> | undefined;
		let activeChildren = 0;

		pi.registerTool({
			name: SUBAGENT_TOOL_NAME,
			label: "Csheng Subagents",
			description: "Run one bounded foreground DAG of fixed explorer, reviewer, or isolated worker children. Use it proactively for independent slices; the parent retains synthesis, verification, authority, review adjudication, continuation, and the final response.",
			parameters: SubagentToolSchema,
			async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
				const params = rawParams as SubagentToolInput;
				const identity: RunIdentity = {
					runId: randomUUID(),
					started: Date.now(),
					requestedTasks: Array.isArray(params.tasks) ? params.tasks.length : 0,
				};
				const validation = validateGraph(params);
				if (!validation.ok) {
					const result: SubagentRunResult = {
						status: "failed",
						tasks: [],
						usage: emptyUsage(),
						telemetry: failedTelemetry(identity, 0, validation.error.code),
					};
					return finalToolResult(result, `Subagent graph rejected (${validation.error.code}): ${validation.error.message}`);
				}
				if (!ctx.isProjectTrusted()) {
					const result = aggregateFailure(validation.tasks, "project_trust_required", "Subagent dispatch requires a trusted parent project.", identity);
					return finalToolResult(result);
				}
				if (activeController) {
					const result = aggregateFailure(validation.tasks, "subagent_run_active", "Another subagent graph is already active in this session.", identity);
					return finalToolResult(result);
				}
				const controller = new AbortController();
				const unlink = linkAbort(signal, controller);
				let settleActiveRun: (() => void) | undefined;
				const runSettlement = new Promise<void>((resolve) => { settleActiveRun = resolve; });
				activeController = controller;
				activeRun = runSettlement;
				try {
				const loaded = await dependencies.loadConfig();
				if (!loaded.config) {
					const result = aggregateFailure(validation.tasks, loaded.diagnostic?.code ?? "invalid_route_config", loaded.diagnostic?.message ?? "Route configuration is unavailable.", identity);
					return finalToolResult(result);
				}
				const config = loaded.config;
				const routes = new Map<string, Extract<RouteResolution, { ok: true }>>();
				for (const task of validation.tasks) {
					const selected = resolveRoute(task.role, config, routeContext(ctx), {
						...(task.executionProfile === undefined ? {} : { executionProfile: task.executionProfile }),
						...(task.reasoningProfile === undefined ? {} : { reasoningProfile: task.reasoningProfile }),
					});
					if (!selected.ok) {
						const result = aggregateFailure(validation.tasks, selected.error.code, selected.error.message, identity);
						return finalToolResult(result);
					}
					routes.set(task.id, selected);
				}

				let readOnlyRoot: string;
				try {
					readOnlyRoot = await realpath(ctx.cwd);
				} catch (error) {
					const result = aggregateFailure(validation.tasks, "workspace_unavailable", error instanceof Error ? error.message : String(error), identity);
					return finalToolResult(result);
				}

					const result = await runScheduledTasks(validation.tasks, {
						runId: identity.runId,
						requestedTasks: identity.requestedTasks,
						maxConcurrency: config.maxConcurrency,
						roleLimits: {
							explorer: config.routes.explorer.maxConcurrency,
							reviewer: config.routes.reviewer.maxConcurrency,
							worker: config.routes.worker.maxConcurrency,
						},
						signal: controller.signal,
						onChildConcurrency(count) {
							activeChildren = count;
						},
						onUpdate(results) {
							onUpdate?.({ content: [{ type: "text", text: formatProgress(results) }], details: { status: "running", tasks: results, usage: emptyUsage() } });
						},
						async execute(task, predecessors, childSignal, lifecycle) {
							const selected = routes.get(task.id) as Extract<RouteResolution, { ok: true }>;
							let workspace: WorkerWorkspace | undefined;
							let workspaceMs = 0;
							let workspaceStarted: number | undefined;
							try {
								if (task.role === "worker") {
									workspaceStarted = Date.now();
									workspace = await dependencies.createWorkerWorkspace(ctx.cwd, task);
									workspaceMs = Math.max(0, Date.now() - workspaceStarted);
								}
								const root = workspace?.root ?? readOnlyRoot;
								const childStarted = Date.now();
								const childResult = await dependencies.runChild({
									task,
									role: getRole(task.role),
									route: selected.route,
									cwd: root,
									guardExtensionPath: dependencies.guardExtensionPath,
									capability: capability(root, task),
									prompt: buildInputs(task, predecessors),
									approveProject: true,
									signal: childSignal,
									onChildStarted: lifecycle.childStarted,
									onChildSettled: lifecycle.childSettled,
								});
								const telemetry = {
									...emptyTaskTelemetry(),
									...childResult.telemetry,
									childStarted: childResult.telemetry?.childStarted ?? true,
									workspaceMs,
									childMs: childResult.telemetry?.childMs ?? Math.max(0, Date.now() - childStarted),
								};
								if (!workspace || childResult.status !== "succeeded") {
									return {
										...childResult,
										telemetry,
										...(workspace ? { convergence: "not-applied" as const } : {}),
									};
								}
								const convergenceStarted = Date.now();
								const converged = await dependencies.convergeWorkerWorkspace(workspace);
								telemetry.convergenceMs = Math.max(0, Date.now() - convergenceStarted);
								if (!converged.ok) {
									return {
										...childResult,
										status: "failed" as const,
										changedPaths: converged.changedPaths,
										convergence: converged.error?.code === "convergence_conflict" ? "conflict" as const : "not-applied" as const,
										telemetry,
										error: converged.error ?? { code: "convergence_failed", message: "Worker convergence failed." },
									};
								}
								return { ...childResult, changedPaths: converged.changedPaths, convergence: "applied" as const, telemetry };
							} catch (error) {
								if (workspaceStarted !== undefined && workspaceMs === 0) {
									workspaceMs = Math.max(0, Date.now() - workspaceStarted);
								}
								const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "worker_execution_failed";
								return {
									...failureResult(task, code, error instanceof Error ? error.message : String(error), selected.route),
									telemetry: { ...emptyTaskTelemetry(), workspaceMs },
								};
							} finally {
								await workspace?.cleanup();
							}
						},
					});
					return finalToolResult(result);
				} finally {
					activeChildren = 0;
					unlink();
					activeController = undefined;
					if (activeRun === runSettlement) activeRun = undefined;
					settleActiveRun?.();
				}
			},
		});

		pi.on("tool_result", async (event) => {
			if (event.toolName !== SUBAGENT_TOOL_NAME || !isSubagentRunResult(event.details)) return undefined;
			return { isError: event.details.status !== "succeeded" };
		});

		pi.registerCommand(SUBAGENT_STATUS_COMMAND, {
			description: "Show effective subagent guidance, routes, caps, and active-child count",
			handler: async (_args, ctx) => {
				const loaded = await dependencies.loadConfig();
				if (!loaded.config) {
					ctx.ui.notify(`Subagents unavailable: ${loaded.diagnostic?.message ?? "invalid configuration"}`, "error");
					return;
				}
				const lines = [`guidance=${loaded.config.guidance}`, `maxConcurrency=${loaded.config.maxConcurrency}`, `activeChildren=${activeChildren}`];
				for (const role of ["explorer", "reviewer", "worker"] as const satisfies readonly RoleName[]) {
					const selected = resolveRoute(role, loaded.config, routeContext(ctx));
					lines.push(selected.ok
						? `${role}=${selected.route.provider}/${selected.route.model}:${selected.route.thinking} source=${selected.route.source} max=${loaded.config.routes[role].maxConcurrency}`
						: `${role}=unavailable max=${loaded.config.routes[role].maxConcurrency}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.on("before_agent_start", async (event) => {
			if (!pi.getActiveTools().includes(SUBAGENT_TOOL_NAME)) return undefined;
			const loaded = await dependencies.loadConfig();
			if (!loaded.config) return undefined;
			const instruction = guidance(loaded.config);
			return instruction ? { systemPrompt: `${event.systemPrompt}\n\n${instruction}` } : undefined;
		});

		pi.on("session_shutdown", async () => {
			const settlingRun = activeRun;
			activeController?.abort();
			await settlingRun;
		});
	};
}

export default createSubagentsExtension();
