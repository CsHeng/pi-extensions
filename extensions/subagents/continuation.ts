import { randomUUID } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ConfigLoadResult } from "./config.ts";
import { HARD_LIMITS, emptyUsage, type EffectiveRoute, type TaskResult } from "./contracts.ts";
import { validateGraphRelationships, validateGraphStructure, type NormalizedTask } from "./graph.ts";
import { admitRepositoryTasks, defaultRepositoryHost, findCanonicalGitRoot, RepositoryPolicyError, type RepositoryHost } from "./repository-policy.ts";
import { getManagedRole } from "./roles.ts";
import { resolveRoute, type RouteContext } from "./routing.ts";
import { runChild, type ChildRunOptions } from "./runner.ts";
import { runScheduledTasks, type ChildLifecycle, type SchedulerControl } from "./scheduler.ts";
import { ManagedSessionStore, fingerprint, type ManagedRecord } from "./managed-sessions.ts";
import { applyCandidate, freezeCandidate, prepareManagedWorkspace, syncManagedInputs } from "./candidates.ts";
import { captureGitInput, discardGitWorkspace, retainGitInput, discardGitInput, inspectGitInput, GitWorkspaceError } from "./git-workspace.ts";
import { SessionExecutionSupervisor, SupervisorError, type ExecutionContext, type ExecutionEvent } from "./session-supervisor.ts";
import { MANAGED_LIMITS, MANAGED_STORAGE_WARNINGS, ManagedError, SUBAGENT_SESSION_TOOL_NAME, SubagentSessionToolSchema, parseSessionRequest, type CurrentOwner, type SessionActionResult, type SessionRequest, type SessionView, type ManagedRequestTelemetry } from "./session-contracts.ts";
import { formatManagedContent, formatManagedResult, formatProgress } from "./render.ts";
import { createRunClock, monotonicNow } from "./telemetry.ts";
import type { ObservedRun } from "./observation-hooks.ts";
import type { ProvenanceCore } from "./provenance.ts";
import { registerManagedContext } from "./context.ts";
import { ManagedObserver } from "./managed-observer.ts";
import { OBSERVER_EVENT, type ObserverSnapshot } from "./observer-events.ts";
import { SUBAGENT_EXECUTION_EVENT, type SubagentExecutionEvent } from "../shared/subagent-execution.ts";

export interface ContinuationDependencies {
	store: ManagedSessionStore;
	loadConfig(): Promise<ConfigLoadResult>;
	runChild(options: ChildRunOptions): Promise<TaskResult>;
	repositoryHost: RepositoryHost;
	now(): number;
	onRun?: (run: ObservedRun) => void;
	provenance?: ProvenanceCore;
	onObserver?: (snapshot: ObserverSnapshot) => void;
	onExecution?: (event: SubagentExecutionEvent) => void | Promise<void>;
	onWake?: (events: readonly SubagentExecutionEvent[]) => void | Promise<void>;
}
interface RunBinding {
	owner: CurrentOwner;
	toolCallId: string;
	records: ManagedRecord[];
	foreground: boolean;
	views: Map<string, SessionView>;
	replayed: Set<string>;
	control?: SchedulerControl;
	runObservation?: ObservedRun;
	deliveryError?: string;
}
const failedTask = (record: ManagedRecord, aborted: boolean, code: string): TaskResult => ({ id: record.task.id, role: record.task.role, status: aborted ? "aborted" : "failed", output: "", stderr: "", usage: emptyUsage(), durationMs: 0, changedPaths: [], convergence: "not-applicable", error: { code, message: code } });
const activeState = (record: ManagedRecord) => record.state === "queued" || record.state === "running";

/** Session-owned executor, not a model loop. Durable records never resume themselves. */
export class ContinuationService {
	private readonly dependencies: ContinuationDependencies;
	private supervisor: SessionExecutionSupervisor | undefined;
	private supervisorOwner: string | undefined;
	private readonly bindings = new Map<string, RunBinding>();
	private readonly delivered = new Map<string, SubagentExecutionEvent>();
	private readonly observers = new Set<ManagedObserver>();
	private readonly observerSnapshots = new Map<string, ObserverSnapshot>();
	private readonly observerOwners = new Map<string, string>();
	private observerRevision = 0;
	private generation = randomUUID();
	private admission = false;
	private stopped = false;
	private applying = false;
	constructor(dependencies: Partial<ContinuationDependencies> = {}) {
		this.dependencies = { store: new ManagedSessionStore(getAgentDir()), loadConfig, runChild, repositoryHost: defaultRepositoryHost, now: monotonicNow, ...dependencies };
	}
	get busy(): boolean { return this.admission || this.supervisor?.hasActiveWork === true; }
	resetObserver(): void { this.generation = randomUUID(); this.observerRevision = 0; this.observerSnapshots.clear(); this.observerOwners.clear(); }
	private publishObserver(snapshot: ObserverSnapshot): void {
		if (!this.observerSnapshots.has(snapshot.runId)) for (const row of snapshot.tasks) this.observerOwners.set(row.id, snapshot.runId);
		this.observerSnapshots.set(snapshot.runId, snapshot);
		const rows = new Map<string, ObserverSnapshot["tasks"][number]>();
		for (const value of this.observerSnapshots.values()) for (const row of value.tasks) if (this.observerOwners.get(row.id) === value.runId) rows.set(row.id, row);
		const tasks = [...rows.values()].sort((a, b) => Number(["pending", "running"].includes(b.status)) - Number(["pending", "running"].includes(a.status))).slice(0, MANAGED_LIMITS.maxSessions).map((row, index) => ({ ...row, ordinal: index + 1 }));
		this.dependencies.onObserver?.({ ...snapshot, runId: this.generation, tasks, phase: tasks.some(row => ["pending", "running"].includes(row.status)) ? "running" : "settled", requestedTasks: tasks.length, admittedTasks: tasks.length, launchedChildren: tasks.filter(row => row.elapsedMs !== null).length, activeChildren: tasks.filter(row => row.executionPhase === "child-execution" && row.status === "running").length, settledTasks: tasks.filter(row => !["pending", "running"].includes(row.status)).length, aggregateAssistantTurns: tasks.reduce((sum, row) => sum + row.assistantTurns, 0) });
	}
	async reset(): Promise<void> {
		await this.shutdown(); this.supervisor = undefined; this.supervisorOwner = undefined;
		this.bindings.clear(); this.delivered.clear(); this.stopped = false; this.resetObserver();
	}
	suppressWake(): void { this.supervisor?.suppressWake(); }
	allowWake(): void { this.supervisor?.allowWake(); }
	async shutdown(): Promise<void> {
		this.stopped = true; await this.supervisor?.shutdown();
		for (const observer of this.observers) observer.finish(true, true);
		this.observers.clear();
	}
	private async owner(ctx: ExtensionContext): Promise<CurrentOwner> {
		return { repo: await findCanonicalGitRoot(ctx.cwd, this.dependencies.repositoryHost), parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) };
	}
	async contextIndex(ctx: ExtensionContext): Promise<SessionView[]> {
		if (!ctx.isProjectTrusted()) return [];
		try { return await this.dependencies.store.list(await this.owner(ctx)); }
		catch (error) { if (error instanceof RepositoryPolicyError && error.code === "repository_root_unavailable") return []; throw error; }
	}
	private failed(action: SessionActionResult["action"], error: unknown, aborted = false): SessionActionResult {
		const known = error instanceof ManagedError || error instanceof RepositoryPolicyError || error instanceof GitWorkspaceError || error instanceof SupervisorError;
		const cause = (error as { code?: unknown })?.code ?? (error instanceof Error && error.name !== "Error" ? error.name : "unclassified");
		return { schemaVersion: 3, action, status: aborted ? "aborted" : "failed", sessions: [], error: { code: known ? error.code : "managed_operation_failed", ...(known ? {} : { detail: typeof cause === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(cause) ? cause : "unclassified" }), ...(error instanceof ManagedError && error.missingFields ? { missingFields: error.missingFields } : {}) } };
	}
	async execute(raw: unknown, ctx: ExtensionContext, signal?: AbortSignal, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void, toolCallId = "direct"): Promise<SessionActionResult> {
		const rawAction = raw && typeof raw === "object" ? (raw as { action?: unknown }).action : undefined;
		let action: SessionActionResult["action"] = typeof rawAction === "string" && ["create", "continue", "inspect", "apply", "close", "refresh", "join", "cancel"].includes(rawAction) ? rawAction as SessionRequest["action"] : null;
		let request: SessionRequest | undefined;
		const telemetry: ManagedRequestTelemetry = { version: 1, ownerSessionId: ctx.sessionManager.getSessionId(), invocationId: randomUUID(), startedAtMs: Date.now(), durationMs: null, extensionEpoch: null, configurationEpoch: null, requestedTasks: null, admittedTasks: null, launchedChildren: 0, replayedEpisodes: 0 };
		try {
			request = parseSessionRequest(raw); action = request.action;
			telemetry.requestedTasks = request.tasks?.length ?? request.episodes?.length ?? null;
			if (!ctx.isProjectTrusted()) throw new ManagedError("project_trust_required");
			const owner = await this.owner(ctx);
			try { const provenance = await this.dependencies.provenance?.observeExtension(); if (provenance?.available) telemetry.extensionEpoch = provenance.extensionEpoch; } catch { /* Optional. */ }
			let result = await this.action(request, owner, ctx, signal, onProgress, toolCallId, telemetry);
			telemetry.durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);
			result = { ...result, requestTelemetry: { ...telemetry, ...(result.kind === "submission" ? { launchedChildren: 0 } : {}) } };
			try { const warning = await this.dependencies.store.storageWarning(); if (warning) result = { ...result, warnings: [warning] }; }
			catch { result = { ...result, warnings: [MANAGED_STORAGE_WARNINGS.unavailable] }; }
			return result;
		} catch (error) {
			const result = this.failed(action, error, signal?.aborted);
			if (request?.action === "continue" && ctx.isProjectTrusted()) {
				try { const owner = await this.owner(ctx); result.sessions = await Promise.all(request.episodes!.map(async episode => ({ ...this.dependencies.store.view(await this.dependencies.store.load(episode.handle, owner)), requestError: result.error! }))); } catch { /* Preserve the original typed failure. */ }
			}
			telemetry.durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);
			return { ...result, requestTelemetry: telemetry };
		}
	}
	private async action(request: SessionRequest, owner: CurrentOwner, ctx: ExtensionContext, signal: AbortSignal | undefined, onProgress: ((tasks: readonly TaskResult[], elapsedMs: number | null) => void) | undefined, toolCallId: string, telemetry: ManagedRequestTelemetry): Promise<SessionActionResult> {
		const store = this.dependencies.store;
		if (request.action === "inspect") {
			if (request.runId) return this.runResult(request.runId, request.action, owner);
			return { schemaVersion: 3, action: request.action, status: "succeeded", sessions: request.handle ? [store.view(await store.load(request.handle, owner))] : await store.list(owner) };
		}
		if (request.action === "join" || request.action === "cancel") {
			const binding = this.binding(request.runId!, owner);
			if (request.action === "join") { await this.supervisor!.join(request.runId!, signal); return this.runResult(request.runId!, "join", owner); }
			const outcome = request.taskId ? binding.control?.cancelTask(request.taskId) ?? "not-active" : this.supervisor!.cancel(request.runId!) ? "accepted" : "not-active";
			return { ...(await this.runResult(request.runId!, "cancel", owner)), cancelOutcome: typeof outcome === "string" ? outcome : String(outcome) };
		}
		if (["apply", "close", "refresh"].includes(request.action)) {
			if (request.action === "apply" && this.applying) throw new ManagedError("managed_apply_active");
			if (request.action === "apply") this.applying = true;
			try {
				const view = await store.withSession(request.handle!, owner, async record => {
					if (record.episode !== request.expectedEpisode) throw new ManagedError("stale_episode");
					if (activeState(record)) throw new ManagedError("session_not_idle");
					if (record.version < 3 && request.action !== "close") throw new ManagedError("legacy_session_read_only");
					if (request.action === "apply" || request.action === "refresh") {
						if (record.state !== "idle") throw new ManagedError("session_not_idle");
						if (request.action === "apply") await applyCandidate(store, record, request.candidateId!);
						else await syncManagedInputs(store, record);
					} else {
						if (record.state === "closed" && record.retained !== (request.disposition !== "discard")) throw new ManagedError("close_disposition_conflict");
						if (request.disposition === "discard" && record.state !== "closed") {
							const workspace = record.workspace?.inputs.gitWorkspace;
							if (workspace) { await discardGitWorkspace(workspace); delete record.workspace; await store.save(record); }
							if (record.inputRef && record.input) { await discardGitInput(record.owner.repo, record.inputRef, record.input); delete record.inputRef; await store.save(record); }
							for (const name of await readdir(store.path(record.handle))) {
								if (["source", "scratch"].includes(name) || /^candidate_[a-zA-Z0-9_-]+$/.test(name) || /^inputs_(?:old_)?[0-9a-f-]{36}$/.test(name)) await rm(join(store.path(record.handle), name), { recursive: true, force: true });
							}
						}
						record.state = "closed"; record.retained = request.disposition !== "discard"; await store.save(record);
					}
					return store.view(record);
				});
				return { schemaVersion: 3, action: request.action, status: request.action === "apply" && view.candidate?.status !== "applied" ? "failed" : "succeeded", sessions: [view] };
			} finally { if (request.action === "apply") this.applying = false; }
		}
		if (this.stopped) throw new ManagedError("supervisor_closed");
		if (this.admission) throw new ManagedError("managed_admission_active");
		this.admission = true;
		let runId: string;
		let foreground: boolean;
		try {
			signal?.throwIfAborted();
			foreground = request.mode === "foreground" || !["tui", "rpc"].includes(ctx.mode);
			if (request.mode === "async" && foreground) throw new ManagedError("async_host_mode_unsupported");
			const replays = new Map<string, SessionView>();
			const graph = request.action === "create" ? validateGraphStructure({ tasks: request.tasks! }) : undefined;
			if (graph && !graph.ok) throw new ManagedError(graph.error.code);
			const digest = fingerprint(request.action === "create" && graph?.ok ? graph.tasks : request.episodes);
			if (request.action === "create") {
				const replay = await store.replayBatch(owner, request.requestId!, digest);
				if (replay) { telemetry.replayedEpisodes = replay.sessions.filter(view => !!view.execution).length; return replay; }
			} else {
				const replayed = await Promise.all(request.episodes!.map(async episode => {
					const record = await store.load(episode.handle, owner);
					if (record.version < 3) throw new ManagedError("legacy_session_read_only");
					const prior = record.requests.find(operation => operation.id === episode.requestId);
					if (!prior) return undefined;
					if (prior.fingerprint !== fingerprint([episode.expectedEpisode, episode.message])) throw new ManagedError("request_id_conflict");
					if (prior.state !== "complete" || !prior.result) return undefined;
					return { handle: record.handle, role: record.task.role, episode: prior.episode, state: "idle" as const, reportComplete: prior.result.reportComplete === true, result: await store.withObservation(record.handle, prior.episode, prior.result), ...(prior.candidate ? { candidate: prior.candidate } : {}), ...(prior.execution ? { execution: prior.execution } : {}), ...(prior.error ? { requestError: prior.error } : {}), ...(prior.result.route ? { route: prior.result.route } : {}) };
				}));
				for (const view of replayed) if (view) replays.set(view.handle, view);
				if (replayed.every(view => view !== undefined)) {
					telemetry.replayedEpisodes = replayed.filter(view => view.execution).length;
					const record = await store.load(request.episodes![0]!.handle, owner); const prior = record.requests.find(operation => operation.id === request.episodes![0]!.requestId)!;
					return { schemaVersion: 3, action: request.action, kind: "execution", ...(prior.runId ? { runId: prior.runId } : {}), ...(prior.generation ? { generation: prior.generation } : {}), status: replayed.every(view => view.result.status === "succeeded") ? "succeeded" : "failed", sessions: replayed };
				}
			}
			const loaded = await this.dependencies.loadConfig();
			if (!loaded.config) throw new ManagedError(loaded.diagnostic?.code ?? "invalid_route_config");
			const config = loaded.config;
			const ownerKey = fingerprint([owner.repo, owner.parentSessionId]);
			if (this.supervisorOwner && this.supervisorOwner !== ownerKey) throw new ManagedError("managed_owner_mismatch");
			if (!this.supervisor) {
				this.supervisorOwner = ownerKey;
				this.supervisor = new SessionExecutionSupervisor({ repository: owner.repo, sessionId: owner.parentSessionId, branchAnchor: owner.anchor }, { concurrency: config.maxConcurrency, roles: { worker: config.routes.worker.maxConcurrency, reviewer: config.routes.reviewer.maxConcurrency, explorer: config.routes.explorer.maxConcurrency } }, {
					now: this.dependencies.now,
					onEvent: event => this.publish(event),
					onWake: async events => {
						const values = events.flatMap(event => this.delivered.get(event.eventId) ? [this.delivered.get(event.eventId)!] : []).filter(event => !this.bindings.get(event.runId)?.foreground);
						for (const event of events) this.delivered.delete(event.eventId);
						if (values.length && !this.stopped && ctx.isProjectTrusted()) await this.dependencies.onWake?.(values);
					},
				});
			}
			let records: ManagedRecord[];
			let tasks: NormalizedTask[];
			if (graph?.ok) {
				const admission = await admitRepositoryTasks(owner.repo, graph.tasks, this.dependencies.repositoryHost);
				if (!admission.ok) throw new ManagedError(admission.error.code);
				const related = validateGraphRelationships(admission.tasks); if (!related.ok) throw new ManagedError(related.error.code);
				tasks = admission.tasks;
				if (tasks.some(task => task.role === "worker" && (task.scope.length !== 1 || task.scope[0] !== "."))) throw new ManagedError("full_worker_scope_required");
				// Resolve every requested route before creating any persistent task.
				for (const task of tasks) this.route(task, config, ctx);
				const allocation = await store.allocate(owner, request.requestId!, tasks, digest);
				if (!allocation.fresh) throw new ManagedError("request_outcome_unknown");
				records = allocation.records;
			} else {
				records = await Promise.all(request.episodes!.map(episode => store.load(episode.handle, owner)));
				if (records.some(record => record.version < 3)) throw new ManagedError("legacy_session_read_only");
				tasks = records.map(record => ({ ...record.task, id: record.handle, dependsOn: [] }));
			}
			const routes = records.map(record => replays.get(record.handle)?.route ?? this.route(record.task, config, ctx));
			telemetry.replayedEpisodes = replays.size;
			const requestId = request.requestId ?? fingerprint(request.episodes);
			telemetry.admittedTasks = tasks.length;
			try { const provenance = loaded.source ? await this.dependencies.provenance?.observeConfiguration(loaded.source) : undefined; if (provenance?.available) { telemetry.extensionEpoch = provenance.extensionEpoch; telemetry.configurationEpoch = provenance.configurationEpoch; } } catch { /* Optional. */ }
			const receipt = await this.supervisor.submit({ requestId, requestKey: digest,
				prepare: async (preparationSignal, identity) => {
					const input = records.some(record => !replays.has(record.handle) && !record.workspace && !record.input) ? await captureGitInput(owner.repo) : undefined;
					preparationSignal.throwIfAborted();
					for (const [index, record] of records.entries()) {
						if (replays.has(record.handle)) continue;
						const expected = request.episodes?.[index]?.expectedEpisode ?? 0;
						if (record.state !== "idle" || record.episode !== expected) throw new ManagedError(record.episode !== expected ? "stale_episode" : "session_not_idle");
						if (record.episode >= MANAGED_LIMITS.maxEpisodes) throw new ManagedError("episode_limit");
						if (record.candidate && ["applying", "partial", "unknown"].includes(record.candidate.status)) throw new ManagedError("candidate_recovery_required");
						if ((await store.nativeRevision(record.handle)).leaf !== record.nativeLeaf) throw new ManagedError("native_leaf_mismatch");
					}
					this.bindings.set(identity.runId, { owner, toolCallId, records: records.map(record => replays.has(record.handle) ? { ...record, episode: replays.get(record.handle)!.episode } : record), foreground, views: new Map(replays), replayed: new Set(replays.keys()) });
					for (const [index, record] of records.entries()) {
						if (replays.has(record.handle)) continue;
						await store.withSession(record.handle, owner, async current => {
							if (current.state !== "idle" || current.episode !== record.episode) throw new ManagedError("session_not_idle");
							if (current.candidate && ["applying", "partial", "unknown"].includes(current.candidate.status)) throw new ManagedError("candidate_recovery_required");
							if ((await store.nativeRevision(current.handle)).leaf !== current.nativeLeaf) throw new ManagedError("native_leaf_mismatch");
							if (!current.workspace) {
								if (!current.input && input) { current.input = input; current.inputRef = await retainGitInput(owner.repo, current.handle, input); }
								else if (current.input && current.inputRef) await inspectGitInput(owner.repo, current.inputRef, current.input);
								else throw new ManagedError("managed_input_ref_missing");
							}
							current.episode++; current.state = "queued"; delete current.result; delete current.candidate;
							current.route = routes[index]!;
							current.dispatch = { ...identity, toolCallId, taskId: tasks[index]!.id };
							current.requests.push({ id: request.episodes?.[index]?.requestId ?? fingerprint([requestId, current.task.id]), fingerprint: request.episodes?.[index] ? fingerprint([request.episodes[index]!.expectedEpisode, request.episodes[index]!.message]) : digest, episode: current.episode, state: "running", runId: identity.runId, generation: identity.generation });
							await store.save(current);
							records[index] = current; this.bindings.get(identity.runId)!.records[index] = current;
							this.bindings.get(identity.runId)!.views.set(current.handle, store.view(current));
						});
					}
					const response: SessionActionResult = { schemaVersion: 3, action: request.action, status: "accepted", kind: "submission", ...identity, sessions: records.map(record => store.view(record)) };
					if (request.action === "create") await store.completeBatch(owner, request.requestId!, response);
					return records;
				},
				execute: (prepared, execution) => this.run(request, owner, prepared, tasks, execution, telemetry, ctx, replays, onProgress),
			}, signal);
			runId = receipt.runId;
			if (!foreground) return { schemaVersion: 3, action: request.action, status: "accepted", kind: "submission", runId, generation: receipt.generation, sessions: records.map(record => store.view(record)) };
		} finally { this.admission = false; }
		const abort = () => { this.supervisor!.cancel(runId!); };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try { await this.supervisor!.join(runId!); }
		finally { signal?.removeEventListener("abort", abort); }
		return this.runResult(runId!, request.action, owner);
	}
	private binding(runId: string, owner: CurrentOwner): RunBinding {
		const binding = this.bindings.get(runId);
		if (!binding || binding.owner.repo !== owner.repo || binding.owner.parentSessionId !== owner.parentSessionId || (binding.owner.anchor && binding.owner.anchor !== owner.anchor && !owner.branch.includes(binding.owner.anchor))) throw new ManagedError("run_owner_mismatch");
		return binding;
	}
	private async boundView(binding: RunBinding, record: ManagedRecord): Promise<SessionView> {
		const current = await this.dependencies.store.load(record.handle, binding.owner);
		if (current.episode === record.episode && !binding.views.get(record.handle)?.result) binding.views.set(record.handle, this.dependencies.store.view(current));
		const view = binding.views.get(record.handle);
		if (!view) throw new ManagedError("execution_evidence_unavailable");
		return structuredClone(view);
	}
	private async runResult(runId: string, action: SessionActionResult["action"], owner: CurrentOwner): Promise<SessionActionResult> {
		const binding = this.binding(runId, owner);
		const sessions = await Promise.all(binding.records.map(record => this.boundView(binding, record)));
		const view = this.supervisor!.inspect(runId)[0]!;
		const running = ["preparing", "queued", "running"].includes(view.phase);
		return { schemaVersion: 3, action, kind: running ? "submission" : "execution", status: binding.deliveryError || view.phase === "failed" ? "failed" : running ? "accepted" : view.phase === "cancelled" ? "aborted" : sessions.every(session => session.result?.status === "succeeded") ? "succeeded" : sessions.some(session => session.result?.status === "succeeded") ? "partial" : "failed", runId, generation: view.generation, sessions, ...(binding.deliveryError ? { error: { code: binding.deliveryError } } : {}) };
	}
	private async publish(event: ExecutionEvent): Promise<void> {
		const binding = this.bindings.get(event.runId); if (!binding) return;
		const records = binding.records.filter(record => !binding.replayed.has(record.handle) && record.dispatch?.runId === event.runId && (!event.task || record.dispatch.taskId === event.task.taskId));
		if (!records.length) return; // Failed admission must not publish the preceding episode as fresh execution.
		const sessions = await Promise.all(records.map(async record => {
			const store = this.dependencies.store;
			const current = await store.load(record.handle, binding.owner);
			if (current.episode === record.episode && current.state === "queued") {
				await store.withSession(record.handle, binding.owner, async value => {
					value.state = "idle";
					value.result = failedTask(value, (event.task?.phase ?? event.run?.phase) === "cancelled", (event.task?.phase ?? event.run?.phase) === "cancelled" ? "aborted" : "execution_not_started");
					const operation = value.requests.at(-1)!; operation.state = "complete"; operation.result = value.result; operation.error = { code: value.result.error!.code };
					await store.save(value);
				});
			}
			return this.boundView(binding, record);
		}));
		const run = this.supervisor?.inspect(event.runId)[0];
		const value: SubagentExecutionEvent = { version: 3, eventId: event.eventId, kind: event.kind, runId: event.runId, generation: event.generation, owner: event.owner, toolCallId: binding.toolCallId, sessions, foreground: binding.foreground,
			...(run && Number.isFinite(run.submittedAt) ? { timing: { clockKey: createRunClock(this.dependencies.now).clockKey, submittedAtMs: run.submittedAt, preparedAtMs: run.preparedAt, finishedAtMs: event.task?.finishedAt ?? run.finishedAt, ...(event.task ? { queuedAtMs: event.task.queuedAt, startedAtMs: event.task.startedAt } : {}) } } : {}),
			...(!event.task && binding.runObservation ? { runObservation: binding.runObservation } : {}),
		};
		try {
			for (const record of records) await this.dependencies.store.write(join(this.dependencies.store.path(record.handle), `event_${record.episode}_${event.kind}.json`), value);
			await this.dependencies.onExecution?.(value);
			this.delivered.set(event.eventId, value);
			while (this.delivered.size > 256) this.delivered.delete(this.delivered.keys().next().value!);
		} catch (error) { binding.deliveryError = "terminal_delivery_failed"; throw error; }
	}
	private async run(request: SessionRequest, owner: CurrentOwner, records: ManagedRecord[], tasks: NormalizedTask[], execution: ExecutionContext, telemetry: ManagedRequestTelemetry, ctx: ExtensionContext, replays: Map<string, SessionView>, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void): Promise<SessionActionResult> {
		const clock = createRunClock(this.dependencies.now); const store = this.dependencies.store;
		const binding = this.bindings.get(execution.runId)!;
		const observer = ctx.mode === "tui" && this.dependencies.onObserver ? new ManagedObserver(execution.runId, owner, this.generation, records.map(record => ({ id: record.handle, role: record.task.role, episode: replays.get(record.handle)?.episode ?? record.episode, route: replays.get(record.handle)?.route ?? record.route!, replayed: replays.has(record.handle), objective: record.task.objective })), () => clock.elapsed(), snapshot => this.publishObserver(snapshot), () => ++this.observerRevision) : undefined;
		if (observer) { this.observers.add(observer); observer.begin(); }
		try {
			const scheduled = await runScheduledTasks(tasks, {
				runId: execution.runId, clock, now: this.dependencies.now, signal: execution.signal,
				maxConcurrency: HARD_LIMITS.maxTasks,
				onControl: control => { binding.control = control; },
				onUpdate: results => { observer?.update(results); try { if (binding.foreground) onProgress?.(results, clock.elapsed()); } catch { /* Display-only. */ } },
				execute: (task, predecessors, episodeSignal, lifecycle) => {
					const index = tasks.findIndex(item => item.id === task.id); const record = records[index]!;
					const replay = replays.get(record.handle);
					if (replay) return Promise.resolve({ ...replay.result!, id: task.id, usage: emptyUsage(), durationMs: 0, telemetry: { childStarted: false, queueMs: 0, workspaceMs: 0, childMs: 0, convergenceMs: 0 } });
					return execution.runTask({ ...task, signal: episodeSignal }, sharedSignal => {
					const message = request.episodes?.[index]?.message ?? [...record.task.inputs, ...predecessors.map(result => `Predecessor ${result.id} (${result.status}):\n${result.output || "(no output)"}`)].join("\n\n");
					return this.episode(record.handle, owner, message, AbortSignal.any([episodeSignal, sharedSignal]), lifecycle, telemetry, observer, () => binding.control!.enterConvergence(task.id)).then(result => ({ ...result, id: task.id }));
					});
				},
			});
			for (const [index, record] of records.entries()) {
				if (replays.has(record.handle)) continue;
				const current = await store.load(record.handle, owner);
				if (current.episode === record.episode && activeState(current)) await store.withSession(record.handle, owner, async value => {
					value.result = scheduled.tasks[index]!; value.state = "idle";
					const operation = value.requests.at(-1)!; operation.state = "complete"; operation.result = value.result;
					if (value.result.error) operation.error = { code: value.result.error.code };
					await store.save(value);
				});
			}
			const response: SessionActionResult = { schemaVersion: 3, action: request.action, kind: "execution", runId: execution.runId, generation: this.supervisor!.currentGeneration, status: scheduled.status, sessions: await Promise.all(binding.records.map(record => this.boundView(binding, record))) };
			if (request.action === "create") await store.completeBatch(owner, request.requestId!, response);
			try {
				const observed = structuredClone(scheduled.telemetry);
				const identities = new Map(tasks.map((task, index) => [task.id, scheduled.tasks[index]?.observation?.ownerSessionId ?? fingerprint(records[index]!.handle)]));
				if (observed.timing) for (const span of [...observed.timing.children, ...observed.timing.waits]) span.taskId = identities.get(span.taskId) ?? fingerprint(span.taskId);
				binding.runObservation = { telemetry: observed, clockKey: clock.clockKey, originMs: clock.valid ? clock.started : null };
				if (binding.foreground) this.dependencies.onRun?.(binding.runObservation);
			} catch { /* Optional observation. */ }
			observer?.finish(scheduled.status !== "succeeded", scheduled.status === "aborted");
			return response;
		} finally { if (observer) { observer.finish(true, execution.signal.aborted); this.observers.delete(observer); } }
	}
	private route(task: NormalizedTask, config: NonNullable<ConfigLoadResult["config"]>, ctx: ExtensionContext): EffectiveRoute {
		const context: RouteContext = { ...(ctx.model ? { parentModel: ctx.model as NonNullable<RouteContext["parentModel"]> } : {}), ...(ctx.thinkingLevel ? { parentThinking: ctx.thinkingLevel } : {}), scopedModels: ctx.scopedModels as RouteContext["scopedModels"], modelRegistry: ctx.modelRegistry as unknown as RouteContext["modelRegistry"] };
		const result = resolveRoute(task.role, config, context, task); if (!result.ok) throw new ManagedError(result.error.code); return result.route;
	}
	private async episode(handle: string, owner: CurrentOwner, message: string, signal: AbortSignal, lifecycle: ChildLifecycle, telemetry: ManagedRequestTelemetry, observer: ManagedObserver | undefined, enterConvergence: () => boolean): Promise<TaskResult> {
		const store = this.dependencies.store;
		return store.withSession(handle, owner, async record => {
			const operation = record.requests.at(-1)!;
			try {
				if (record.version !== 3 || record.state !== "queued") throw new ManagedError("session_not_queued");
				signal.throwIfAborted();
				if (Buffer.byteLength(message) + Buffer.byteLength(record.task.objective) > HARD_LIMITS.maxPromptBytes) throw new ManagedError("prompt_too_large");
				const preparationStarted = this.dependencies.now();
				await prepareManagedWorkspace(store, record);
				const workspaceMs = Math.max(0, this.dependencies.now() - preparationStarted);
				record.state = "running";
				record.execution = { startedAtMs: Date.now(), provenance: telemetry.extensionEpoch && telemetry.configurationEpoch ? { available: true, extensionEpoch: telemetry.extensionEpoch, configurationEpoch: telemetry.configurationEpoch } : { available: false } };
				operation.execution = record.execution; await store.save(record);
				const worker = record.task.role === "worker";
				const cwd = join(store.path(handle), "source"); const native = join(store.path(handle), "native.jsonl");
				const result = await this.dependencies.runChild({ task: record.task, role: getManagedRole(record.task.role), route: record.route!, cwd, prompt: message, approveProject: true, signal, managedProcessGroup: true,
					guardExtensionPath: fileURLToPath(new URL(worker ? "./worker-tools.ts" : "./child-capability-guard.ts", import.meta.url)),
					...(worker ? { managedWorkerScratch: join(store.path(handle), "scratch"), managedWorkerInputs: record.workspace!.inputs } : {}),
					capability: { version: 2, root: cwd, role: record.task.role, readRoots: record.task.scope.map(file => resolve(cwd, file)), writePaths: record.task.writePaths.map(file => resolve(cwd, file)), externalReadRoots: record.task.externalReadRoots ?? [], ...(worker ? { writeRoot: true } : {}) },
					diagnosticSession: { path: native, ref: `managed/${handle}/native`, async removeUnused() {} },
					checkDiagnosticLimits: async () => ({ ok: (await lstat(native)).size <= HARD_LIMITS.diagnosticChildBytes, code: "diagnostic_session_limit", scope: "child" }),
					onChildStarted: () => { telemetry.launchedChildren++; observer?.childStarted(handle); lifecycle.childStarted(); }, onChildSettled: lifecycle.childSettled, onActivity: lifecycle.activity,
				}).finally(() => observer?.childStopped(handle));
				if (result.telemetry) result.telemetry.workspaceMs = workspaceMs;
				record.result = result; record.nativeLeaf = (await store.nativeRevision(handle)).leaf;
				record.state = worker && result.workerToolsSettled !== true ? "interrupted" : "idle";
				if (worker && result.status === "succeeded" && result.reportComplete && record.state === "idle") {
					if (!enterConvergence()) record.result = failedTask(record, true, "aborted");
					else { await freezeCandidate(store, record); result.changedPaths = record.candidate?.changedPaths ?? []; }
				}
				operation.state = "complete"; operation.result = record.result;
				if (record.candidate) operation.candidate = structuredClone(record.candidate);
				await store.save(record);
				if (record.result.observation) record.result.observation = await store.saveObservation(handle, record.episode, record.result.observation);
				return record.result;
			} catch (error) {
				record.state = "interrupted"; operation.state = "unknown";
				const failure = this.failed(null, error, signal.aborted).error!;
				record.result = failedTask(record, signal.aborted, failure.code);
				operation.error = { code: failure.code, ...(failure.detail ? { detail: failure.detail } : {}) };
				await store.save(record); return record.result;
			}
		});
	}
}

export function registerContinuationTool(pi: ExtensionAPI, dependencies: Partial<ContinuationDependencies> = {}): ContinuationService {
	let context: ExtensionContext | undefined;
	let pendingWake: { token: string; events: SubagentExecutionEvent[] } | undefined;
	const wakeContent = (events: SubagentExecutionEvent[]) => `Subagent execution evidence is ready. Inspect terminal evidence and decide whether to review, apply, continue, or close; execution is not acceptance.\n${JSON.stringify(events.map(event => ({ eventId: event.eventId, runId: event.runId, sessions: event.sessions.map(session => ({ handle: session.handle, episode: session.episode, status: session.result?.status, candidateId: session.candidate?.id })) })))}`;
	const current = (event: SubagentExecutionEvent) => context?.isProjectTrusted() && context.sessionManager.getSessionId() === event.owner.sessionId && (!event.owner.branchAnchor || context.sessionManager.getLeafId() === event.owner.branchAnchor || context.sessionManager.getBranch().some(entry => entry.id === event.owner.branchAnchor));
	const service = new ContinuationService({ ...dependencies,
		onObserver: dependencies.onObserver ?? (snapshot => pi.events.emit(OBSERVER_EVENT, snapshot)),
		onExecution: dependencies.onExecution ?? (event => { if (current(event)) { pi.appendEntry(SUBAGENT_EXECUTION_EVENT, event); pi.events.emit(SUBAGENT_EXECUTION_EVENT, event); } }),
		onWake: dependencies.onWake ?? (events => {
			const owned = events.filter(current); if (!owned.length) return;
			if (pendingWake) { pendingWake.events = [...pendingWake.events, ...owned].slice(-MANAGED_LIMITS.maxSessions); return; }
			pendingWake = { token: randomUUID(), events: owned.slice(-MANAGED_LIMITS.maxSessions) };
			try { pi.sendMessage({ customType: SUBAGENT_EXECUTION_EVENT, content: wakeContent(pendingWake.events), display: false, details: { version: 3, wakeToken: pendingWake.token } }, { triggerTurn: true, deliverAs: "followUp" }); }
			catch (error) { pendingWake = undefined; throw error; }
		}),
	});
	pi.on("session_start", async (_event, ctx) => { pendingWake = undefined; context = ctx; await service.reset(); });
	pi.on("session_tree", async (_event, ctx) => { pendingWake = undefined; await service.reset(); context = ctx; });
	pi.on("context", event => {
		const wake = pendingWake;
		if (!wake || !event.messages.some(message => message.role === "custom" && message.customType === SUBAGENT_EXECUTION_EVENT && (message.details as { wakeToken?: string } | undefined)?.wakeToken === wake.token)) return;
		pendingWake = undefined; // The public context hook, not a microtask, consumes a queued wake.
		return { messages: event.messages.map(message => message.role === "custom" && message.customType === SUBAGENT_EXECUTION_EVENT && (message.details as { wakeToken?: string } | undefined)?.wakeToken === wake.token ? { ...message, content: wakeContent(wake.events.filter(current)) } : message) };
	});
	pi.on("agent_start", (_event, ctx) => { context = ctx; });
	pi.on("input", event => { if (event.source === "interactive" || event.source === "rpc") service.allowWake(); });
	pi.on("agent_end", (event) => { if (event.messages.some(message => message.role === "assistant" && ["aborted", "error"].includes(message.stopReason))) { pendingWake = undefined; service.suppressWake(); } });
	pi.registerTool({
		name: SUBAGENT_SESSION_TOOL_NAME, label: "Subagent sessions",
		description: "Submit bounded session-owned asynchronous tasks; accepted receipts are not completed work. Workers inherit a fixed Git input in an owned linked worktree; initial write regions are advisory. Inspect/join terminal evidence, explicitly apply Git candidates, refresh idle input, cancel, continue or close. Trusted host tools are not an OS sandbox.",
		promptSnippet: "Submit async explorer/reviewer/worker tasks; join/inspect, refresh, cancel, apply and close explicitly; parent owns acceptance.",
		promptGuidelines: ["Use a flat batch for independent tasks. A submission receipt means accepted, not completed. Continue useful parent work; join only at a real dependency. No polling loop. Print mode is foreground; mode=foreground is available in interactive/RPC hosts.", "Workers require scope [\".\"]. Git candidates contain actual changes, not only initial writePaths. Refresh input explicitly while idle; continue retains the same input, worktree and native history. No automatic apply, acceptance, retry or recovery.", "Use the exact returned handle/episode/candidateId. Close unneeded records with explicit retain/discard. Legacy records are inspect/close-only. Task cancellation uses runId and taskId; freeze-critical cancellation is too late."],
		parameters: SubagentSessionToolSchema,
		async execute(id, input, signal, onUpdate, ctx) {
			context = ctx;
			const details = await service.execute(input, ctx, signal, (tasks, elapsedMs) => onUpdate?.({ content: [{ type: "text", text: formatProgress(tasks, elapsedMs) }], details: undefined }), id);
			return { content: [{ type: "text", text: formatManagedContent(details) }], details };
		},
		renderResult(result, { expanded, isPartial }) {
			return new Text(isPartial || !result.details ? result.content.filter(part => part.type === "text").map(part => part.text).join("\n") : formatManagedResult(result.details as SessionActionResult, expanded), 0, 0);
		},
	});
	pi.on("tool_result", event => {
		if (event.toolName !== SUBAGENT_SESSION_TOOL_NAME) return;
		const details = event.details as SessionActionResult | undefined;
		if (details && [1, 2, 3].includes(details.schemaVersion)) return { isError: !["accepted", "succeeded"].includes(details.status) };
	});
	pi.on("session_shutdown", async () => { await service.shutdown(); pendingWake = undefined; context = undefined; });
	registerManagedContext(pi, ctx => service.contextIndex(ctx));
	return service;
}
