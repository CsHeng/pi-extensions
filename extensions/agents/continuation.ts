import { mintProductId } from "./identity.ts";
import { DEFAULT_OBSERVATION_WAIT_SECONDS } from "../shared/observation-budget.ts";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ConfigLoadResult } from "./config.ts";
import { CAPABILITY_RECOVERY_HINT, CHILD_CAPABILITY_MANIFEST_VERSION, CHILD_MARKER_ENV, HARD_LIMITS, emptyUsage, type ChildCapabilityManifest, type EffectiveRoute, type AgentTask, type TaskResult } from "./contracts.ts";
import { assertCanonicalGrants, authorizePath, loadCapability } from "./path-policy.ts";
import { normalizeAccess } from "./access.ts";
import { validateGraphRelationships, validateGraphStructure, type NormalizedTask } from "./graph.ts";
import { admitRepositoryTasks, defaultRepositoryHost, findCanonicalGitRoot, validateRepositoryTarget, RepositoryPolicyError, type RepositoryHost } from "./repository-policy.ts";
import { getManagedRole } from "./roles.ts";
import { resolveRoute, type RouteContext } from "./routing.ts";
import { resolvePiInvocation, runChild, type ChildRunOptions } from "./runner.ts";
import { mergeChildGuidance, prepareChildGuidance, selectedProjectSkills } from "./guidance-resources.ts";
import { runScheduledTasks, type ChildLifecycle, type SchedulerControl } from "./scheduler.ts";
import { ManagedSessionStore, fingerprint, managedWriteRoots, type ManagedRecord } from "./managed-sessions.ts";
import { applyCandidate, conflictScope, freezeCandidate, prepareManagedWorkspace, reviewRecoveryWorkspaces, releaseManagedResources, syncManagedInputs } from "./candidates.ts";
import { captureGitInput, discardGitInput, retainGitInput, inspectGitInput, GitWorkspaceError } from "./git-workspace.ts";
import { SessionExecutionSupervisor, SupervisorError, type ExecutionContext, type ExecutionEvent } from "./session-supervisor.ts";
import { MANAGED_LIMITS, MANAGED_SESSION_VERSION, ManagedError, uncertainApply, parseSessionRequest, type CurrentOwner, type SessionActionResult, type SessionRequest, type SessionView, type ManagedRequestTelemetry } from "./session-contracts.ts";
import { PeerHub } from "./peer-hub.ts";
import { peerToolDefinitions } from "./peer-tools.ts";
import { AGENT_MESSAGE_TYPE, PEER_TOOLS } from "./peer-protocol.ts";
import { createRunClock, monotonicNow } from "./telemetry.ts";
import type { ObservedRun } from "./observation-hooks.ts";
import type { ProvenanceCore } from "./provenance.ts";
import { ManagedObserver } from "./managed-observer.ts";
import { OBSERVER_EVENT, type ObserverSnapshot, type ObserverTask } from "./observer-events.ts";
import { SESSION_VIEW_EVENT, SESSION_VIEW_REQUEST_EVENT, SESSION_VIEW_CHANGED_EVENT, SESSION_VIEW_QUERY_EVENT, SessionViewBuilder, parseSessionViewReply, parseSessionViewRequest, type SessionViewReply, type SessionViewRequest } from "./session-view.ts";
import { AGENT_EXECUTION_EVENT, type AgentExecutionEvent } from "../shared/agent-execution.ts";
import { emptyProducerFacts, EXECUTION_FACTS_EVENT, NOTICE_ACK, EXECUTION_FACTS_REQUEST, type ExecutionFact, type ProducerFacts, type NoticeAck, type ProducerFactsRequest } from "../shared/execution-facts.ts";
import { createMainLoopYield, type MainLoopYield, type YieldReason } from "../shared/main-loop-yield.ts";
import { registerRecoveryDiscovery } from "./recovery-discovery.ts";
import { AgentInactivityCheckpoints, type ScheduleCheckpoint } from "./inactivity.ts";
import type { Participant, PeerLinkBinding } from "./peer-protocol.ts";
import { isolatedWriteRoots } from "./managed-sessions.ts";
import { readSharedWrites, sharedWritesDirectory } from "./shared-writes.ts";
import { loadRoleDefinitions, type AgentRoleDefinition } from "./role-definitions.ts";

export interface ContinuationDependencies {
	store: ManagedSessionStore;
	loadConfig(): Promise<ConfigLoadResult>;
	runChild(options: ChildRunOptions): Promise<TaskResult>;
	/** Enclosing child capability, or undefined for a main actor. Nested delegation is bounded by it. */
	enclosingCapability?(): Promise<ChildCapabilityManifest | undefined>;
	getParentSkills?(sourceRoot: string): readonly Skill[] | undefined;
	repositoryHost: RepositoryHost;
	now(): number;
	onRun?: (run: ObservedRun) => void;
	provenance?: ProvenanceCore;
	onObserver?: (snapshot: ObserverSnapshot) => void;
	onSessionViewChange?: () => void;
	onExecution?: (event: AgentExecutionEvent) => void | Promise<void>;
	onWake?: (events: readonly AgentExecutionEvent[]) => void | Promise<void>;
	mainLoopYield?: MainLoopYield;
	onFactsChanged?: () => void;
	scheduleInactivity?: ScheduleCheckpoint;
	/** Peer coordination hooks owned by the hub; absent for direct service callers. */
	peer?: PeerBridge;
	/** Role catalog override for fixtures; the default reads packaged, user and trusted project definitions. */
	loadRoleDefinitions?(projectRoot: string, trusted: boolean): Promise<Map<string, AgentRoleDefinition>>;
	agentDir?: string;
}
/** Hub hooks: one live link per child episode and the terminal facts of every turn. */
export interface PeerBridge {
	/** `capability` is the episode's prepared grant set; nested invocations stay inside it. */
	openLink(record: ManagedRecord, capability: ChildCapabilityManifest): { binding: PeerLinkBinding; close(): void } | undefined;
	turnStarted(record: ManagedRecord, runId: string, initiator: Participant): void;
	turnTerminal(event: AgentExecutionEvent, initiator: Participant): void | Promise<void>;
}
export interface ExecuteOptions {
	/** Who started this turn: the invoking model, or an agent whose message woke an idle agent. */
	initiator?: Participant;
	/** Called once admission is released, before a foreground caller observes the run. */
	admitted?: (handles: readonly string[]) => void;
	/** Return the admission receipt instead of observing the run; an agent caller or a wake waits through wait_agents. */
	detach?: boolean;
	/** Checked during preparation, before any record is queued or dispatched; a throw rejects the whole admission. */
	authorize?: (records: readonly ManagedRecord[]) => Promise<void>;
}
interface RunBinding {
	initiator: Participant;
	owner: CurrentOwner;
	toolCallId: string;
	records: ManagedRecord[];
	foreground: boolean;
	views: Map<string, SessionView>;
	replayed: Set<string>;
	control?: SchedulerControl;
	runObservation?: ObservedRun;
	deliveryError?: string;
	/** The durable batch response was written, so this admission is booked even if submission is cancelled late. */
	committed?: boolean;
}
const failedTask = (record: ManagedRecord, aborted: boolean, code: string): TaskResult => ({ id: record.handle, label: record.task.id, role: record.task.role, status: aborted ? "aborted" : "failed", executionStatus: "not-started", output: "", stderr: "", usage: emptyUsage(), durationMs: 0, changedPaths: [], convergence: "not-applicable", error: { code, message: code } });

/** Known child bounds do not disappear after cwd changes or packet failure.
 * Synthetic main/SDK fixtures inject their context rather than weakening this boundary. */
export async function defaultEnclosingCapability(): Promise<ChildCapabilityManifest | undefined> {
	if (process.env[CHILD_MARKER_ENV] !== "1") return undefined;
	const loaded = await loadCapability();
	if (!loaded.manifest) throw new ManagedError("enclosing_capability_unavailable");
	return loaded.manifest;
}
const unsettledWriter = (record: ManagedRecord) => record.state === "interrupted" && record.reconciledEpisode !== record.episode
	&& !!record.execution && managedWriteRoots(record).length > 0
	&& record.result?.executionStatus !== "not-started" && record.result?.workerToolsSettled !== true;
const activeState = (record: ManagedRecord) => record.state === "queued" || record.state === "running";

/** Bound the carried closing excerpt independently for every task in a combined notice. */
export const NOTICE_EXCERPT_LIMIT = 1200;
function closingExcerpt(output: string): string {
	// The excerpt is the child's own report tail; the full report stays inspectable.
	const text = output.trim();
	if (text.length <= NOTICE_EXCERPT_LIMIT) return text;
	const marker = "[earlier output truncated] ";
	const tail = text.slice(-(NOTICE_EXCERPT_LIMIT - marker.length));
	const boundary = /(?:\n\s*\n|[.!?]\s+)/.exec(tail);
	return marker + (boundary ? tail.slice(boundary.index + boundary[0].length) : tail);
}
function taskNotice(label: string, _handle: string, _runId: string, phase: string, view?: SessionView): string {
	const result = view?.result;
	const excerpt = result?.output ? closingExcerpt(result.output) : "";
	return `Agent ${label}${view ? ` (role ${view.role})` : ""}: turn ${phase}${result ? `; status ${result.status}` : ""}${view?.candidate ? `; isolated candidate ready (${view.candidate.changedPaths.length} changed paths)` : result && result.changedPaths.length ? `; changed paths ${result.changedPaths.length}` : ""}${result ? "" : "; result unavailable"}.${excerpt ? ` Closing summary: ${excerpt}` : ""} Full report: list_agents with name ${label}. A finished turn is not acceptance.`;
}

interface AdmissionProgress {
	handle: string;
	runId: string;
	/** Locked pre-admission facts; absent when this admission never reached its first mutation. */
	before?: ManagedRecord;
	retained: Array<{ rootId: string; source: string; ref: string; input: Awaited<ReturnType<typeof captureGitInput>> }>;
}
/** Restore the pre-admission facts this call replaced; admission itself never produces a result or candidate. */
function restoreAdmissionState(current: ManagedRecord, before: ManagedRecord): void {
	current.episode = before.episode; current.state = before.state;
	current.requests = structuredClone(before.requests); current.roots = structuredClone(before.roots);
	if (before.dispatch) current.dispatch = structuredClone(before.dispatch); else delete current.dispatch;
	if (before.route) current.route = structuredClone(before.route); else delete current.route;
	if (before.inheritSkills === undefined) delete current.inheritSkills; else current.inheritSkills = before.inheritSkills;
	if (before.projectSkills) current.projectSkills = structuredClone(before.projectSkills); else delete current.projectSkills;
	if (before.result) current.result = structuredClone(before.result); else delete current.result;
	if (before.candidate) current.candidate = structuredClone(before.candidate); else delete current.candidate;
}
/** Session-owned executor, not a model loop. Durable records never resume themselves. */
export class ContinuationService {
	private readonly dependencies: ContinuationDependencies;
	private supervisor: SessionExecutionSupervisor | undefined;
	private supervisorOwner: string | undefined;
	private readonly bindings = new Map<string, RunBinding>();
	private readonly delivered = new Map<string, AgentExecutionEvent>();
	private readonly observedEpisodes = new Map<string, number>();
	private readonly closedHandles = new Set<string>();
	private readonly observers = new Set<ManagedObserver>();
	private readonly observerSnapshots = new Map<string, ObserverSnapshot>();
	private readonly observerOwners = new Map<string, string>();
	private observerRevision = 0;
	private generation = mintProductId();
	private admission = false;
	private admissionToolCallId: string | undefined;
	private stopped = false;
	private readonly sessionViewBuilder: SessionViewBuilder;
	private readonly inactivity: AgentInactivityCheckpoints;
	/** Set by registerContinuationTool; direct service callers run without a hub. */
	peerHub: PeerHub | undefined;
	constructor(dependencies: Partial<ContinuationDependencies> = {}) {
		this.dependencies = { store: new ManagedSessionStore(getAgentDir()), loadConfig, runChild, repositoryHost: defaultRepositoryHost, now: monotonicNow, ...dependencies };
		this.sessionViewBuilder = new SessionViewBuilder({ store: this.dependencies.store });
		this.inactivity = new AgentInactivityCheckpoints(this.dependencies.now, () => this.dependencies.onFactsChanged?.(), this.dependencies.scheduleInactivity);
	}
	get busy(): boolean { return this.admission || this.supervisor?.hasActiveWork === true; }
	get store(): ManagedSessionStore { return this.dependencies.store; }
	ownerOf(ctx: ExtensionContext): Promise<CurrentOwner> { return this.owner(ctx); }
	/** Cancel the live turn of one agent, whichever run started it. */
	/** The episode a run carried for one agent, for notices acknowledged after a later turn began. */
	episodeOf(runId: string, handle: string): number | undefined { return this.bindings.get(runId)?.records.find(item => item.handle === handle)?.episode; }
	/** True while a supervised run still owns this agent's turn, including finalization after the child exits. */
	agentLive(handle: string): boolean {
		for (const [runId, binding] of this.bindings) {
			if (!binding.records.some(item => item.handle === handle)) continue;
			const run = this.supervisor?.inspect(runId)[0];
			if (!run || !["preparing", "queued", "running"].includes(run.phase)) continue;
			// A task settles (result saved) before its batch run ends; until listed it is still being prepared.
			const task = run.tasks.find(item => item.taskId === handle);
			if (!task || ["preparing", "queued", "running"].includes(task.phase)) return true;
		}
		return false;
	}
	cancelAgent(handle: string): boolean {
		for (const [runId, binding] of this.bindings) {
			const record = binding.records.find(item => item.handle === handle);
			if (!record) continue;
			const run = this.supervisor?.inspect(runId)[0];
			if (!run || !["preparing", "queued", "running"].includes(run.phase)) continue;
			const outcome = binding.control?.cancelTask(handle) ?? (this.supervisor!.cancel(runId) ? "accepted" : "not-active");
			if (outcome === "accepted") { this.inactivity.stop(runId, handle); return true; }
		}
		return false;
	}

	private invalidateSessionView(): void {
		this.sessionViewBuilder.invalidate();
		try { this.dependencies.onSessionViewChange?.(); } catch { /* Display consumers never affect execution. */ }
	}
	resetObserver(): void { this.generation = mintProductId(); this.observerRevision = 0; this.observerSnapshots.clear(); this.observerOwners.clear(); }
	private publishObserver(snapshot: ObserverSnapshot): void {
		if (snapshot.runId === null) return;
		if (!this.observerSnapshots.has(snapshot.runId)) for (const row of snapshot.tasks) this.observerOwners.set(row.id, snapshot.runId);
		this.observerSnapshots.set(snapshot.runId, snapshot);
		const rows = new Map<string, ObserverSnapshot["tasks"][number]>();
		for (const value of this.observerSnapshots.values()) for (const row of value.tasks) if (this.observerOwners.get(row.id) === value.runId) rows.set(row.id, row);
		const tasks = [...rows.values()].sort((a, b) => Number(["pending", "running"].includes(b.status)) - Number(["pending", "running"].includes(a.status))).slice(0, MANAGED_LIMITS.maxSessions).map((row, index) => ({ ...row, ordinal: index + 1 }));
		this.dependencies.onObserver?.({ ...snapshot, runId: null, tasks, phase: tasks.some(row => ["pending", "running"].includes(row.status)) ? "running" : "settled", requestedTasks: tasks.length, admittedTasks: tasks.length, launchedChildren: tasks.filter(row => row.elapsedMs !== null).length, activeChildren: tasks.filter(row => row.executionPhase === "child-execution" && row.status === "running").length, settledTasks: tasks.filter(row => !["pending", "running"].includes(row.status)).length, aggregateAssistantTurns: tasks.reduce((sum, row) => sum + row.assistantTurns, 0) });
	}
	async reset(): Promise<void> {
		await this.shutdown(); this.supervisor = undefined; this.supervisorOwner = undefined;
		this.bindings.clear(); this.delivered.clear(); this.observedEpisodes.clear(); this.closedHandles.clear(); this.stopped = false; this.resetObserver();
		this.sessionViewBuilder.reset();
	}
	suppressWake(): void { this.supervisor?.suppressWake(); }
	allowWake(): void { this.supervisor?.allowWake(); }
	async shutdown(): Promise<void> {
		this.stopped = true; this.inactivity.clear(); await this.supervisor?.shutdown();
		for (const observer of this.observers) observer.finish(true, true);
		this.observers.clear();
	}
	private async owner(ctx: ExtensionContext): Promise<CurrentOwner> {
		const parentSessionFile = ctx.sessionManager.getSessionFile?.();
		return { parentCwd: ctx.cwd, repo: await findCanonicalGitRoot(ctx.cwd, this.dependencies.repositoryHost), parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id), ...(parentSessionFile ? { parentSessionFile } : {}) };
	}
	async resolveRecoveryHandles(ctx: ExtensionContext, handles: readonly string[]): Promise<SessionView[]> {
		if (!ctx.isProjectTrusted()) return [];
		const owner = await this.owner(ctx), store = this.dependencies.store;
		const views: SessionView[] = [];
		for (const handle of handles) {
			try { views.push(store.view(await store.load(handle, owner))); }
			catch { /* Foreign or unavailable handles remain unresolved. */ }
		}
		return views;
	}
	async contextIndex(ctx: ExtensionContext): Promise<SessionView[]> {
		if (!ctx.isProjectTrusted()) return [];
		try { return await this.dependencies.store.list(await this.owner(ctx)); }
		catch (error) { if (error instanceof RepositoryPolicyError && error.code === "repository_root_unavailable") return []; throw error; }
	}
	acknowledgeNotices(ids: readonly string[]): void { this.inactivity.acknowledge(ids); }
	/** A returned pull or request-prepared projection consumes future wakes, never accepts work. */
	acknowledge(result: Pick<SessionActionResult, "sessions">): void {
		this.inactivity.observe(result.sessions.map(view => view.handle));
		for (const view of result.sessions) {
			if (view.state === "closed") {
				this.closedHandles.add(view.handle);
				this.observedEpisodes.delete(view.handle); // Closed records stay fenced after the episode mark is released.
			}
			else if (view.result && ["idle", "interrupted"].includes(view.state)) this.observedEpisodes.set(view.handle, Math.max(view.episode, this.observedEpisodes.get(view.handle) ?? 0));
		}
	}
	async unobservedWake(events: readonly AgentExecutionEvent[], ctx: ExtensionContext): Promise<AgentExecutionEvent[]> {
		if (!events.length || !ctx.isProjectTrusted()) return [];
		const owner = await this.owner(ctx); const remaining: AgentExecutionEvent[] = [];
		for (const event of events) {
			if (event.owner.repository !== owner.repo || event.owner.sessionId !== owner.parentSessionId || (event.owner.branchAnchor && event.owner.branchAnchor !== owner.anchor && !owner.branch.includes(event.owner.branchAnchor))) continue;
			const sessions: AgentExecutionEvent["sessions"] = [];
			for (const view of event.sessions) {
				try {
					const record = await this.dependencies.store.load(view.handle, owner);
					if (record.state !== "closed" && record.episode === view.episode && record.dispatch?.runId === event.runId && record.dispatch.generation === event.generation && (this.observedEpisodes.get(view.handle) ?? 0) < view.episode) sessions.push(view);
				} catch { /* Unavailable/foreign records cannot trigger a turn; durable execution evidence remains inspectable. */ }
			}
			if (sessions.length) remaining.push({ ...event, sessions });
		}
		return remaining;
	}
	/** Fresh live rows from core-owned execution observations; a persisted running/queued state alone never animates a row. */
	liveObserverTasks(): ObserverTask[] {
		const rows = new Map<string, ObserverTask>();
		for (const snapshot of this.observerSnapshots.values()) for (const row of snapshot.tasks) if (this.observerOwners.get(row.id) === snapshot.runId) rows.set(row.id, row);
		return [...rows.values()].filter((row) => row.status === "pending" || row.status === "running")
			.sort((left, right) => left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	}
	/** Immediate model-facing live projection; metadata from durable records alone is not activity. */
	private projectLiveSessions(views: readonly SessionView[]): SessionView[] {
		return views.map(view => {
			if (!["running", "queued"].includes(view.state)) return view;
			const runId = this.observerOwners.get(view.handle), snapshot = runId ? this.observerSnapshots.get(runId) : undefined;
			const row = snapshot?.tasks.find(task => task.id === view.handle && task.episode === view.episode && ["running", "pending"].includes(task.status));
			if (!row || !runId) return view;
			return { ...view, liveActivity: { runId, executionPhase: row.executionPhase, elapsedMs: row.elapsedMs, calls: row.calls.map(call => ({ ...call })), callsTruncated: row.callsTruncated } };
		});
	}
	/** Current admission and live execution facts. Replay and idle candidates are not live work. */
	executionFacts(sessionId: string, branchAnchor: string | null): ProducerFacts {
		const executions: ExecutionFact[] = [];
		if (this.admission) executions.push({ id: "admission", ...(this.admissionToolCallId ? { toolCallId: this.admissionToolCallId } : {}), phase: "preparing", status: "preparing", exitCode: null, summary: "", disposition: "pending" });
		for (const view of this.supervisor?.inspect() ?? []) {
			const binding = this.bindings.get(view.runId);
			const live = view.phase === "preparing" || view.phase === "queued" || view.phase === "running";
			if (live || view.tasks.length === 0) executions.push({
				id: view.runId, runId: view.runId, ...(binding?.toolCallId ? { toolCallId: binding.toolCallId } : {}), phase: live ? view.phase === "running" ? "running" : view.phase === "queued" ? "queued" : "preparing" : "terminal",
				status: view.phase, exitCode: null, summary: live ? "" : `Agent run ${view.runId}: phase ${view.phase}. Full report available through inspect; execution is not acceptance.`,
				disposition: live ? "pending" : binding?.foreground ? "returning" : "pending",
			});
			for (const task of view.tasks) {
				if (task.phase === "preparing" || task.phase === "queued" || task.phase === "running") {
					// A turn another agent started reports to that agent, including its inactivity checkpoint.
					const checkpoint = binding?.initiator.kind === "agent" ? undefined : this.inactivity.checkpoint(view.runId, task.taskId);
					executions.push({ id: `${view.runId}:${task.taskId}`, runId: view.runId, ...(binding?.toolCallId ? { toolCallId: binding.toolCallId } : {}), phase: task.phase, status: task.phase, exitCode: null, summary: "", disposition: "pending", ...(checkpoint ? { checkpoint } : {}) });
					continue;
				}
				const record = binding?.records.find(item => item.handle === task.taskId);
				// A turn another agent started reports to that agent; the main agent reads it through list.
				const observed = binding?.initiator.kind === "agent" || this.closedHandles.has(task.taskId) || record?.state === "closed" || (!!record && (this.observedEpisodes.get(record.handle) ?? 0) >= record.episode);
				const label = record?.task.id ?? task.taskId;
				const cached = binding?.views.get(task.taskId);
				const terminalView = cached?.episode === record?.episode ? cached : undefined;
				// The supervisor marks terminal before its asynchronous publication fills the view.
				// Keep the fact live so another sibling's snapshot cannot consume a partial notice.
				const publishing = !observed && live && !terminalView?.result;
				executions.push({
					id: view.runId + ":" + task.taskId, runId: view.runId, ...(binding?.toolCallId ? { toolCallId: binding.toolCallId } : {}), phase: publishing ? "running" : "terminal", status: publishing ? "publishing" : task.phase, exitCode: null,
					summary: observed || publishing ? "" : taskNotice(label, task.taskId, view.runId, task.phase, terminalView),
					disposition: observed ? "observed" : binding?.foreground ? "returning" : "pending",
				});
			}
		}
		return { version: 1, producer: "agents", availability: this.stopped ? "unavailable" : "ready", sessionId, branchAnchor, generation: this.generation, executions };
	}
	/** Current scoped activity for request preparation, never a new authority or a wake per output. */
	async liveContext(ctx: ExtensionContext): Promise<SessionView[]> {
		return this.projectLiveSessions(await this.contextIndex(ctx)).filter(view => view.liveActivity?.calls.length);
	}
	/** Read-only session-wide view query; never mutates records or controls a child. */
	async sessionView(request: SessionViewRequest, ctx: ExtensionContext): Promise<SessionViewReply> {
		let owner: CurrentOwner | null = null; let reason: string | undefined;
		if (ctx.isProjectTrusted()) {
			try { owner = await this.owner(ctx); }
			catch (error) { const code = (error as { code?: unknown })?.code; reason = typeof code === "string" && code.length > 0 && code.length <= 48 ? code : "owner_unavailable"; }
		}
		return this.sessionViewBuilder.build(request, { ownerSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), trusted: ctx.isProjectTrusted(), owner, ...(reason ? { reason } : {}), live: this.liveObserverTasks(), generation: this.generation });
	}
	sessionViewFailure(request: SessionViewRequest, ownerSessionId: string, anchor: string | null, reason: string): SessionViewReply {
		return this.sessionViewBuilder.failure(request, { ownerSessionId, anchor, generation: this.generation }, reason);
	}
	private failed(action: SessionActionResult["action"], error: unknown, aborted = false): SessionActionResult {
		const known = error instanceof ManagedError || error instanceof RepositoryPolicyError || error instanceof GitWorkspaceError || error instanceof SupervisorError;
		const cause = (error as { code?: unknown })?.code ?? (error instanceof Error && error.name !== "Error" ? error.name : "unclassified");
		return { schemaVersion: MANAGED_SESSION_VERSION, action, status: aborted ? "aborted" : "failed", sessions: [], error: { code: known ? error.code : "managed_operation_failed", ...(error instanceof ManagedError && error.detail ? { detail: error.detail } : known ? {} : { detail: typeof cause === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(cause) ? cause : "unclassified" }), ...(error instanceof ManagedError && error.missingFields ? { missingFields: error.missingFields } : {}), ...(error instanceof ManagedError && error.unexpectedFields ? { unexpectedFields: error.unexpectedFields } : {}), ...(error instanceof ManagedError && error.invalidFields ? { invalidFields: error.invalidFields } : {}), ...(error instanceof ManagedError && error.conflicts ? { conflicts: error.conflicts } : {}) } };
	}
	async execute(raw: unknown, ctx: ExtensionContext, signal?: AbortSignal, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void, toolCallId?: string, options: ExecuteOptions = {}): Promise<SessionActionResult> {
		// Replay identity comes from the host tool-call boundary; a direct service call gets its own fresh identity.
		const callIdentity = fingerprint(["agent-call", toolCallId ?? `direct-${mintProductId()}`]);
		const dispatchCallId = toolCallId ?? callIdentity;
		const rawAction = raw && typeof raw === "object" ? (raw as { action?: unknown }).action : undefined;
		let action: SessionActionResult["action"] = typeof rawAction === "string" && ["create", "continue", "inspect", "apply", "close", "refresh", "join", "cancel", "reconcile"].includes(rawAction) ? rawAction as SessionRequest["action"] : null;
		let request: SessionRequest | undefined;
		const telemetry: ManagedRequestTelemetry = { version: 1, ownerSessionId: ctx.sessionManager.getSessionId(), invocationId: mintProductId(), startedAtMs: Date.now(), durationMs: null, extensionEpoch: null, configurationEpoch: null, requestedTasks: null, admittedTasks: null, launchedChildren: 0, replayedEpisodes: 0 };
		try {
			request = parseSessionRequest(raw); action = request.action;
			telemetry.requestedTasks = request.tasks?.length ?? request.episodes?.length ?? null;
			if (!ctx.isProjectTrusted()) throw new ManagedError("project_trust_required");
			const owner = await this.owner(ctx);
			try { const provenance = await this.dependencies.provenance?.observeExtension(); if (provenance?.available) telemetry.extensionEpoch = provenance.extensionEpoch; } catch { /* Optional. */ }
			let result = await this.action(request, owner, ctx, signal, onProgress, dispatchCallId, callIdentity, telemetry, options.initiator ?? { kind: "main" }, options.admitted, options.detach === true, options.authorize);
			telemetry.durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);
			result = { ...result, sessions: this.projectLiveSessions(result.sessions), requestTelemetry: { ...telemetry, ...(result.kind === "submission" ? { launchedChildren: 0 } : {}) } };
			if (request.action === "inspect" || request.action === "join") this.inactivity.observe(result.sessions.map(view => view.handle));
			return result;
		} catch (error) {
			const result = this.failed(action, error, signal?.aborted);
			if (request?.action === "continue" && ctx.isProjectTrusted()) {
				try { const owner = await this.owner(ctx); result.sessions = await Promise.all(request.episodes!.map(async episode => ({ ...this.dependencies.store.view(await this.dependencies.store.load(episode.handle, owner)), requestError: result.error! }))); } catch { /* Preserve the original typed failure. */ }
			} else if (request?.action === "refresh" && error instanceof ManagedError && error.conflicts) {
				try { result.sessions = [this.dependencies.store.view(await this.dependencies.store.load(request.handle!, await this.owner(ctx)))]; } catch { /* Preserve the conflict even if its view cannot be recovered. */ }
			}
			telemetry.durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);
			return { ...result, requestTelemetry: telemetry };
		}
	}
	private async action(request: SessionRequest, owner: CurrentOwner, ctx: ExtensionContext, signal: AbortSignal | undefined, onProgress: ((tasks: readonly TaskResult[], elapsedMs: number | null) => void) | undefined, toolCallId: string, callIdentity: string, telemetry: ManagedRequestTelemetry, initiator: Participant, admitted?: (handles: readonly string[]) => void, detach = false, authorize?: (records: readonly ManagedRecord[]) => Promise<void>): Promise<SessionActionResult> {
		const store = this.dependencies.store;
		if (request.action === "inspect") {
			if (request.runId) return this.runResult(request.runId, request.action, owner);
			return { schemaVersion: MANAGED_SESSION_VERSION, action: request.action, status: "succeeded", sessions: request.handle ? [store.view(await store.load(request.handle, owner))] : await store.list(owner) };
		}
		if (request.action === "reconcile") {
			const handle = request.handle!, expectedEpisode = request.expectedEpisode!;
			const record = await store.load(handle, owner);
			if (record.episode !== expectedEpisode) throw new ManagedError("stale_episode");
			await this.constrainNestedAccess([record.task]);
			const run = record.dispatch && this.supervisor?.inspect(record.dispatch.runId)[0];
			if (run && record.dispatch?.generation === run.generation && activeState(record)
				&& ["preparing", "queued", "running"].includes(run.phase)) {
				const binding = this.binding(run.runId, owner);
				if (!binding.records.some(bound => bound.handle === handle && bound.episode === expectedEpisode && bound.dispatch?.taskId === record.dispatch?.taskId)) throw new ManagedError("run_owner_mismatch");
				return { schemaVersion: MANAGED_SESSION_VERSION, action: "reconcile", status: "accepted", kind: "submission",
					runId: run.runId, generation: run.generation, sessions: [store.view(record)] };
			}
			try {
				if (activeState(record) || record.state === "interrupted") await store.reconcile(handle, owner, expectedEpisode);
				return await store.withSession(handle, owner, async current => {
					if (current.episode !== expectedEpisode) throw new ManagedError("stale_episode");
					if (activeState(current)) throw new ManagedError("managed_writer_busy_or_unknown");
					if (await store.finalizationPending(handle, expectedEpisode)) throw new ManagedError("result_persistence_unknown");
					if (unsettledWriter(current)) throw new ManagedError("managed_writer_settlement_unknown", undefined, "Use scoped offline recovery after all writers have stopped.");
					const recoveryWorkspaces = current.state !== "closed" && !current.candidate ? await reviewRecoveryWorkspaces(store, current) : [];
					return { schemaVersion: MANAGED_SESSION_VERSION, action: "reconcile", status: "succeeded", sessions: [store.view(current)], recoveryWorkspaces };
				});
			} finally { this.invalidateSessionView(); }
		}
		if (request.action === "join" || request.action === "cancel") {
			const binding = this.binding(request.runId!, owner);
			if (request.action === "join") {
				return this.observeRun(request.runId!, request, owner, signal);
			}
			// One run belongs to one call, so its labels are unambiguous; the handle still wins.
			const target = request.taskId && !binding.records.some(record => record.handle === request.taskId)
				? binding.records.find(record => record.task.id === request.taskId)?.handle ?? request.taskId
				: request.taskId;
			const outcome = target ? binding.control?.cancelTask(target) ?? "not-active" : this.supervisor!.cancel(request.runId!) ? "accepted" : "not-active";
			if (outcome === "accepted") this.inactivity.stop(request.runId!, target);
			return { ...(await this.runResult(request.runId!, "cancel", owner)), cancelOutcome: typeof outcome === "string" ? outcome : String(outcome) };
		}
		if (["apply", "close", "refresh"].includes(request.action)) {
			try {
				const view = await store.withSession(request.handle!, owner, async record => {
					if (record.episode !== request.expectedEpisode) throw new ManagedError("stale_episode");
					if (activeState(record)) throw new ManagedError("session_not_idle");
					if (record.version !== MANAGED_SESSION_VERSION) throw new ManagedError("unsupported_contract");
					if (request.action === "apply" || request.action === "refresh") {
						if (record.state !== "idle") throw new ManagedError("session_not_idle");
						if (isolatedWriteRoots(record).length === 0) throw new ManagedError("not_isolated", undefined, "Only an agent invoked with an isolated workspace has a candidate or pinned input.");
						await this.constrainNestedAccess([record.task]);
						if (request.action === "apply") await applyCandidate(store, record, request.candidateId!);
						else { store.nativePath(record); await syncManagedInputs(store, record); delete record.projectSkills; await store.save(record); }
					} else {
						if (unsettledWriter(record)) throw new ManagedError("managed_writer_settlement_unknown", undefined, "Use scoped offline recovery after all writers have stopped.");
						if (await store.finalizationPending(record.handle, record.episode)) throw new ManagedError("result_persistence_unknown");
						if (uncertainApply(record.candidate)) throw new ManagedError("candidate_recovery_required");
						if (record.state === "closed" && record.retained === false && request.disposition !== "discard") throw new ManagedError("close_disposition_conflict");
						if (request.disposition === "discard") await releaseManagedResources(store, record);
						record.state = "closed"; record.retained = request.disposition !== "discard" || record.release?.status === "partial"; await store.save(record);
						if (record.dispatch) this.inactivity.stop(record.dispatch.runId, record.handle);
					}
					return store.view(record);
				});
				const conflicts = request.action === "apply" ? view.candidate?.roots.filter(root => root.status === "conflict").map(root => conflictScope(root.rootId, root.changedPaths)) ?? [] : [];
				return { schemaVersion: MANAGED_SESSION_VERSION, action: request.action, status: request.action === "apply" && view.candidate?.status !== "applied" ? "failed" : "succeeded", sessions: [view],
					...(conflicts.length ? { error: { code: "convergence_conflict", conflicts, detail: "Conflicting roots were not applied; other roots may already be applied. The Agent's input remains pinned. Reconcile against the current parent in an authorized task or create a fresh Agent; do not force the old candidate." } } : {}) };
			} finally { this.invalidateSessionView(); }
		}
		if (this.stopped) throw new ManagedError("supervisor_closed");
		if (this.admission) throw new ManagedError("managed_admission_active");
		this.admission = true;
		this.admissionToolCallId = toolCallId;
		let runId: string;
		let foreground: boolean;
		let admittedHandles: string[] = [];
		try {
			signal?.throwIfAborted();
			foreground = !detach && (request.mode === "foreground" || !["tui", "rpc"].includes(ctx.mode));
			if (request.mode === "async" && foreground) throw new ManagedError("async_host_mode_unsupported");
			if (request.waitSeconds !== undefined && !foreground) throw new ManagedError("wait_requires_foreground");
			const replays = new Map<string, SessionView>();
			const graph = request.action === "create" ? validateGraphStructure({ tasks: request.tasks! }) : undefined;
			if (graph && !graph.ok) throw new ManagedError(graph.error.code, undefined, graph.error.message);
			const digest = fingerprint(request.action === "create" && graph?.ok ? graph.tasks : request.episodes);
			// One host call is one admission request: its call identity, not a caller token, owns replay.
			const episodeIdentity = (handle: string) => fingerprint([callIdentity, "episode", handle]);
			if (request.action === "create") {
				const replay = await store.replayBatch(owner, callIdentity, digest);
				if (replay) { telemetry.replayedEpisodes = replay.sessions.filter(view => !!view.execution).length; return replay; }
			} else {
				const replayed = await Promise.all(request.episodes!.map(async episode => {
					const record = await store.load(episode.handle, owner);
					store.nativePath(record);
					const prior = record.requests.find(operation => operation.id === episodeIdentity(episode.handle));
					if (!prior) return undefined;
					if (prior.fingerprint !== fingerprint([episode.expectedEpisode, episode.message])) throw new ManagedError("request_id_conflict");
					if (prior.state !== "complete" || !prior.result) return undefined;
					return { handle: record.handle, label: record.task.id, role: record.task.role, episode: prior.episode, state: "idle" as const, reportComplete: prior.result.reportComplete === true, result: await store.withObservation(record.handle, prior.episode, prior.result), ...(prior.candidate ? { candidate: prior.candidate } : {}), ...(prior.execution ? { execution: prior.execution } : {}), ...(prior.error ? { requestError: prior.error } : {}), ...(prior.result.route ? { route: prior.result.route } : {}) };
				}));
				for (const view of replayed) if (view) replays.set(view.handle, view);
				if (replayed.every(view => view !== undefined)) {
					telemetry.replayedEpisodes = replayed.filter(view => view.execution).length;
					const record = await store.load(request.episodes![0]!.handle, owner); const prior = record.requests.find(operation => operation.id === episodeIdentity(request.episodes![0]!.handle))!;
					return { schemaVersion: MANAGED_SESSION_VERSION, action: request.action, kind: "execution", ...(prior.runId ? { runId: prior.runId } : {}), ...(prior.generation ? { generation: prior.generation } : {}), status: replayed.every(view => view.result.status === "succeeded") ? "succeeded" : "failed", sessions: replayed };
				}
			}
			const loaded = await this.dependencies.loadConfig();
			const roleDefinitions = await this.roleDefinitions(owner, ctx);
			if (!loaded.config) throw new ManagedError(loaded.diagnostic?.code ?? "invalid_route_config");
			const config = loaded.config;
			// Custom executors own their invocation; the native default must be available before admission.
			if (this.dependencies.runChild === runChild) resolvePiInvocation([]);
			const ownerKey = fingerprint([owner.repo, owner.parentSessionId]);
			if (this.supervisorOwner && this.supervisorOwner !== ownerKey) throw new ManagedError("managed_owner_mismatch");
			if (!this.supervisor) {
				this.supervisorOwner = ownerKey;
				this.supervisor = new SessionExecutionSupervisor({ repository: owner.repo, sessionId: owner.parentSessionId, branchAnchor: owner.anchor }, { concurrency: config.maxConcurrency, roles: Object.fromEntries(Object.entries(config.routes).map(([role, route]) => [role, route.maxConcurrency])) }, {
					now: this.dependencies.now,
					onEvent: event => this.publish(event),
					onWake: async events => {
						const values = events.flatMap(event => this.delivered.get(event.eventId) ? [this.delivered.get(event.eventId)!] : []).filter(event => !this.bindings.get(event.runId)?.foreground && this.bindings.get(event.runId)?.initiator.kind !== "agent");
						for (const event of events) this.delivered.delete(event.eventId);
						if (values.length && !this.stopped && ctx.isProjectTrusted()) await this.dependencies.onWake?.(values);
					},
				});
			}
			let records: ManagedRecord[];
			let tasks: NormalizedTask[];
			let freshAllocation = false;
			if (graph?.ok) {
				await this.constrainNestedAccess(graph.tasks);
				const admission = await admitRepositoryTasks(owner.repo, graph.tasks, this.dependencies.repositoryHost);
				if (!admission.ok) throw new ManagedError(admission.error.code);
				const related = validateGraphRelationships(admission.tasks); if (!related.ok) throw new ManagedError(related.error.code);
				tasks = admission.tasks;
				// Resolve every requested route before creating any persistent task.
				for (const task of tasks) {
					if (!roleDefinitions.has(task.role)) throw new ManagedError("unknown_role", undefined, `No role definition named ${task.role}. Packaged, user (agent-roles/) and trusted project (.pi/agent-roles/) definitions are available by name.`);
					this.route(task, config, ctx, roleDefinitions.get(task.role));
				}
				const allocation = await store.allocate(owner, callIdentity, tasks, digest);
				if (!allocation.fresh) throw new ManagedError("request_outcome_unknown");
				freshAllocation = true;
				records = allocation.records;
				// Scheduler and record identities use the generated handle; the label stays batch-local.
				const handleByLabel = new Map(tasks.map((task, index) => [task.id, records[index]!.handle] as const));
				tasks = tasks.map((task, index) => ({ ...task, id: records[index]!.handle, dependsOn: (task.dependsOn ?? []).map(label => handleByLabel.get(label)!) }));
			} else {
				records = await Promise.all(request.episodes!.map(episode => store.load(episode.handle, owner)));
				if (records.some(record => record.version !== MANAGED_SESSION_VERSION)) throw new ManagedError("unsupported_contract");
				tasks = records.map(record => {
					const parsed = validateGraphStructure({ tasks: [{ ...record.task, dependsOn: [] }] });
					if (!parsed.ok) throw new ManagedError(parsed.error.code);
					return { ...parsed.tasks[0]!, id: record.handle, dependsOn: [] };
				});
			}
			if (!graph?.ok) await this.constrainNestedAccess(records.filter(record => !replays.has(record.handle)).map(record => record.task));
			const validateReadRoots = async (record: ManagedRecord): Promise<void> => {
				try { await assertCanonicalGrants({ grants: record.roots.filter(root => root.permission === "read").flatMap(root => (root.pins ?? []).map(pin => ({ permission: "read" as const, path: pin.path, pin: { dev: pin.dev, ino: pin.ino } }))) }); }
				catch { throw new ManagedError("capability_invalidated", undefined, CAPABILITY_RECOVERY_HINT); }
			};
			const admissionProgress: AdmissionProgress[] = [];
			let admissionRunId: string | undefined;
			let routes: EffectiveRoute[] = [];
			let receipt: Awaited<ReturnType<SessionExecutionSupervisor["submit"]>>;
			try {
			for (const record of records) if (!replays.has(record.handle)) await validateReadRoots(record);
			routes = records.map(record => replays.get(record.handle)?.route ?? this.route(record.task, config, ctx, roleDefinitions.get(record.task.role)));
			telemetry.replayedEpisodes = replays.size;
			telemetry.admittedTasks = tasks.length;
			try { const provenance = loaded.source ? await this.dependencies.provenance?.observeConfiguration(loaded.source) : undefined; if (provenance?.available) { telemetry.extensionEpoch = provenance.extensionEpoch; telemetry.configurationEpoch = provenance.configurationEpoch; } } catch { /* Optional. */ }
			receipt = await this.supervisor.submit({ requestId: callIdentity, requestKey: digest,
				prepare: async (preparationSignal, identity) => {
					try {
					const inputs = new Map<string, Awaited<ReturnType<typeof captureGitInput>>>();
					for (const record of records) {
						if (replays.has(record.handle)) continue;
						// Shared and isolated writers alike bind to the checkout identity admitted at creation.
						for (const root of managedWriteRoots(record)) await validateRepositoryTarget(root.target);
						for (const root of isolatedWriteRoots(record)) {
							if (!root.inputs && !root.input && !inputs.has(root.source)) inputs.set(root.source, await captureGitInput(root.source));
						}
					}
					preparationSignal.throwIfAborted();
					for (const [index, record] of records.entries()) {
						if (replays.has(record.handle)) continue;
						const expected = request.episodes?.[index]?.expectedEpisode ?? 0;
						if (record.state !== "idle" || record.episode !== expected) throw new ManagedError(record.episode !== expected ? "stale_episode" : "session_not_idle");
						if (record.episode >= MANAGED_LIMITS.maxEpisodes) throw new ManagedError("episode_limit");
						await validateReadRoots(record);
						if (uncertainApply(record.candidate)) throw new ManagedError("candidate_recovery_required");
						if ((await store.nativeRevision(record)).leaf !== record.nativeLeaf) throw new ManagedError("native_leaf_mismatch");
					}
					await authorize?.(records);
					this.bindings.set(identity.runId, { initiator, owner, toolCallId, records: records.map(record => replays.has(record.handle) ? { ...record, episode: replays.get(record.handle)!.episode } : record), foreground, views: new Map(replays), replayed: new Set(replays.keys()) });
					admissionRunId = identity.runId;
					for (const [index, record] of records.entries()) {
						if (replays.has(record.handle)) continue;
						const retained: AdmissionProgress["retained"] = [];
						// Cover this record and any ref the call retains even when its save fails, so a rejected
						// admission never strands an input ref behind an unwritten record.
						const progress: AdmissionProgress = { handle: record.handle, runId: identity.runId, retained };
						admissionProgress.push(progress);
						await store.withSession(record.handle, owner, async current => {
							if (current.state !== "idle" || current.episode !== record.episode) throw new ManagedError("session_not_idle");
							if (uncertainApply(current.candidate)) throw new ManagedError("candidate_recovery_required");
							if ((await store.nativeRevision(current)).leaf !== current.nativeLeaf) throw new ManagedError("native_leaf_mismatch");
							// The rollback snapshot must be the record observed under this lock: a same-episode refresh
							// or apply accepted between the outer load and here is state this admission builds on.
							progress.before = structuredClone(current);
							for (const root of managedWriteRoots(current)) await validateRepositoryTarget(root.target);
							for (const root of isolatedWriteRoots(current)) {
								const input = inputs.get(root.source);
								if (!root.inputs) {
									if (!root.input && input) { root.input = input; root.inputRef = await retainGitInput(root.source, root.id, input); retained.push({ rootId: root.id, source: root.source, ref: root.inputRef, input }); }
									else if (root.input && root.inputRef) await inspectGitInput(root.source, root.inputRef, root.input);
									else throw new ManagedError("managed_input_ref_missing");
								}
							}
							current.episode++; current.state = "queued"; delete current.result; delete current.candidate;
							current.route = routes[index]!;
							current.inheritSkills = config.roles[current.task.role]?.inheritSkills ?? true;
							if (current.projectSkills === undefined && current.roots.some(root => root.source === owner.repo)) {
								const parentSkills = this.dependencies.getParentSkills?.(owner.repo);
								if (parentSkills !== undefined) current.projectSkills = selectedProjectSkills(owner.repo, parentSkills);
							}
							current.dispatch = { ...identity, toolCallId, taskId: tasks[index]!.id, initiator: initiator.kind === "main" ? "main" : initiator.name };
							if (current.episode === 1) current.assigner = initiator.kind === "main" ? "main" : initiator.name;
							current.requests.push({ id: episodeIdentity(current.handle), fingerprint: request.episodes?.[index] ? fingerprint([request.episodes[index]!.expectedEpisode, request.episodes[index]!.message]) : digest, episode: current.episode, state: "running", runId: identity.runId, generation: identity.generation });
							await store.save(current);
							try { this.dependencies.peer?.turnStarted(current, identity.runId, initiator); } catch { /* Telemetry only. */ }
							records[index] = current; this.bindings.get(identity.runId)!.records[index] = current;
							this.bindings.get(identity.runId)!.views.set(current.handle, store.view(current));
						});
					}
					const response: SessionActionResult = { schemaVersion: MANAGED_SESSION_VERSION, action: request.action, status: "accepted", kind: "submission", ...identity, sessions: records.map(record => store.view(record)) };
					if (request.action === "create") { await store.completeBatch(owner, callIdentity, response); this.bindings.get(identity.runId)!.committed = true; }
					return records;
					} finally { this.invalidateSessionView(); }
				},
				execute: (prepared, execution) => this.run(request, owner, prepared, tasks, execution, telemetry, ctx, replays, callIdentity, onProgress),
			}, signal);
			} catch (error) {
				// Prepared records never reached a child unless the durable batch was booked. Otherwise unwind only
				// what this admission provably owns; state changed outside it stays inspectable and reports an
				// explicit, actionable cleanup failure.
				const booked = admissionRunId !== undefined && this.bindings.get(admissionRunId)?.committed === true;
				if (!booked) {
					let unwound = false;
					try { unwound = await this.unwindAdmission(owner, admissionProgress, freshAllocation ? callIdentity : undefined); }
					catch { unwound = false; }
					if (admissionRunId) this.bindings.delete(admissionRunId);
					if (unwound) throw error;
					const cause = (error as { code?: unknown })?.code;
					throw new ManagedError("admission_cleanup_incomplete", undefined, typeof cause === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(cause) ? cause : "unclassified");
				}
				// A booked submission cancelled before its receipt is settled by its own terminal event.
				throw error;
			}
			runId = receipt.runId;
			admittedHandles = records.map(record => record.handle);
			if (!foreground) return { schemaVersion: MANAGED_SESSION_VERSION, action: request.action, status: "accepted", kind: "submission", runId, generation: receipt.generation, sessions: records.map(record => store.view(record)) };
		} finally { this.admission = false; this.admissionToolCallId = undefined; admitted?.(admittedHandles); }
		const abort = () => { this.supervisor!.cancel(runId!); };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try { return await this.observeRun(runId!, request, owner); }
		finally {
			signal?.removeEventListener("abort", abort);
			// After this observer returns, later completion belongs to the ordinary async wake path.
			const binding = this.bindings.get(runId!); if (binding) binding.foreground = false;
		}
	}
	/** Release observation for main-loop events without forwarding that signal to execution. */
	private async observeRun(runId: string, request: SessionRequest, owner: CurrentOwner, signal?: AbortSignal): Promise<SessionActionResult> {
		const window = this.dependencies.mainLoopYield?.open({ ignore: ref => ref.runId === runId });
		let reason: YieldReason | undefined;
		try {
			await this.supervisor!.join(runId, window ? signal ? AbortSignal.any([signal, window.signal]) : window.signal : signal, request.waitSeconds);
		} catch (error) {
			if (!window?.signal.aborted || signal?.aborted) throw error;
			reason = window.reason;
		} finally { window?.close(); }
		const result = await this.runResult(runId, request.action, owner);
		if (reason) return { ...result, wait: { status: "yielded", reason } };
		return result.status === "accepted" ? { ...result, wait: { status: "expired", waitSeconds: request.waitSeconds ?? DEFAULT_OBSERVATION_WAIT_SECONDS } } : result;
	}
	/** Unwind facts and refs a rejected admission prepared; never touch state this call cannot prove it wrote. */
	private async unwindAdmission(owner: CurrentOwner, progress: readonly AdmissionProgress[], reservation: string | undefined): Promise<boolean> {
		const store = this.dependencies.store;
		let complete = true;
		let released = true;
		// Reverse order leaves any partial cleanup pointing at the last record the admission reached.
		for (const entry of [...progress].reverse()) {
			let settled = false;
			try {
				await store.withSession(entry.handle, owner, async current => {
					const pending = current.dispatch?.runId === entry.runId && current.state === "queued" && current.requests.at(-1)?.runId === entry.runId && current.requests.at(-1)?.state === "running";
					// Discard this admission's own pins first; their ownership stays on the record until that succeeds.
					// A pin that cannot be discarded keeps a durable owner fact instead of becoming orphaned behind a
					// deleted reservation, and foreign drift is preserved rather than replaced.
					const unreleased: typeof entry.retained = [];
					for (const retained of entry.retained) {
						try { await discardGitInput(retained.source, retained.ref, retained.input); }
						catch { unreleased.push(retained); }
					}
					if (pending) {
						if (!entry.before) throw new ManagedError("admission_state_unknown");
						restoreAdmissionState(current, entry.before);
					}
					let recorded = true;
					for (const retained of unreleased) {
						const root = current.roots.find(item => item.id === retained.rootId);
						if (!root || (root.inputRef !== undefined && root.inputRef !== retained.ref)) { recorded = false; continue; }
						root.input = retained.input; root.inputRef = retained.ref;
					}
					if (pending || unreleased.length) await store.save(current);
					if (unreleased.length || !recorded) released = false;
					settled = recorded;
				});
			} catch { complete = false; released = false; continue; }
			if (!settled) complete = false;
		}
		if (!complete || !released) return false;
		if (reservation === undefined) return true;
		try { return await store.releaseReservation(owner, reservation); }
		catch { return false; }
	}
	/** A child may request only what its own enclosing grants already cover; a main actor is unrestricted. */
	private async constrainNestedAccess(tasks: readonly Pick<AgentTask, "id" | "access">[]): Promise<void> {
		const enclosing = await this.dependencies.enclosingCapability?.();
		if (!enclosing) return;
		for (const task of tasks) for (const requested of normalizeAccess(task.access)) {
			// Reuse physical range/identity checks, not merely lexical prefix coverage.
			const decision = await authorizePath(enclosing, requested.permission, requested.path);
			if (!decision.allowed) throw new ManagedError("nested_access_denied", undefined, `Task ${task.id} requests access outside the enclosing child capability.`);
		}
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
		return { schemaVersion: MANAGED_SESSION_VERSION, action, kind: running ? "submission" : "execution", status: binding.deliveryError || view.phase === "failed" ? "failed" : running ? "accepted" : view.phase === "cancelled" ? "aborted" : sessions.every(session => session.result?.status === "succeeded") ? "succeeded" : sessions.some(session => session.result?.status === "succeeded") ? "partial" : "failed", runId, generation: view.generation, sessions, ...(binding.deliveryError ? { error: { code: binding.deliveryError } } : {}) };
	}
	private async publish(event: ExecutionEvent): Promise<void> {
		const binding = this.bindings.get(event.runId); if (!binding) return;
		// Preparation never produced a dispatchable episode (and, for a new batch, never booked one): the
		// rejection unwinds its own reservation, so it must not also settle a synthetic failed episode or
		// notify for execution that never started.
		if (event.kind === "run-terminal" && event.run && event.run.preparedAt === null && binding.committed !== true) return;
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
		const value: AgentExecutionEvent = { version: 5, eventId: event.eventId, kind: event.kind, runId: event.runId, generation: event.generation, owner: event.owner, toolCallId: binding.toolCallId, sessions, foreground: binding.foreground,
			...(run && Number.isFinite(run.submittedAt) ? { timing: { clockKey: createRunClock(this.dependencies.now).clockKey, submittedAtMs: run.submittedAt, preparedAtMs: run.preparedAt, finishedAtMs: event.task?.finishedAt ?? run.finishedAt, ...(event.task ? { queuedAtMs: event.task.queuedAt, startedAtMs: event.task.startedAt } : {}) } } : {}),
			...(!event.task && binding.runObservation ? { runObservation: binding.runObservation } : {}),
		};
		try {
			for (const record of records) await this.dependencies.store.write(join(this.dependencies.store.path(record.handle), `event_${record.episode}_${event.kind}.json`), value);
			await this.dependencies.onExecution?.(value);
			if (event.kind === "task-terminal") { try { await this.dependencies.peer?.turnTerminal(value, binding.initiator); } catch { /* Receipts never fail execution evidence. */ } }
			this.delivered.set(event.eventId, value);
			while (this.delivered.size > 256) this.delivered.delete(this.delivered.keys().next().value!);
		} catch (error) { binding.deliveryError = "terminal_delivery_failed"; throw error; }
	}
	private async run(request: SessionRequest, owner: CurrentOwner, records: ManagedRecord[], tasks: NormalizedTask[], execution: ExecutionContext, telemetry: ManagedRequestTelemetry, ctx: ExtensionContext, replays: Map<string, SessionView>, callIdentity: string, onProgress?: (tasks: readonly TaskResult[], elapsedMs: number | null) => void): Promise<SessionActionResult> {
		const clock = createRunClock(this.dependencies.now); const store = this.dependencies.store;
		const binding = this.bindings.get(execution.runId)!;
		// Readable labels stay batch-local; scheduler and result ids use the persistent handle.
		const labelFor = new Map(records.map(record => [record.handle, record.task.id] as const));
		const observer = ["tui", "rpc"].includes(ctx.mode) ? new ManagedObserver(execution.runId, owner, this.generation, records.map(record => ({ id: record.handle, role: record.task.role, episode: replays.get(record.handle)?.episode ?? record.episode, route: replays.get(record.handle)?.route ?? record.route!, replayed: replays.has(record.handle), label: record.task.id, objective: record.task.objective })), () => clock.elapsed(), snapshot => this.publishObserver(snapshot), () => ++this.observerRevision) : undefined;
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
					if (replay) return Promise.resolve({ ...replay.result!, id: task.id, label: record.task.id, usage: emptyUsage(), durationMs: 0, telemetry: { childStarted: false, queueMs: 0, workspaceMs: 0, childMs: 0, convergenceMs: 0 } });
					return execution.runTask({ ...task, signal: episodeSignal }, sharedSignal => {
					const message = request.episodes?.[index]?.message ?? [...(record.task.inputs ?? []), ...predecessors.map(result => `Predecessor ${labelFor.get(result.id) ?? result.id} (${result.status}):\n${result.output || "(no output)"}`)].join("\n\n");
					const childSignal = AbortSignal.any([episodeSignal, sharedSignal]);
					const stopInactivity = () => this.inactivity.stop(execution.runId, record.handle);
					if (!childSignal.aborted) this.inactivity.start(execution.runId, record.handle, record.task.id);
					childSignal.addEventListener("abort", stopInactivity, { once: true });
					const trackedLifecycle: ChildLifecycle = { ...lifecycle, activity: activity => { this.inactivity.activity(execution.runId, record.handle, activity); lifecycle.activity(activity); } };
					return this.episode(record.handle, owner, message, childSignal, trackedLifecycle, telemetry, observer, () => binding.control!.enterConvergence(task.id), ctx).then(result => ({ ...result, id: task.id, label: record.task.id })).finally(() => { childSignal.removeEventListener("abort", stopInactivity); stopInactivity(); });
					});
				},
			});
			let persistenceLost = false;
			for (const [index, record] of records.entries()) {
				if (replays.has(record.handle)) continue;
				const pendingFinalization = await store.finalizationPending(record.handle, record.episode);
				const current = await store.load(record.handle, owner);
				if (pendingFinalization) {
					persistenceLost = true;
					const { candidate: _candidate, ...safe } = current;
					binding.views.set(record.handle, store.view({ ...safe, state: "interrupted", result: scheduled.tasks[index]! }));
					continue;
				}
				if (current.episode === record.episode && activeState(current)) try {
					await store.withSession(record.handle, owner, async value => {
						value.result = scheduled.tasks[index]!; value.state = "idle";
						const operation = value.requests.at(-1)!; operation.state = "complete"; operation.result = value.result;
						if (value.result.error) operation.error = { code: value.result.error.code };
						await store.save(value);
					});
				} catch {
					persistenceLost = true;
					const { candidate: _candidate, ...safe } = current;
					binding.views.set(record.handle, store.view({ ...safe, state: "interrupted", result: scheduled.tasks[index]! }));
				}
			}
			if (persistenceLost) binding.deliveryError = "result_persistence_failed";
			const response: SessionActionResult = { schemaVersion: MANAGED_SESSION_VERSION, action: request.action, kind: "execution", runId: execution.runId, generation: this.supervisor!.currentGeneration, status: persistenceLost ? "failed" : scheduled.status, sessions: await Promise.all(binding.records.map(record => this.boundView(binding, record))), ...(persistenceLost ? { error: { code: "result_persistence_failed" } } : {}) };
			if (request.action === "create" && !persistenceLost) await store.completeBatch(owner, callIdentity, response);
			try {
				const observed = structuredClone(scheduled.telemetry);
				const identities = new Map(tasks.map((task, index) => [task.id, scheduled.tasks[index]?.observation?.ownerSessionId ?? fingerprint(records[index]!.handle)]));
				if (observed.timing) for (const span of [...observed.timing.children, ...observed.timing.waits]) span.taskId = identities.get(span.taskId) ?? fingerprint(span.taskId);
				binding.runObservation = { telemetry: observed, clockKey: clock.clockKey, originMs: clock.valid ? clock.started : null };
				if (binding.foreground) this.dependencies.onRun?.(binding.runObservation);
			} catch { /* Optional observation. */ }
			observer?.finish(scheduled.status !== "succeeded", scheduled.status === "aborted");
			return response;
		} finally { this.inactivity.stop(execution.runId); if (observer) { observer.finish(true, execution.signal.aborted); this.observers.delete(observer); } }
	}
	private route(task: Pick<NormalizedTask, "role" | "model" | "thinking" | "executionProfile" | "thinkingProfile">, config: NonNullable<ConfigLoadResult["config"]>, ctx: ExtensionContext, definition?: AgentRoleDefinition): EffectiveRoute {
		const context: RouteContext = { ...(ctx.model ? { parentModel: ctx.model as NonNullable<RouteContext["parentModel"]> } : {}), ...(ctx.thinkingLevel ? { parentThinking: ctx.thinkingLevel } : {}), modelRegistry: ctx.modelRegistry as unknown as RouteContext["modelRegistry"] };
		const result = resolveRoute(task.role, config, context, task, definition); if (!result.ok) throw new ManagedError(result.error.code); return result.route;
	}
	/** Packaged, user and trusted project role definitions, read at each admission and episode. */
	async roleDefinitions(owner: Pick<CurrentOwner, "repo">, ctx: Pick<ExtensionContext, "isProjectTrusted">): Promise<Map<string, AgentRoleDefinition>> {
		if (this.dependencies.loadRoleDefinitions) return this.dependencies.loadRoleDefinitions(owner.repo, ctx.isProjectTrusted());
		try { return (await loadRoleDefinitions({ agentDir: this.dependencies.agentDir ?? getAgentDir(), projectRoot: owner.repo, trusted: ctx.isProjectTrusted() })).roles; }
		catch { return new Map(); }
	}
	private async episode(handle: string, owner: CurrentOwner, message: string, signal: AbortSignal, lifecycle: ChildLifecycle, telemetry: ManagedRequestTelemetry, observer: ManagedObserver | undefined, enterConvergence: () => boolean, ctx?: ExtensionContext): Promise<TaskResult> {
		const store = this.dependencies.store;
		const definitions = ctx ? await this.roleDefinitions(owner, ctx).catch(() => new Map<string, AgentRoleDefinition>()) : new Map<string, AgentRoleDefinition>();
		try { return await store.withSession(handle, owner, async record => {
			const operation = record.requests.at(-1)!;
			let childResult: TaskResult | undefined;
			let finalizationPending = false;
			let finalizationStage: "native-validation" | "candidate-freeze" | "result-save" = "native-validation";
			try {
				if (record.version !== MANAGED_SESSION_VERSION || record.state !== "queued") throw new ManagedError("session_not_queued");
				signal.throwIfAborted();
				if (Buffer.byteLength(message) + Buffer.byteLength(record.task.objective) > HARD_LIMITS.maxPromptBytes) throw new ManagedError("prompt_too_large");
				const preparationStarted = this.dependencies.now();
				// Shared writers edit the assigned checkout directly; only isolated roots get a private worktree.
				await prepareManagedWorkspace(store, record);
				const workspaceMs = Math.max(0, this.dependencies.now() - preparationStarted);
				await store.writerPhase(handle, "not-started");
				record.state = "running";
				record.execution = { startedAtMs: Date.now(), ...(record.inheritSkills === undefined ? {} : { inheritSkills: record.inheritSkills }), provenance: telemetry.extensionEpoch && telemetry.configurationEpoch ? { available: true, extensionEpoch: telemetry.extensionEpoch, configurationEpoch: telemetry.configurationEpoch } : { available: false } };
				operation.execution = record.execution; await store.save(record);
				const writes = managedWriteRoots(record);
				const sourceRoot = writes[0]?.source ?? record.roots[0]?.source ?? owner.repo;
				const parentSkills = sourceRoot === owner.repo ? this.dependencies.getParentSkills?.(sourceRoot) : undefined;
				// The checkout may have been replaced while this turn waited for capacity.
				for (const root of writes) await validateRepositoryTarget(root.target);
				const cwd = store.nativeCwd(record);
				const scratch = join(store.path(handle), "scratch");
				await mkdir(cwd, { recursive: true });
				await mkdir(scratch, { recursive: true });
				const sharedWrites = writes.length > 0 && isolatedWriteRoots(record).length === 0 ? sharedWritesDirectory(store, record) : undefined;
				if (sharedWrites) { await rm(sharedWrites, { recursive: true, force: true }); await mkdir(sharedWrites, { recursive: true, mode: 0o700 }); }
				const parsed = validateGraphStructure({ tasks: [{ ...record.task, dependsOn: [] }] });
				if (!parsed.ok) throw new ManagedError(parsed.error.code);
				const preparedBySource = new Map(record.roots.flatMap(root => root.inputs?.gitWorkspace ? [[root.source, root.inputs.gitWorkspace.path] as const] : []));
				const preparedPin = async (path: string): Promise<{ dev: number; ino: number } | undefined> => {
					try { const info = await lstat(path); return info.isFile() || info.isDirectory() ? { dev: info.dev, ino: info.ino } : undefined; }
					catch { return undefined; }
				};
				// A writable or missing selector binds to its nearest existing prepared directory,
				// never to a mutable leaf, so an authorized create/delete/atomic replacement keeps work.
				const preparedAnchor = async (path: string): Promise<{ path: string; dev: number; ino: number } | undefined> => {
					let current = path;
					for (;;) {
						const info = await lstat(current).catch(() => undefined);
						if (info?.isDirectory()) return { path: current, dev: info.dev, ino: info.ino };
						const parent = dirname(current);
						if (parent === current) return undefined;
						current = parent;
					}
				};
				// One truthful source -> prepared resolution for grants, roots and guidance: a same-repo
				// auxiliary read root reuses the writable worktree instead of advertising the live checkout.
				const preparedPathFor = (root: (typeof record.roots)[number]): string => root.inputs?.gitWorkspace?.path ?? preparedBySource.get(root.source) ?? root.source;
				const grants: ChildCapabilityManifest["grants"] = [];
				for (const root of record.roots) {
					const shared = root.permission === "write" && root.git && record.task.workspace === "shared";
					const prepared = root.inputs?.gitWorkspace?.path ?? preparedBySource.get(root.source) ?? (shared ? root.source : undefined);
					if (root.permission === "write" && prepared) {
						for (const relative of root.paths) {
							const path = relative === "." || relative === "" ? prepared : join(prepared, relative);
							const anchor = await preparedAnchor(path);
							grants.push({ permission: "write", path, ...(anchor ? { anchor } : {}) });
						}
					} else for (const relative of root.paths) {
						const mapped = root.git && prepared && !relative.startsWith("/");
						const path = mapped ? (relative === "." || relative === "" ? prepared : join(prepared, relative)) : root.git && !relative.startsWith("/") ? join(root.source, relative) : relative;
						// A prepared read range is bound to the prepared file's own identity; a direct
						// source or external read keeps its admission (source) pin instead.
						const pin = mapped ? await preparedPin(path) : root.pins?.find(candidate => candidate.path === path || candidate.path === join(root.source, relative));
						grants.push({ permission: "read", path, ...(pin ? { pin: { dev: pin.dev, ino: pin.ino } } : {}) });
					}
				}
				const guidanceParts = [];
				const guidanceSeen = new Set<string>();
				for (const root of record.roots.filter(item => item.git)) {
					const prepared = preparedPathFor(root);
					const key = `${root.source}\0${prepared}`;
					if (guidanceSeen.has(key)) continue;
					guidanceSeen.add(key);
					const ownRoot = root.source === owner.repo;
					const skills = ownRoot ? this.dependencies.getParentSkills?.(root.source) : undefined;
					guidanceParts.push(await prepareChildGuidance(root.source, prepared, record.inheritSkills ?? true, undefined, undefined, skills, ownRoot ? record.projectSkills : undefined));
				}
				const preparedGuidance = guidanceParts.length ? mergeChildGuidance(guidanceParts) : undefined;
				const capability: ChildCapabilityManifest = { version: CHILD_CAPABILITY_MANIFEST_VERSION, role: record.task.role, cwd, grants, roots: record.roots.map(root => ({ id: root.id, source: root.source, path: preparedPathFor(root), permission: root.permission })), ...(record.task.may ? { may: record.task.may } : {}), ...(sharedWrites ? { sharedWrites } : {}), ...(definitions.get(record.task.role) ? { rolePrompt: definitions.get(record.task.role)!.systemPrompt } : {}) };
				const native = store.nativePath(record);
				const revision = await store.nativeRevision(record);
				if (revision.leaf !== record.nativeLeaf) throw new ManagedError("native_leaf_mismatch");
				await store.writerPhase(handle, "launch-intent");
				const childProof = store.childProofBinding(handle, record.episode);
				const link = this.dependencies.peer?.openLink(record, capability);
				const result = await this.dependencies.runChild({ ...(link ? { link: link.binding } : {}), task: { ...parsed.tasks[0]!, roots: record.roots.map(root => ({ id: root.id, source: root.source, path: preparedPathFor(root), permission: root.permission, git: root.git, paths: root.paths })) }, role: getManagedRole(record.task.role, writes.length > 0, definitions.get(record.task.role)?.systemPrompt), route: record.route!, cwd, sourceRoot, inheritSkills: record.inheritSkills ?? true, ...(parentSkills === undefined ? {} : { parentSkills }), ...(record.projectSkills === undefined ? {} : { projectSkills: record.projectSkills }), ...(preparedGuidance ? { preparedGuidance } : {}), prompt: message, approveProject: true, signal, managedProcessGroup: true,
					guardExtensionPath: fileURLToPath(new URL("./worker-tools.ts", import.meta.url)),
					managedWorkerScratch: scratch, ...(childProof ? { childProof } : {}), ...(writes[0]?.inputs ? { managedWorkerInputs: writes[0].inputs } : {}),
					capability,
					diagnosticSession: { path: native, ref: `managed/${handle}/native`, ownerSessionId: revision.sessionId, async removeUnused() {} },
					onChildStarted: () => { telemetry.launchedChildren++; observer?.childStarted(handle); lifecycle.childStarted(); }, onChildSettled: () => { observer?.childStopped(handle); lifecycle.childSettled(); }, onActivity: lifecycle.activity,
				}).finally(() => { observer?.childStopped(handle); link?.close(); });
				result.id = record.handle; result.label = record.task.id;
				result.executionStatus = result.telemetry?.childStarted === true ? result.status : result.telemetry?.childStarted === false ? "not-started" : "unavailable";
				childResult = result;
				if (result.telemetry) result.telemetry.workspaceMs = workspaceMs;
				record.result = result; record.nativeLeaf = (await store.nativeRevision(record)).leaf;
				const requiresToolSettlement = writes.length > 0;
				record.state = requiresToolSettlement && result.workerToolsSettled !== true ? "interrupted" : "idle";
				if (record.state === "interrupted" && result.status === "succeeded") record.result = { ...result, status: "failed", finalization: { status: "failed", stage: "candidate-freeze", code: "worker_tools_unsettled" }, error: { code: "worker_tools_unsettled", message: "Worker tools did not settle." } };
				// A dead parent may have left candidate Git writers behind. Fence before the first convergence write.
				await store.beginFinalization(handle, record.episode); finalizationPending = true;
				if (sharedWrites) {
					try { const written = await readSharedWrites(sharedWrites); result.changedPaths = written.paths; }
					catch { /* Attribution is optional evidence; the working-tree diff remains authoritative. */ }
				}
				if (isolatedWriteRoots(record).length > 0 && result.status === "succeeded" && result.reportComplete && record.state === "idle") {
					if (!enterConvergence()) record.result = { ...result, status: "aborted", executionStatus: result.status, finalization: { status: "failed", stage: "candidate-freeze", code: "aborted" }, error: { code: "aborted", message: "aborted" } };
					else { finalizationStage = "candidate-freeze"; await freezeCandidate(store, record); result.changedPaths = record.candidate?.changedPaths ?? []; }
				}
				operation.state = "complete"; operation.result = record.result;
				if (record.candidate) operation.candidate = structuredClone(record.candidate);
				finalizationStage = "result-save";
				if (result.workerToolsSettled === true) await store.writerPhase(handle, "settled");
				await store.save(record);
				await store.endFinalization(handle, record.episode); finalizationPending = false;
				if (record.result.observation) record.result.observation = await store.saveObservation(handle, record.episode, record.result.observation);
				return record.result;
			} catch (error) {
				record.state = "interrupted"; operation.state = "unknown";
				const failure = this.failed(null, error, signal.aborted).error!;
				record.result = childResult ? { ...childResult, status: signal.aborted ? "aborted" : "failed", executionStatus: childResult.executionStatus ?? "unavailable",
					finalization: { status: "failed", stage: finalizationStage, code: failure.code, ...(failure.detail ? { reason: failure.detail } : {}) },
					error: { code: failure.code, message: failure.code } } : { ...failedTask(record, signal.aborted, failure.code), executionStatus: record.execution ? "unavailable" : "not-started" };
				delete record.candidate; delete operation.candidate;
				operation.result = record.result;
				operation.error = { code: failure.code, ...(failure.detail ? { detail: failure.detail } : {}) };
				try { await store.save(record); if (finalizationPending) { await store.endFinalization(handle, record.episode); finalizationPending = false; } }
				catch { /* Preserve failed child evidence in this request; a pending fence makes any uncertain registry result non-actionable. */ }
				return record.result;
			}
		});
		} finally { this.invalidateSessionView(); }
	}
}

export function registerContinuationTool(pi: ExtensionAPI, dependencies: Partial<ContinuationDependencies> = {}): ContinuationService {
	let context: ExtensionContext | undefined;
	let hub: PeerHub | undefined;
	const bridge: PeerBridge = {
		openLink: (record, capability) => hub?.openLink(record, capability),
		turnStarted: (record, runId, initiator) => hub?.turnStarted(record, runId, initiator),
		turnTerminal: (event, initiator) => hub?.turnTerminal(event, initiator),
	};
	const current = (event: AgentExecutionEvent) => context?.isProjectTrusted() && context.sessionManager.getSessionId() === event.owner.sessionId && (!event.owner.branchAnchor || context.sessionManager.getLeafId() === event.owner.branchAnchor || context.sessionManager.getBranch().some(entry => entry.id === event.owner.branchAnchor));
	const publishFacts = (): void => {
		if (!context) return;
		try { pi.events.emit(EXECUTION_FACTS_EVENT, service.executionFacts(context.sessionManager.getSessionId(), context.sessionManager.getLeafId())); }
		catch { /* Fact publication cannot fail an admitted execution. */ }
	};
	const mainLoopYield = dependencies.mainLoopYield ?? createMainLoopYield(pi);
	const service = new ContinuationService({ peer: bridge, ...dependencies,
		mainLoopYield,
		onFactsChanged: () => { publishFacts(); dependencies.onFactsChanged?.(); },
		onObserver: dependencies.onObserver ?? (snapshot => pi.events.emit(OBSERVER_EVENT, snapshot)),
		onSessionViewChange: dependencies.onSessionViewChange ?? (() => pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {})),
		onExecution: event => {
			if (!dependencies.onExecution && current(event)) { pi.appendEntry(AGENT_EXECUTION_EVENT, event); pi.events.emit(AGENT_EXECUTION_EVENT, event); }
			else dependencies.onExecution?.(event);
			publishFacts();
		},
		onWake: async events => {
			publishFacts();
			await dependencies.onWake?.(events);
		},
	});
	hub = new PeerHub({ service, mainLoopYield, context: () => context,
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		sendToMain: (text, details) => pi.sendMessage({ customType: AGENT_MESSAGE_TYPE, content: text, display: true, details }, { deliverAs: "steer", triggerTurn: true }),
	});
	service.peerHub = hub;
	registerRecoveryDiscovery(pi, service);
	pi.events.on(EXECUTION_FACTS_REQUEST, (raw) => {
		const accept = (raw as Partial<ProducerFactsRequest> | undefined)?.accept;
		if (typeof accept !== "function") return;
		if (!context) { accept(emptyProducerFacts("agents", "unknown")); return; }
		accept(service.executionFacts(context.sessionManager.getSessionId(), context.sessionManager.getLeafId()));
	});
	pi.events.on(NOTICE_ACK, raw => {
		const ack = raw as Partial<NoticeAck> | undefined;
		if (ack?.version === 1 && ack.producer === "agents" && Array.isArray(ack.ids) && ack.ids.every(id => typeof id === "string")) { service.acknowledgeNotices(ack.ids); void hub?.noticesShown(ack.ids); }
	});
	pi.events.on(SESSION_VIEW_REQUEST_EVENT, (data: unknown) => {
		// Display-only request/reply: malformed or foreign requests never affect execution.
		const request = parseSessionViewRequest(data);
		if (!request || !context || !["tui", "rpc"].includes(context.mode)) return;
		const ctx = context;
		const ownerSessionId = ctx.sessionManager.getSessionId();
		const anchor = ctx.sessionManager.getLeafId();
		const started = performance.now();
		void (async () => {
			let reply: SessionViewReply;
			try {
				const parsed = parseSessionViewReply(await service.sessionView(request, ctx));
				reply = parsed.ok ? parsed.value : service.sessionViewFailure(request, ownerSessionId, anchor, "core_reply_invalid");
			} catch { reply = service.sessionViewFailure(request, ownerSessionId, anchor, "core_query_failed"); }
			const parsed = parseSessionViewReply(reply);
			if (!parsed.ok) return;
			pi.events.emit(SESSION_VIEW_EVENT, parsed.value);
			// One bounded, redacted audit per query, not per heartbeat. Never append to a new owner after a session switch.
			if (context === ctx && ctx.sessionManager.getSessionId() === ownerSessionId && ctx.isProjectTrusted()) {
				try { pi.appendEntry(SESSION_VIEW_QUERY_EVENT, { version: 1, source: "core", requestId: request.requestId, durationMs: Math.max(0, performance.now() - started), state: reply.history.state, ...(reply.history.reason ? { reason: reply.history.reason } : {}) }); }
				catch { /* Optional audit failure does not alter display delivery or execution. */ }
			}
		})();
	});
	pi.on("session_start", async (_event, ctx) => { context = ctx; await service.reset(); hub?.reset(); publishFacts(); });
	// Results returned to the main agent count as shown once its next model request carries them.
	pi.on("turn_start", () => { hub?.promoteShown("main"); });
	pi.on("session_tree", async (_event, ctx) => { await service.reset(); hub?.reset(); context = ctx; publishFacts(); });
	pi.on("agent_start", (_event, ctx) => { context = ctx; publishFacts(); });
	pi.on("session_compact_failed", event => { if (event.aborted) service.suppressWake(); });
	pi.on("input", event => { if (event.source === "interactive" || event.source === "rpc") service.allowWake(); });
	pi.on("agent_end", (event) => { if (event.messages.some(message => message.role === "assistant" && ["aborted", "error"].includes(message.stopReason))) service.suppressWake(); });
	pi.on("context_with_system", (event) => {
		if (!event.messages.some(message => message.role === "custom" && message.customType === "agents.live-activity")) return;
		return { messages: event.messages.filter(message => !(message.role === "custom" && message.customType === "agents.live-activity")) };
	});
	pi.on("tool_execution_end", event => {
		if (!PEER_TOOLS.includes(event.toolName)) return;
		const details = event.result.details as Pick<SessionActionResult, "sessions"> & { schemaVersion?: number } | undefined;
		if (details?.schemaVersion === MANAGED_SESSION_VERSION && Array.isArray(details.sessions)) { service.acknowledge(details); publishFacts(); }
	});
	// Inside a managed child the guard owns these tools and forwards them to the invoking hub.
	if (process.env[CHILD_MARKER_ENV] !== "1") for (const tool of peerToolDefinitions(async (op, args, signal, toolCallId, ctx) => {
		context = ctx;
		await hub!.start();
		const outcome = await hub!.execute(op, args, hub!.mainCaller(), signal, toolCallId);
		publishFacts();
		return outcome;
	})) pi.registerTool(tool);
	pi.on("session_shutdown", async () => { context = undefined; await service.shutdown(); await hub?.shutdown(); });
	return service;
}
