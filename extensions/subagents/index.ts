import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HARD_LIMITS,
	SUBAGENT_DEBUG_COMMAND,
	SUBAGENT_STATUS_COMMAND,
	SUBAGENT_TOOL_NAME,
	SubagentToolSchema,
	TELEMETRY_SCHEMA_VERSION,
	emptyTaskTelemetry,
	emptyUsage,
	type NormalizedChildCapability,
	type ProvenanceTelemetry,
	type RunTelemetry,
	type RoleName,
	type SubagentRunResult,
	type SubagentToolInput,
	type TaskExecutionPhase,
	type TaskResult,
} from "./contracts.ts";
import { loadConfig, type ConfigLoadResult, type EffectiveSubagentConfig } from "./config.ts";
import { buildSnapshot } from "./activity.ts";
import {
	CANCEL_RECEIPT_EVENT,
	CANCEL_REQUEST_EVENT,
	SNAPSHOT_EVENT,
	parseCancelRequest,
	type CancelReceiptOutcome,
} from "./events.ts";
import { createProvenance, type ProvenanceCore } from "./provenance.ts";
import { DiagnosticStore, renderDiagnosticInspection, type DiagnosticRun, type DiagnosticStoreLike } from "./diagnostics.ts";
import { validateGraphRelationships, validateGraphStructure, type NormalizedTask } from "./graph.ts";
import { admitRepositoryTasks, defaultRepositoryHost, type RepositoryHost } from "./repository-policy.ts";
import { boundToolContent, formatProgress, formatRunResult } from "./render.ts";
import { resolveRoute, type RouteContext, type RouteResolution } from "./routing.ts";
import { getRole } from "./roles.ts";
import { buildChildPrompt, runChild, type ChildRunOptions } from "./runner.ts";
import { runScheduledTasks } from "./scheduler.ts";
import { createRunClock, type RunClock } from "./telemetry.ts";
import { registerObservationHooks } from "./observation-hooks.ts";
import { registerContinuationTool } from "./continuation.ts";
import {
	convergeWorkerWorkspace,
	createWorkerWorkspace,
	type ConvergenceResult,
	type WorkerWorkspace,
} from "./workspace.ts";

const GUARD_EXTENSION_PATH = fileURLToPath(new URL("./child-capability-guard.ts", import.meta.url));

export interface SubagentDependencies {
	now(): number;
	loadConfig(): Promise<ConfigLoadResult>;
	createWorkerWorkspace(cwd: string, task: NormalizedTask): Promise<WorkerWorkspace>;
	convergeWorkerWorkspace(workspace: WorkerWorkspace): Promise<ConvergenceResult>;
	runChild(options: ChildRunOptions): Promise<TaskResult>;
	createDiagnosticStore(): DiagnosticStoreLike;
	createProvenance?(): ProvenanceCore;
	guardExtensionPath: string;
	repositoryHost: RepositoryHost;
}

const DEFAULT_DEPENDENCIES: SubagentDependencies = {
	now: () => performance.now(),
	loadConfig,
	createWorkerWorkspace,
	convergeWorkerWorkspace,
	runChild,
	createDiagnosticStore: () => new DiagnosticStore(getAgentDir()),
	guardExtensionPath: GUARD_EXTENSION_PATH,
	repositoryHost: defaultRepositoryHost,
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
	clock: RunClock;
	startedAtMs: number;
	requestedTasks: number;
	requestedDependencyEdges: number;
	explicitModelTasks: number;
	explicitThinkingTasks: number;
}

function dependencyEdges(tasks: readonly Pick<SubagentToolInput["tasks"][number], "dependsOn">[]): number {
	return tasks.reduce((total, task) => total + (task.dependsOn?.length ?? 0), 0);
}

function failedTelemetry(
	identity: RunIdentity,
	admittedTasks: number,
	admittedDependencyEdges: number,
	code: string,
	provenance: ProvenanceTelemetry = { available: false },
	effectiveMaxConcurrency?: number,
): RunTelemetry {
	return {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		runId: identity.runId,
		runDurationMs: identity.clock.elapsed(),
		timing: { boundary: "tool-entry", scheduler: null, children: [], waits: [], complete: identity.clock.valid },
		requestedTasks: identity.requestedTasks,
		admittedTasks,
		requestedDependencyEdges: identity.requestedDependencyEdges,
		admittedDependencyEdges,
		explicitModelTasks: identity.explicitModelTasks,
		explicitThinkingTasks: identity.explicitThinkingTasks,
		launchedChildren: 0,
		peakConcurrency: 0,
		peakConcurrencyByRole: { explorer: 0, reviewer: 0, worker: 0 },
		startedAtMs: identity.startedAtMs,
		provenance,
		runErrorCode: code,
		...(effectiveMaxConcurrency === undefined ? {} : { effectiveMaxConcurrency }),
	};
}

function aggregateFailure(
	tasks: readonly NormalizedTask[],
	code: string,
	message: string,
	identity: RunIdentity,
	admittedTasks = tasks.length,
	provenance: ProvenanceTelemetry = { available: false },
): SubagentRunResult {
	return {
		status: "failed",
		tasks: tasks.map((task) => failureResult(task, code, message)),
		usage: emptyUsage(),
		telemetry: failedTelemetry(identity, admittedTasks, dependencyEdges(tasks), code, provenance),
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

const MAXIMUM_PREDECESSOR_OUTPUT = "x".repeat(HARD_LIMITS.maxPredecessorOutputBytes);

function projectedCompletePrompt(task: NormalizedTask): string {
	const blocks = [...task.inputs];
	for (const dependency of task.dependsOn) {
		blocks.push(`Predecessor ${dependency} (succeeded):\n${MAXIMUM_PREDECESSOR_OUTPUT}`);
	}
	return buildChildPrompt(task, blocks.join("\n\n"));
}

function attachResolvedRoutes(
	results: readonly TaskResult[],
	routes: ReadonlyMap<string, Extract<RouteResolution, { ok: true }>>,
): TaskResult[] {
	return results.map((result) => {
		const selected = routes.get(result.id);
		return result.route || !selected ? result : { ...result, route: selected.route };
	});
}

function capability(root: string, task: NormalizedTask): NormalizedChildCapability {
	return {
		version: 2,
		root,
		role: task.role,
		readRoots: task.scope.map((entry) => resolve(root, entry)),
		writePaths: task.writePaths.map((entry) => resolve(root, entry)),
		externalReadRoots: task.role === "worker" ? [] : [...(task.externalReadRoots ?? [])],
	};
}

function guidance(config: EffectiveSubagentConfig): string | undefined {
	if (config.guidance === "off") return undefined;
	if (config.guidance === "balanced") {
		return "When repository work has two or more clearly independent bounded slices, consider one flat csheng_subagents batch. A singleton is for a required isolated worker or independent reviewer, not ordinary offload. Keep synthesis, verification, authority, and continuation in the parent turn.";
	}
	return "Prefer one flat csheng_subagents batch when two or more independent bounded repository slices can run concurrently. Reserve singletons for a required isolated worker or independent reviewer. Do not delegate trivial work or parent-owned synthesis, verification, authority, adjudication, repair decisions, continuation, or the final response.";
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
		const diagnosticStore = dependencies.createDiagnosticStore();
		const provenance = dependencies.createProvenance?.() ?? createProvenance();
		let activeController: AbortController | undefined;
		let activeRun: Promise<void> | undefined;
		let activeChildren = 0;
		let activeRunId: string | undefined;
		let activeCancellation = false;
		let activeControl: { cancelTask(taskId: string): CancelReceiptOutcome; cancelRun(): CancelReceiptOutcome; enterConvergence(taskId: string): boolean; setExecutionPhase(taskId: string, phase: Exclude<TaskExecutionPhase, "convergence-critical" | "settled">): void } | undefined;
		const activePhases = new Map<string, TaskExecutionPhase>();
		let extensionProvenance: ProvenanceTelemetry = { available: false };


		const emitReceipt = (requestId: string, runId: string, target: "run" | "task", outcome: CancelReceiptOutcome, taskId?: string) => {
			pi.events.emit(CANCEL_RECEIPT_EVENT, {
				version: 1,
				requestId,
				runId,
				target,
				outcome,
				...(taskId === undefined ? {} : { taskId }),
			});
		};

		pi.events.on(CANCEL_REQUEST_EVENT, (data) => {
			const parsed = parseCancelRequest(data);
			if (!parsed.ok) return;
			const request = parsed.value;
			if (!activeRunId || request.runId !== activeRunId || !activeControl) {
				emitReceipt(request.requestId, request.runId, request.target, activeRunId ? "already-settled" : "not-active", request.taskId);
				return;
			}
			const outcome = request.target === "run" ? activeControl.cancelRun() : activeControl.cancelTask(request.taskId ?? "");
			if (outcome === "accepted" && request.target === "run") activeCancellation = true;
			emitReceipt(request.requestId, request.runId, request.target, outcome, request.taskId);
		});

		pi.registerTool({
			name: SUBAGENT_TOOL_NAME,
			label: "Csheng Subagents",
			description: "Run one bounded foreground batch of fixed explorer, reviewer, or isolated worker children. Keep ordinary work flat; use hard predecessor edges only for approved implementation order with no intervening parent decision.",
			parameters: SubagentToolSchema,
			async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
				const clock = createRunClock(dependencies.now);
				const executeBatch = async () => {
				// Defer rendering and final timing until diagnostic cleanup has settled.
				const finalToolResult = (result: SubagentRunResult, text?: string) => ({ result, text });
				const params = rawParams as SubagentToolInput;
				const requestedTasks = Array.isArray(params.tasks) ? params.tasks : [];
				const identity: RunIdentity = {
					runId: randomUUID(),
					clock,
					startedAtMs: Date.now(),
					requestedTasks: requestedTasks.length,
					requestedDependencyEdges: dependencyEdges(requestedTasks),
					explicitModelTasks: requestedTasks.filter((task) => task.model !== undefined).length,
					explicitThinkingTasks: requestedTasks.filter((task) => task.thinking !== undefined).length,
				};
				let runProvenance: ProvenanceTelemetry = { available: false };
				try {
					runProvenance = await provenance.observeExtension();
					extensionProvenance = runProvenance;
				} catch {
					runProvenance = { available: false };
					extensionProvenance = runProvenance;
				}
				const validation = validateGraphStructure(params);
				if (!validation.ok) {
					const result: SubagentRunResult = {
						status: "failed",
						tasks: [],
						usage: emptyUsage(),
						telemetry: failedTelemetry(identity, 0, 0, validation.error.code, runProvenance),
					};
					return finalToolResult(result, `Subagent graph rejected (${validation.error.code}): ${validation.error.message}`);
				}
				if (!ctx.isProjectTrusted()) {
					const result = aggregateFailure(validation.tasks, "project_trust_required", "Subagent dispatch requires a trusted parent project.", identity, validation.tasks.length, runProvenance);
					return finalToolResult(result);
				}
				if (activeController || managed.busy) {
					const result = aggregateFailure(validation.tasks, "subagent_run_active", "Another subagent graph is already active in this session.", identity, validation.tasks.length, runProvenance);
					return finalToolResult(result);
				}
				const controller = new AbortController();
				const unlink = linkAbort(signal, controller);
				let settleActiveRun: (() => void) | undefined;
				const runSettlement = new Promise<void>((resolve) => { settleActiveRun = resolve; });
				activeController = controller;
				activeRun = runSettlement;
				activeRunId = identity.runId;
				activeCancellation = false;
				activePhases.clear();
				let diagnosticRun: DiagnosticRun | undefined;
				let runLimitExceeded = false;
				let runLimitCheckActive = false;
				const limitedTaskIds = new Set<string>();
				const taskDiagnosticChecks = new Map<string, { sessionPath: string; controller: AbortController; checking: boolean }>();
				try {
				const admitted = await admitRepositoryTasks(ctx.cwd, validation.tasks, dependencies.repositoryHost);
				if (!admitted.ok) {
					const result: SubagentRunResult = {
						status: "failed",
						tasks: [],
						usage: emptyUsage(),
						telemetry: failedTelemetry(identity, 0, 0, admitted.error.code),
					};
					return finalToolResult(result, `Subagent graph rejected (${admitted.error.code}): ${admitted.error.message}`);
				}
				const related = validateGraphRelationships(admitted.tasks);
				if (!related.ok) {
					const result: SubagentRunResult = {
						status: "failed",
						tasks: [],
						usage: emptyUsage(),
						telemetry: failedTelemetry(identity, 0, 0, related.error.code),
					};
					return finalToolResult(result, `Subagent graph rejected (${related.error.code}): ${related.error.message}`);
				}
				const tasks = related.tasks;
				const oversizedPrompt = tasks.find((task) => Buffer.byteLength(projectedCompletePrompt(task), "utf8") > HARD_LIMITS.maxPromptBytes);
				if (oversizedPrompt) {
					const result: SubagentRunResult = {
						status: "failed",
						tasks: [],
						usage: emptyUsage(),
						telemetry: failedTelemetry(identity, 0, 0, "prompt_too_large"),
					};
					return finalToolResult(result, `Subagent graph rejected (prompt_too_large): Task ${oversizedPrompt.id} complete projected prompt exceeds the byte limit.`);
				}
				const loaded = await dependencies.loadConfig();
				if (loaded.source) {
					try {
						runProvenance = await provenance.observeConfiguration(loaded.source);
					} catch {
						runProvenance = { available: false };
					}
				} else {
					runProvenance = { available: false };
				}
				extensionProvenance = runProvenance;
				if (!loaded.config) {
					const result = aggregateFailure(tasks, loaded.diagnostic?.code ?? "invalid_route_config", loaded.diagnostic?.message ?? "Route configuration is unavailable.", identity, tasks.length, runProvenance);
					return finalToolResult(result);
				}
				const config = loaded.config;
				const routes = new Map<string, Extract<RouteResolution, { ok: true }>>();
				for (const task of tasks) {
					const selected = resolveRoute(task.role, config, routeContext(ctx), {
						...(task.executionProfile === undefined ? {} : { executionProfile: task.executionProfile }),
						...(task.reasoningProfile === undefined ? {} : { reasoningProfile: task.reasoningProfile }),
						...(task.model === undefined ? {} : { model: task.model }),
						...(task.thinking === undefined ? {} : { thinking: task.thinking }),
					});
					if (!selected.ok) {
						const result = aggregateFailure(tasks, selected.error.code, selected.error.message, identity, tasks.length, runProvenance);
						return finalToolResult(result);
					}
					routes.set(task.id, selected);
				}

				const readOnlyRoot = admitted.gitRoot;
				try {
					diagnosticRun = await diagnosticStore.allocateRun(ctx.sessionManager.getSessionId(), identity.runId);
				} catch (error) {
					const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "diagnostic_session_unavailable";
					const result = aggregateFailure(tasks, code, "Private diagnostic storage is unavailable.", identity, tasks.length, runProvenance);
					return finalToolResult(result);
				}
				const activeDiagnosticRun = diagnosticRun as DiagnosticRun;

					let snapshotPeak = 0;
					const emitSnapshot = (results: readonly TaskResult[], peakConcurrency = snapshotPeak) => {
						const elapsedMs = clock.elapsed();
						if (elapsedMs === null) return;
						const snapshot = buildSnapshot({
							runId: identity.runId,
							requestedTasks: identity.requestedTasks,
							results,
							elapsedMs,
							peakConcurrency,
							cancellationRequested: activeCancellation,
							phases: activePhases,
						});
						if (snapshot) pi.events.emit(SNAPSHOT_EVENT, snapshot);
					};
					const scheduled = await runScheduledTasks(tasks, {
						clock,
						runId: identity.runId,
						requestedTasks: identity.requestedTasks,
						maxConcurrency: config.maxConcurrency,
						roleLimits: {
							explorer: config.routes.explorer.maxConcurrency,
							reviewer: config.routes.reviewer.maxConcurrency,
							worker: config.routes.worker.maxConcurrency,
						},
						signal: controller.signal,
						abortResult() {
							return runLimitExceeded
								? { status: "failed", code: "diagnostic_session_limit", message: "The diagnostic run exceeded its storage limit." }
								: { status: "aborted", code: "aborted", message: "Task was not started before cancellation." };
						},
						onHeartbeat() {
							if (!runLimitExceeded && !controller.signal.aborted && !runLimitCheckActive) {
								runLimitCheckActive = true;
								void activeDiagnosticRun.checkLimits().then((limit) => {
									if (!limit.ok && !controller.signal.aborted) {
										runLimitExceeded = true;
										controller.abort();
									}
								}).catch(() => {
									if (!controller.signal.aborted) {
										runLimitExceeded = true;
										controller.abort();
									}
								}).finally(() => { runLimitCheckActive = false; });
							}
							for (const [taskId, check] of taskDiagnosticChecks) {
								if (check.checking || check.controller.signal.aborted) continue;
								check.checking = true;
								void activeDiagnosticRun.checkLimits(check.sessionPath).then((limit) => {
									if (!limit.ok && limit.scope === "child") {
										limitedTaskIds.add(taskId);
										check.controller.abort();
									}
								}).catch(() => {
									limitedTaskIds.add(taskId);
									check.controller.abort();
								}).finally(() => { check.checking = false; });
							}
						},
						onChildConcurrency(count) {
							activeChildren = count;
							snapshotPeak = Math.max(snapshotPeak, count);
						},
						onControl(control) {
							activeControl = control;
						},
						onUpdate(results) {
							const routedResults = attachResolvedRoutes(results, routes);
							emitSnapshot(routedResults);
							onUpdate?.({ content: [{ type: "text", text: formatProgress(routedResults, clock.elapsed()) }], details: { status: "running", tasks: routedResults, usage: emptyUsage() } });
						},
						async execute(task, predecessors, childSignal, lifecycle) {
							const selected = routes.get(task.id) as Extract<RouteResolution, { ok: true }>;
							let workspace: WorkerWorkspace | undefined;
							let diagnosticSession: Awaited<ReturnType<DiagnosticRun["createTask"]>> | undefined;
							const taskController = new AbortController();
							const forwardAbort = () => taskController.abort();
							if (childSignal.aborted) forwardAbort();
							else childSignal.addEventListener("abort", forwardAbort, { once: true });
							let workspaceMs = 0;
							let workspaceStarted: number | undefined;
							try {
								if (task.role === "worker") {
									activeControl?.setExecutionPhase(task.id, "workspace-preparation");
									activePhases.set(task.id, "workspace-preparation");
									workspaceStarted = clock.now();
									workspace = await dependencies.createWorkerWorkspace(ctx.cwd, task);
									workspaceMs = Math.max(0, clock.now() - workspaceStarted);
									if (childSignal.aborted) {
										return {
											...failureResult(task, "aborted", "Task was cancelled before child launch.", selected.route),
											status: "aborted",
											telemetry: { ...emptyTaskTelemetry(), workspaceMs },
										};
									}
								}
								activeControl?.setExecutionPhase(task.id, "child-execution");
								activePhases.set(task.id, "child-execution");
								const root = workspace?.root ?? readOnlyRoot;
								diagnosticSession = await activeDiagnosticRun.createTask(task.id);
								taskDiagnosticChecks.set(task.id, { sessionPath: diagnosticSession.path, controller: taskController, checking: false });
								const childStarted = clock.now();
								const childResult = await dependencies.runChild({
									now: clock.now,
									task,
									role: getRole(task.role),
									route: selected.route,
									cwd: root,
									guardExtensionPath: dependencies.guardExtensionPath,
									capability: capability(root, task),
									prompt: buildInputs(task, predecessors),
									approveProject: true,
									diagnosticSession,
									checkDiagnosticLimits: () => activeDiagnosticRun.checkLimits(diagnosticSession?.path),
									onRunDiagnosticLimit: () => {
										if (!controller.signal.aborted) {
											runLimitExceeded = true;
											controller.abort();
										}
									},
									abortCause: () => runLimitExceeded || limitedTaskIds.has(task.id) ? "diagnostic_session_limit" : "aborted",
									signal: taskController.signal,
									onActivity: lifecycle.activity,
									onChildStarted: lifecycle.childStarted,
									onChildSettled: lifecycle.childSettled,
								});
								const telemetry = {
									...emptyTaskTelemetry(),
									...childResult.telemetry,
									childStarted: childResult.telemetry?.childStarted ?? true,
									workspaceMs,
									childMs: childResult.telemetry?.childMs ?? Math.max(0, clock.now() - childStarted),
								};
								if (!workspace || childResult.status !== "succeeded") {
									return {
										...childResult,
										telemetry,
										...(workspace ? { convergence: "not-applied" as const } : {}),
									};
								}
								if (!activeControl?.enterConvergence(task.id)) {
									return {
										...childResult,
										status: "aborted" as const,
										telemetry,
										convergence: "not-applied" as const,
										error: { code: "aborted", message: "Task was cancelled before convergence." },
									};
								}
								activePhases.set(task.id, "convergence-critical");
								const convergenceStarted = clock.now();
								const converged = await dependencies.convergeWorkerWorkspace(workspace);
								telemetry.convergenceMs = Math.max(0, clock.now() - convergenceStarted);
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
									workspaceMs = Math.max(0, clock.now() - workspaceStarted);
								}
								const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "worker_execution_failed";
								return {
									...failureResult(task, code, error instanceof Error ? error.message : String(error), selected.route),
									telemetry: { ...emptyTaskTelemetry(), workspaceMs },
								};
							} finally {
								taskDiagnosticChecks.delete(task.id);
								childSignal.removeEventListener("abort", forwardAbort);
								await workspace?.cleanup();
							}
						},
					});
					const result: SubagentRunResult = {
						...scheduled,
						tasks: attachResolvedRoutes(scheduled.tasks, routes),
						telemetry: {
							...scheduled.telemetry,
							requestedDependencyEdges: identity.requestedDependencyEdges,
							admittedDependencyEdges: dependencyEdges(tasks),
							explicitModelTasks: identity.explicitModelTasks,
							explicitThinkingTasks: identity.explicitThinkingTasks,
							startedAtMs: identity.startedAtMs,
							provenance: runProvenance,
							effectiveMaxConcurrency: config.maxConcurrency,
							effectiveRoleConcurrency: {
								explorer: config.routes.explorer.maxConcurrency,
								reviewer: config.routes.reviewer.maxConcurrency,
								worker: config.routes.worker.maxConcurrency,
							},
						},
					};
					emitSnapshot(result.tasks, result.telemetry.peakConcurrency);
					return finalToolResult(result);
				} finally {
					try {
						await diagnosticRun?.settle();
					} finally {
						activeChildren = 0;
						unlink();
						activeController = undefined;
						activeRunId = undefined;
						activeControl = undefined;
						activeCancellation = false;
						activePhases.clear();
						if (activeRun === runSettlement) activeRun = undefined;
						settleActiveRun?.();
					}
				}
				};
				const prepared = await executeBatch();
				prepared.result.telemetry.runDurationMs = clock.elapsed();
				if (prepared.result.telemetry.timing) prepared.result.telemetry.timing.complete &&= clock.valid;
				try {
					const telemetry = structuredClone(prepared.result.telemetry);
					for (const span of [...(telemetry.timing?.children ?? []), ...(telemetry.timing?.waits ?? [])]) {
						span.taskId = prepared.result.tasks.find((task) => task.id === span.taskId)?.observation?.ownerSessionId ?? createHash("sha256").update(JSON.stringify([telemetry.runId, span.taskId])).digest("hex");
					}
					observations.recordRun({ telemetry, clockKey: clock.clockKey, originMs: clock.valid ? clock.started : null });
				} catch { /* Optional native observation. */ }
				return finalToolResult(prepared.result, prepared.text);
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
				const lines = [`guidance=${loaded.config.guidance}`, `maxConcurrency=${loaded.config.maxConcurrency}`, `activeChildren=${activeChildren}`, `provenance=${extensionProvenance.available ? "available" : "unavailable"}`];
				for (const role of ["explorer", "reviewer", "worker"] as const satisfies readonly RoleName[]) {
					const selected = resolveRoute(role, loaded.config, routeContext(ctx));
					lines.push(selected.ok
						? `${role}=${selected.route.provider}/${selected.route.model}:${selected.route.thinking} source=${selected.route.source} max=${loaded.config.routes[role].maxConcurrency}`
						: `${role}=unavailable max=${loaded.config.routes[role].maxConcurrency}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.registerCommand(SUBAGENT_DEBUG_COMMAND, {
			description: "Inspect retained subagent diagnostic session metadata without resuming it",
			handler: async (rawArgs, ctx) => {
				const argument = rawArgs.trim();
				try {
					const relativeArgument = argument.replace(/^subagent-sessions\//, "");
					const segments = relativeArgument ? relativeArgument.split("/") : [];
					if (argument && argument !== "--all" && segments.length === 3) {
						const taskReference = segments[2]?.endsWith(".jsonl") ? relativeArgument : `${relativeArgument}.jsonl`;
						const inspection = await diagnosticStore.inspect(taskReference);
						ctx.ui.notify(renderDiagnosticInspection(inspection), "info");
						return;
					}
					if (argument && argument !== "--all" && segments.length !== 2) throw new Error("invalid diagnostic scope");
					const scopes = await diagnosticStore.discover(argument === "--all" ? undefined : (segments[0] ?? ctx.sessionManager.getSessionId()));
					const filtered = segments.length === 2
						? scopes.filter((scope) => scope.ref === `subagent-sessions/${relativeArgument}`)
						: scopes;
					const lines = filtered.map((scope) => `${scope.ref} ${scope.active ? "active-or-stale" : "settled"} bytes=${scope.bytes}\n${scope.path}`);
					ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No retained subagent diagnostic sessions found.", "info");
				} catch {
					ctx.ui.notify("Subagent diagnostic lookup failed safely.", "error");
				}
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
		const observations = registerObservationHooks(pi, { now: dependencies.now });
		const managed = registerContinuationTool(pi, {
			now: dependencies.now, onRun: observations.recordRun, provenance,
			loadConfig: dependencies.loadConfig,
			runChild: dependencies.runChild,
			repositoryHost: dependencies.repositoryHost,
			legacyBusy: () => activeController !== undefined,
		});
	};
}

export default createSubagentsExtension();
