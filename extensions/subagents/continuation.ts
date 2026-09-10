import { randomUUID } from "node:crypto";
import type { ProvenanceCore } from "./provenance.ts";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ConfigLoadResult } from "./config.ts";
import { HARD_LIMITS, emptyTaskTelemetry, emptyUsage, type EffectiveRoute, type TaskResult } from "./contracts.ts";
import { validateGraphRelationships, validateGraphStructure, type NormalizedTask } from "./graph.ts";
import { admitRepositoryTasks, defaultRepositoryHost, findCanonicalGitRoot, RepositoryPolicyError, type RepositoryHost } from "./repository-policy.ts";
import { getManagedRole } from "./roles.ts";
import { resolveRoute, type RouteContext } from "./routing.ts";
import { runChild, type ChildRunOptions } from "./runner.ts";
import { runScheduledTasks, type ChildLifecycle } from "./scheduler.ts";
import { ManagedSessionStore, fingerprint, type ManagedRecord } from "./managed-sessions.ts";
import { applyCandidate, freezeCandidate, prepareManagedWorkspace, syncManagedInputs } from "./candidates.ts";
import { MANAGED_LIMITS, MANAGED_STORAGE_WARNINGS, ManagedError, SUBAGENT_SESSION_TOOL_NAME, SubagentSessionToolSchema, parseSessionRequest, type CurrentOwner, type SessionActionResult, type SessionRequest, type SessionView, type ManagedRequestTelemetry } from "./session-contracts.ts";
import { formatManagedContent, formatManagedResult, formatProgress } from "./render.ts";
import { createRunClock, monotonicNow, type RunClock } from "./telemetry.ts";
import type { ObservedRun } from "./observation-hooks.ts";
import { registerManagedContext } from "./context.ts";
import { ManagedObserver } from "./managed-observer.ts";
import { OBSERVER_EVENT, type ObserverSnapshot } from "./observer-events.ts";

/**
 * Bounded, path-free classifier for a failure the extension could not type. Managed and
 * repository errors already carry a precise code; anything else would otherwise surface
 * as an opaque `managed_operation_failed` with no evidence of its cause.
 */
function failureDetail(error: unknown): string | undefined {
	if (error instanceof ManagedError || error instanceof RepositoryPolicyError) return undefined;
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(code)) return code;
	const name = error instanceof Error ? error.name : undefined;
	if (typeof name === "string" && name !== "Error" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) return name;
	return "unclassified";
}

export interface ContinuationDependencies {
	store: ManagedSessionStore;
	loadConfig(): Promise<ConfigLoadResult>;
	runChild(options: ChildRunOptions): Promise<TaskResult>;
	repositoryHost: RepositoryHost;
	now(): number;
	onRun?: (run: ObservedRun) => void;
	provenance?: ProvenanceCore;
	onObserver?: (snapshot: ObserverSnapshot) => void;
}

export class ContinuationService {
	private readonly dependencies: ContinuationDependencies;
	private active: AbortController | undefined;
	private completion: Promise<unknown> | undefined;
	private observer: ManagedObserver | undefined;
	private generation = randomUUID();
	private observerRevision = 0;
	resetObserver(): void { this.generation = randomUUID(); this.observerRevision = 0; }
	constructor(dependencies: Partial<ContinuationDependencies> = {}) {
		this.dependencies = { store: new ManagedSessionStore(getAgentDir()), loadConfig, runChild, repositoryHost: defaultRepositoryHost, now: monotonicNow, ...dependencies };
	}
	get busy(): boolean { return this.active !== undefined; }
	async contextIndex(ctx: ExtensionContext): Promise<SessionView[]> {
		if (!ctx.isProjectTrusted()) return [];
		try { return await this.dependencies.store.list(await this.owner(ctx)); }
		catch (error) { if (error instanceof RepositoryPolicyError && error.code === "repository_root_unavailable") return []; throw error; }
	}
	async shutdown(): Promise<void> { this.active?.abort(); await this.completion; }

	async execute(raw: unknown, ctx: ExtensionContext, signal?: AbortSignal, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void): Promise<SessionActionResult> {
		const clock = createRunClock(this.dependencies.now);
		const telemetry: ManagedRequestTelemetry = { version: 1, ownerSessionId: ctx.sessionManager.getSessionId(), invocationId: randomUUID(), startedAtMs: Date.now(), durationMs: null, extensionEpoch: null, configurationEpoch: null, requestedTasks: null, admittedTasks: null, launchedChildren: 0, replayedEpisodes: 0 };
		try {
			const provenance = await this.dependencies.provenance?.observeExtension();
			if (provenance?.available) telemetry.extensionEpoch = provenance.extensionEpoch;
		} catch { /* Optional provenance cannot fail execution. */ }
		let result: SessionActionResult;
		let failed = true;
		let aborted = signal?.aborted === true;
		try {
			result = await this.executeRequest(raw, ctx, clock, telemetry, signal, onProgress);
			failed = result.status !== "succeeded";
			aborted ||= result.status === "aborted";
		} finally {
			if (this.observer?.runId === telemetry.invocationId) {
				this.observer.finish(failed, aborted);
				this.observer = undefined;
			}
		}
		// Current advice belongs to the request envelope, never to a stored outcome.
		// One best-effort scan after execution; no per-episode admission scans or cleanup.
		if (ctx.isProjectTrusted() && (result.sessions.length > 0 || result.action === "inspect")) {
			try {
				const warning = await this.dependencies.store.storageWarning();
				if (warning) result = { ...result, warnings: [warning] };
			} catch { result = { ...result, warnings: [MANAGED_STORAGE_WARNINGS.unavailable] }; }
		}
		const elapsed = clock.elapsed();
		telemetry.durationMs = clock.valid ? elapsed : null;
		return { ...result, schemaVersion: 2, requestTelemetry: telemetry };
	}
	private async executeRequest(raw: unknown, ctx: ExtensionContext, clock: RunClock, telemetry: ManagedRequestTelemetry, signal?: AbortSignal, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void): Promise<SessionActionResult> {
		let request: SessionRequest;
		try { request = parseSessionRequest(raw); }
		catch (error) {
			const action = raw && typeof raw === "object" ? (raw as { action?: unknown }).action : undefined;
			return this.failed(typeof action === "string" && ["create", "continue", "inspect", "apply", "close"].includes(action) ? action as SessionRequest["action"] : null, error);
		}
		telemetry.requestedTasks = request.action === "create" ? request.tasks!.length : request.action === "continue" ? request.episodes!.length : null;
		if (!ctx.isProjectTrusted()) return this.failed(request.action, new ManagedError("project_trust_required"));
		if (request.action === "inspect") {
			try { return await this.action(request, await this.owner(ctx), ctx, signal, clock, telemetry); }
			catch (error) { return this.failed(request.action, error); }
		}
		if (this.busy) return this.failed(request.action, new ManagedError("managed_batch_active"));
		const controller = new AbortController();
		this.active = controller;
		const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
		const execution = (async () => {
			try { combined.throwIfAborted(); return await this.action(request, await this.owner(ctx), ctx, combined, clock, telemetry, onProgress); }
			catch (error) { return this.failed(request.action, error, combined.aborted); }
			finally { this.active = undefined; }
		})();
		this.completion = execution;
		return execution;
	}
	private failed(action: SessionActionResult["action"], error: unknown, aborted = false): SessionActionResult {
		const detail = failureDetail(error);
		return { schemaVersion: 2, action, status: aborted ? "aborted" : "failed", sessions: [], error: { code: error instanceof ManagedError || error instanceof RepositoryPolicyError ? error.code : "managed_operation_failed", ...(error instanceof ManagedError && error.missingFields ? { missingFields: error.missingFields } : {}), ...(detail ? { detail } : {}) } };
	}
	private async owner(ctx: ExtensionContext): Promise<CurrentOwner> {
		return { repo: await findCanonicalGitRoot(ctx.cwd, this.dependencies.repositoryHost), parentSessionId: ctx.sessionManager.getSessionId(),
			anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map((entry) => entry.id),
		};
	}
	private async action(request: SessionRequest, owner: CurrentOwner, ctx: ExtensionContext, signal: AbortSignal | undefined, clock: RunClock, telemetry: ManagedRequestTelemetry, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void): Promise<SessionActionResult> {
		const store = this.dependencies.store;
		if (request.action === "inspect") {
			return { schemaVersion: 2, action: request.action, status: "succeeded", sessions: request.handle ? [store.view(await store.load(request.handle, owner))] : await store.list(owner) };
		}
		if (request.action === "apply" || request.action === "close") {
			const view = await store.withSession(request.handle!, owner, async (record) => {
				if (record.episode !== request.expectedEpisode) throw new ManagedError("stale_episode");
				if (record.state === "running") throw new ManagedError("request_outcome_unknown");
				if (request.action === "apply") {
					if (record.state !== "idle") throw new ManagedError("session_not_idle");
					await applyCandidate(store, record, request.candidateId!);
				} else {
					if (record.state === "closed" && record.retained !== (request.disposition !== "discard")) throw new ManagedError("close_disposition_conflict");
					record.state = "closed"; record.retained = request.disposition !== "discard";
					await store.save(record);
					if (!record.retained) {
						for (const name of await readdir(store.path(record.handle))) {
							if (["source", "scratch"].includes(name) || /^candidate_[a-zA-Z0-9_-]+$/.test(name) || /^inputs_(?:old_)?[0-9a-f-]{36}$/.test(name)) await rm(join(store.path(record.handle), name), { recursive: true, force: true });
						}
					}
				}
				return store.view(record);
			});
			return { schemaVersion: 2, action: request.action, status: request.action === "apply" && view.candidate?.status !== "applied" ? "failed" : "succeeded", sessions: [view] };
		}
		let records: ManagedRecord[] = [];
		const identityGraph = request.tasks ? validateGraphStructure({ tasks: request.tasks }) : undefined;
		const requestDigest = fingerprint(identityGraph?.ok ? identityGraph.tasks : []);
		if (request.action === "create") {
			const replay = await store.replayBatch(owner, request.requestId!, requestDigest);
			if (replay) { telemetry.replayedEpisodes = replay.sessions.filter(view => view.episode > 0 && view.result).length; return replay; }
		} else {
			records = await Promise.all(request.episodes!.map((episode) => store.load(episode.handle, owner)));
			const completed = records.map((record, index) => {
				const episode = request.episodes![index]!;
				const prior = record.requests.find((entry) => entry.id === episode.requestId);
				if (prior && prior.fingerprint !== fingerprint([episode.expectedEpisode, episode.message])) throw new ManagedError("request_id_conflict");
				return prior?.state === "complete";
			});
			if (completed.every(Boolean)) {
				const sessions = await Promise.all(records.map((record, index) => this.replayed(record, request.episodes![index]!.requestId)));
				telemetry.replayedEpisodes = sessions.length;
				return { schemaVersion: 2, action: request.action, status: this.status(sessions), sessions };
			}
		}
		const loaded = await this.dependencies.loadConfig();
		try {
			if (loaded.source) {
				const provenance = await this.dependencies.provenance?.observeConfiguration(loaded.source);
				if (provenance?.available) { telemetry.extensionEpoch = provenance.extensionEpoch; telemetry.configurationEpoch = provenance.configurationEpoch; }
			}
		} catch { /* Optional provenance cannot fail execution. */ }
		if (!loaded.config) throw new ManagedError(loaded.diagnostic?.code ?? "invalid_route_config");
		let tasks: NormalizedTask[];
		if (request.action === "create") {
			const graph = validateGraphStructure({ tasks: request.tasks! });
			if (!graph.ok) throw new ManagedError(graph.error.code);
			const admitted = await admitRepositoryTasks(owner.repo, graph.tasks, this.dependencies.repositoryHost);
			if (!admitted.ok) throw new ManagedError(admitted.error.code);
			const related = validateGraphRelationships(admitted.tasks);
			if (!related.ok) throw new ManagedError(related.error.code);
			tasks = related.tasks;
			telemetry.admittedTasks = tasks.length;
			if (tasks.some((task) => task.role === "worker" && (task.scope.length !== 1 || task.scope[0] !== "."))) throw new ManagedError("full_worker_scope_required");
			// Resolve every route before creating persistent objects.
			for (const task of tasks) this.route(task, loaded.config, ctx);
			const allocation = await store.allocate(owner, request.requestId!, tasks, requestDigest);
			records = allocation.records;
			if (!allocation.fresh) {
				const replay = await store.replayBatch(owner, request.requestId!, requestDigest);
				if (!replay) throw new ManagedError("request_outcome_unknown");
				telemetry.replayedEpisodes = replay.sessions.filter(view => view.episode > 0 && view.result).length;
				return replay;
			}
		} else {
			tasks = records.map((record) => ({ ...record.task, id: record.handle, dependsOn: [] }));
			telemetry.admittedTasks = tasks.length;
		}
		const views = new Map<string, SessionView>();
		const requestErrors = new Map<string, { code: string; detail?: string }>();
		const routes = new Map(records.flatMap((record, index) => record.requests.some((entry) => entry.id === request.episodes?.[index]?.requestId && entry.state === "complete") ? [] : [[record.handle, this.route(record.task, loaded.config!, ctx)] as const]));
		if (ctx.mode === "tui" && this.dependencies.onObserver) {
			this.observer = new ManagedObserver(telemetry.invocationId, owner, this.generation,
				records.map((record, index) => {
					const prior = record.requests.find(entry => entry.id === request.episodes?.[index]?.requestId && entry.state === "complete");
					const route = routes.get(record.handle) ?? prior?.result?.route;
					return { id: record.handle, role: record.task.role, episode: prior?.episode ?? record.episode + 1,
						replayed: !!prior, ...(route ? { route } : {}) };
				}),
				() => clock.valid ? clock.elapsed() : null, this.dependencies.onObserver, () => ++this.observerRevision);
			this.observer.begin();
		}
		const scheduled = await runScheduledTasks(tasks, {
			clock, now: this.dependencies.now,
			onUpdate: (results) => {
				const decorated = results.map((result, index) => ({ ...result, ...(routes.get(records[index]!.handle) ? { route: routes.get(records[index]!.handle)! } : {}) }));
				this.observer?.update(decorated);
				try { onProgress?.(decorated, clock.elapsed()); } catch { /* Display-only observer. */ }
			},
			...(signal ? { signal } : {}), maxConcurrency: loaded.config.maxConcurrency,
			roleLimits: Object.fromEntries(Object.entries(loaded.config.routes).map(([role, config]) => [role, config.maxConcurrency])),
			execute: async (task, predecessors, episodeSignal, lifecycle) => {
				const index = tasks.findIndex((item) => item.id === task.id);
				const record = records[index]!;
				const continuation = request.episodes?.[index];
				const message = continuation?.message ?? [...record.task.inputs, ...predecessors.map((result) => `Predecessor ${result.id} (${result.status}):\n${result.output || "(no output)"}`)].join("\n\n");
				if (Buffer.byteLength(message, "utf8") + Buffer.byteLength(record.task.objective, "utf8") > HARD_LIMITS.maxPromptBytes) throw new ManagedError("prompt_too_large");
				const requestId = continuation?.requestId ?? fingerprint([request.requestId, record.task.id]);
				const expected = continuation?.expectedEpisode ?? 0;
				try {
					const episode = await this.episode(record.handle, owner, requestId, expected, message, routes.get(record.handle), episodeSignal, lifecycle, telemetry);
					if (episode.replayed) telemetry.replayedEpisodes++;
					views.set(record.handle, episode.view);
					return { ...episode.view.result!, id: task.id, ...(episode.replayed ? { usage: emptyUsage(), durationMs: 0, telemetry: emptyTaskTelemetry() } : {}) };
				} catch (error) {
					const detail = failureDetail(error);
					requestErrors.set(record.handle, { code: error instanceof ManagedError ? error.code : "managed_operation_failed", ...(detail ? { detail } : {}) });
					throw error;
				}
			},
		});
		const sessions = await Promise.all(records.map(async (record, index) => {
			const view = views.get(record.handle) ?? store.view(await store.load(record.handle, owner));
			const scheduledError = views.has(record.handle) ? undefined : scheduled.tasks[index]?.error;
			const failure = requestErrors.get(record.handle) ?? (scheduledError ? { code: scheduledError.code } : undefined);
			return failure ? { ...view, requestError: failure } : view;
		}));
		const response: SessionActionResult = { schemaVersion: 2, action: request.action, status: scheduled.status, sessions };
		if (request.action === "create") await store.completeBatch(owner, request.requestId!, response);
		try {
			const identities = new Map(tasks.map((task, index) => [task.id, scheduled.tasks[index]?.observation?.ownerSessionId ?? fingerprint(records[index]!.handle)]));
			const telemetry = structuredClone(scheduled.telemetry);
			telemetry.runDurationMs = clock.elapsed();
			if (telemetry.timing) {
				for (const span of [...telemetry.timing.children, ...telemetry.timing.waits]) span.taskId = identities.get(span.taskId) ?? fingerprint(span.taskId);
				telemetry.timing.complete &&= clock.valid;
			}
			this.dependencies.onRun?.({ telemetry, clockKey: clock.clockKey, originMs: clock.valid ? clock.started : null });
		} catch { /* Optional run observations do not change the committed response. */ }
		return response;
	}
	private status(sessions: readonly SessionView[]): SessionActionResult["status"] {
		if (sessions.some((view) => view.result?.status === "aborted")) return "aborted";
		if (sessions.every((view) => view.result?.status === "succeeded")) return "succeeded";
		return sessions.some((view) => view.result?.status === "succeeded") ? "partial" : "failed";
	}
	private async replayed(record: ManagedRecord, requestId: string): Promise<SessionView> {
		const prior = record.requests.find((request) => request.id === requestId);
		if (prior?.state !== "complete" || !prior.result) throw new ManagedError("request_outcome_unknown");
		return { handle: record.handle, role: record.task.role, episode: prior.episode, state: "idle", ...(prior.execution ? { execution: prior.execution } : {}), ...(prior.result.route ? { route: prior.result.route } : {}), reportComplete: prior.result.reportComplete === true, result: await this.dependencies.store.withObservation(record.handle, prior.episode, prior.result), ...(prior.candidate ? { candidate: prior.candidate } : {}) };
	}
	private route(task: NormalizedTask, config: NonNullable<ConfigLoadResult["config"]>, ctx: ExtensionContext): EffectiveRoute {
		const context: RouteContext = { ...(ctx.model ? { parentModel: ctx.model as NonNullable<RouteContext["parentModel"]> } : {}), ...(ctx.thinkingLevel ? { parentThinking: ctx.thinkingLevel } : {}), scopedModels: ctx.scopedModels as RouteContext["scopedModels"], modelRegistry: ctx.modelRegistry as unknown as RouteContext["modelRegistry"] };
		const result = resolveRoute(task.role, config, context, task);
		if (!result.ok) throw new ManagedError(result.error.code);
		return result.route;
	}
	private async episode(handle: string, owner: CurrentOwner, requestId: string, expected: number, message: string, route: EffectiveRoute | undefined, signal: AbortSignal, lifecycle: ChildLifecycle, telemetry: ManagedRequestTelemetry): Promise<{ view: SessionView; replayed: boolean }> {
		const store = this.dependencies.store;
		return store.withSession(handle, owner, async (record) => {
			const digest = fingerprint([expected, message]);
			const prior = record.requests.find((request) => request.id === requestId);
			if (prior) {
				if (prior.fingerprint !== digest) throw new ManagedError("request_id_conflict");
				return { view: await this.replayed(record, requestId), replayed: true };
			}
			if (!route) throw new ManagedError("invalid_route_config");
			if (record.candidate && ["applying", "partial", "unknown"].includes(record.candidate.status)) throw new ManagedError("candidate_recovery_required");
			if (record.state !== "idle") throw new ManagedError("session_not_idle");
			if (record.episode !== expected) throw new ManagedError("stale_episode");
			if (record.episode >= MANAGED_LIMITS.maxEpisodes) throw new ManagedError("episode_limit");
			const revision = await store.nativeRevision(handle);
			if (revision.leaf !== record.nativeLeaf) throw new ManagedError("native_leaf_mismatch");
			const admission = await admitRepositoryTasks(owner.repo, [{ ...record.task, dependsOn: [] }], this.dependencies.repositoryHost);
			if (!admission.ok) throw new ManagedError(admission.error.code);
			if (record.task.role === "worker") {
				if (record.workspace) await syncManagedInputs(store, record);
				else await prepareManagedWorkspace(store, record);
			}
			record.episode++; record.state = "running"; delete record.result; delete record.candidate;
			const operation: ManagedRecord["requests"][number] = { id: requestId, fingerprint: digest, episode: record.episode, state: "running" };
			record.execution = { startedAtMs: Date.now(), provenance: telemetry.extensionEpoch && telemetry.configurationEpoch ? { available: true, extensionEpoch: telemetry.extensionEpoch, configurationEpoch: telemetry.configurationEpoch } : { available: false } };
			operation.execution = record.execution;
			record.requests.push(operation); record.route = route;
			await store.save(record);
			try {
				const worker = record.task.role === "worker";
				const cwd = worker ? join(store.path(handle), "source") : owner.repo;
				const role = getManagedRole(record.task.role);
				const native = join(store.path(handle), "native.jsonl");
				const result = await this.dependencies.runChild({
					task: record.task, role,
					route, cwd, prompt: message, approveProject: true, signal, managedProcessGroup: true,
					guardExtensionPath: fileURLToPath(new URL(worker ? "./worker-tools.ts" : "./child-capability-guard.ts", import.meta.url)),
					...(worker ? { managedWorkerScratch: join(store.path(handle), "scratch"), managedWorkerInputs: record.workspace!.inputs } : {}),
					capability: { version: 2, root: cwd, role: record.task.role, readRoots: record.task.scope.map((file) => resolve(cwd, file)), writePaths: record.task.writePaths.map((file) => resolve(cwd, file)), externalReadRoots: record.task.externalReadRoots ?? [] },
					diagnosticSession: { path: native, ref: `managed/${handle}/native`, async removeUnused() {} },
					checkDiagnosticLimits: async () => ({ ok: (await lstat(native)).size <= HARD_LIMITS.diagnosticChildBytes, code: "diagnostic_session_limit", scope: "child" }),
					onChildStarted: () => { telemetry.launchedChildren++; this.observer?.childStarted(handle); lifecycle.childStarted(); }, onChildSettled: lifecycle.childSettled, onActivity: lifecycle.activity,
				}).finally(() => this.observer?.childStopped(handle));
				record.result = result; record.nativeLeaf = (await store.nativeRevision(handle)).leaf;
				record.state = worker && result.workerToolsSettled !== true ? "interrupted" : "idle";
				if (worker && result.status === "succeeded" && result.reportComplete) await freezeCandidate(store, record);
				operation.state = "complete"; operation.result = result;
				if (record.candidate) operation.candidate = structuredClone(record.candidate);
				await store.save(record);
				if (result.observation) result.observation = await store.saveObservation(handle, record.episode, result.observation);
				return { view: store.view(record), replayed: false };
			} catch (error) {
				record.state = "interrupted"; operation.state = "unknown";
				await store.save(record);
				throw error;
			}
		});
	}
}

export function registerContinuationTool(pi: ExtensionAPI, dependencies: Partial<ContinuationDependencies> = {}): ContinuationService {
	const service = new ContinuationService({ ...dependencies, onObserver: dependencies.onObserver ?? ((snapshot) => pi.events.emit(OBSERVER_EVENT, snapshot)) });
	pi.on("session_start", () => service.resetObserver());
	pi.on("session_tree", () => service.resetObserver());
	pi.registerTool({
		name: SUBAGENT_SESSION_TOOL_NAME, label: "Subagent sessions",
		description: "Create or continue a bounded foreground task with retained native history and working state. Trusted host workers can run local tools; return candidates for parent-selected apply. Inspect or close without running a model. Not an OS sandbox or an automatic review/repair workflow.",
		promptSnippet: "Create/continue/inspect/apply/close explorer, reviewer or worker sessions; parent owns acceptance.",
		promptGuidelines: [
			"A single create episode can finish a task. Workers require scope [\".\"] and trusted host bash; candidate guards do not sandbox filesystem, credentials or network. Apply is explicit. Dependency edges pass reports, not candidate files: apply file changes before dispatching file-dependent successors.",
			"Close explicitly when same-task work is no longer needed: at most ten unclosed records per parent/repository. Retain/discard is a parent choice. Close releases slots, not all history; discard preserves native/registry evidence. Aggregate storage warnings are advisory; cleanup is user-owned and never automatic. Never automatically resume, apply or discard interrupted records.",
			'csheng_subagent_sessions create requires requestId and tasks, e.g. {"action":"create","requestId":"r1","tasks":[{"id":"review","role":"reviewer","objective":"Review the change","scope":["."]}]}.',
			'csheng_subagent_sessions continue requires episodes, e.g. {"action":"continue","episodes":[{"handle":"returned-handle","requestId":"r2","expectedEpisode":1,"message":"Check the repair"}]}. Use returned identities/versions, not these example values.',
			'csheng_subagent_sessions apply requires handle, expectedEpisode and candidateId; close requires handle and expectedEpisode, with optional disposition. Example shapes: {"action":"apply","handle":"returned-handle","expectedEpisode":1,"candidateId":"returned-candidate"}; {"action":"close","handle":"returned-handle","expectedEpisode":1,"disposition":"retain"}.',
		],
		parameters: SubagentSessionToolSchema,
		async execute(_id, input, signal, onUpdate, context) {
			const details = await service.execute(input, context, signal, (tasks, elapsedMs) => onUpdate?.({ content: [{ type: "text", text: formatProgress(tasks, elapsedMs) }], details: undefined }));
			return { content: [{ type: "text", text: formatManagedContent(details) }], details };
		},
		renderResult(result, { expanded, isPartial }) {
			const text = isPartial || !result.details ? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : formatManagedResult(result.details as SessionActionResult, expanded);
			return new Text(text, 0, 0);
		},
	});
	pi.on("tool_result", async (event) => {
		if (event.toolName !== SUBAGENT_SESSION_TOOL_NAME) return;
		const details = event.details as SessionActionResult | undefined;
		if (details?.schemaVersion === 1 || details?.schemaVersion === 2) return { isError: details.status !== "succeeded" };
	});
	pi.on("session_shutdown", async () => { await service.shutdown(); });
	registerManagedContext(pi, (ctx) => service.contextIndex(ctx));
	return service;
}
