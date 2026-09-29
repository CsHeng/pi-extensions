import type { CurrentOwner, ManagedState } from "./session-contracts.ts";
import type { ManagedSessionStore, SessionInventoryResult } from "./managed-sessions.ts";
import { parseObserverTask, parseObserverRoute, type ObserverTask } from "./observer-events.ts";
import {
	projectRecordedUsage,
	type ObservedUsage,
	type RecordedCoverage,
	type RecordedUsageFailure,
	type RecordedUsageHandleInput,
	type RecordedUsageMetric,
	type RecordedUsageProjection,
} from "./observability.ts";

export const SESSION_VIEW_REQUEST_EVENT = "csheng.subagents.session-view.request";
export const SESSION_VIEW_EVENT = "csheng.subagents.session-view";
/** Invalidation only; contains no owner data and prompts an open consumer to requery its current scope. */
export const SESSION_VIEW_CHANGED_EVENT = "csheng.subagents.session-view.changed";
export const SESSION_VIEW_VERSION = 1 as const;
/** Display delivery bounds; intentionally independent of open-session admission limits. */
export const SESSION_VIEW_LIMITS = Object.freeze({ pageSize: 20, maxLiveRows: 16, maxRequestPage: 1_000_000, maxPayloadBytes: 256 * 1024 });

export interface SessionViewLimits { pageSize: number; maxLiveRows: number; maxRequestPage: number; maxPayloadBytes: number }
export interface SessionViewRequest { version: typeof SESSION_VIEW_VERSION; requestId: string; page: number }
export type SessionViewOutcome = "succeeded" | "failed" | "aborted" | "unknown";

export interface SessionViewHistoryRow {
	handle: string;
	route?: ObserverTask["route"];
	role: "worker" | "reviewer" | "explorer";
	/** Durable managed state; running/queued without a fresh live row is unconfirmed, never animated. */
	state: ManagedState;
	episode: number;
	latestOutcome: SessionViewOutcome;
	acceptedEpisodes: number | null;
	onCurrentBranch: boolean;
	legacy: boolean;
	reportComplete: boolean;
	retained: boolean;
	recordedUsage: RecordedUsageProjection;
}

export interface SessionViewSummary { agents: number; acceptedEpisodes: number | null; states: Record<ManagedState, number>; liveAgents: number }

export interface SessionViewReply {
	version: typeof SESSION_VIEW_VERSION;
	requestId: string;
	/** Core-derived correlation; the consumer drops replies from any other owner, session or request. */
	ownerSessionId: string;
	anchor: string | null;
	generation: string;
	/** History-projection revision; lifecycle transitions invalidate it, heartbeats never do. */
	revision: number;
	inventory: { state: "ready" | "unavailable"; reason?: string; complete: boolean; unreadableRecords: number };
	summary: SessionViewSummary | null;
	live: ObserverTask[];
	history: { state: "ready" | "unavailable"; reason?: string; pageSize: number; page: number; totalRows: number; totalPages: number; rows: SessionViewHistoryRow[] };
	usage: RecordedUsageProjection | null;
}

export interface SessionViewScope {
	ownerSessionId: string;
	anchor: string | null;
	trusted: boolean;
	owner: CurrentOwner | null;
	/** Bounded reason when the trusted owner could not be derived. */
	reason?: string;
	live: readonly ObserverTask[];
	generation: string;
}

interface ProjectionCache { key: string; revision: number; inventory: SessionInventoryResult; usage: RecordedUsageProjection | null; rows: Map<string, RecordedUsageProjection> }

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const BOUNDED_REASON = /^[a-z0-9_]{1,48}$/;
const MANAGED_STATES: readonly ManagedState[] = ["idle", "queued", "running", "interrupted", "closed"];
const OUTCOMES: readonly SessionViewOutcome[] = ["succeeded", "failed", "aborted", "unknown"];
const COVERAGES: readonly RecordedCoverage[] = ["complete", "incomplete", "unavailable"];
const FAILURES: readonly RecordedUsageFailure[] = ["invalid-input", "conflicting-rows", "row-budget"];
const METRIC_KEYS: readonly RecordedUsageMetric[] = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"];
const REQUEST_KEYS = ["version", "requestId", "page"];
const SUMMARY_KEYS = ["agents", "acceptedEpisodes", "states", "liveAgents"];
const ROW_KEYS = ["handle", "role", "state", "episode", "latestOutcome", "acceptedEpisodes", "onCurrentBranch", "legacy", "reportComplete", "retained", "recordedUsage"];
const USAGE_KEYS = ["status", "usage", "assistantTurns", "metrics", "turnsCoverage", "episodes", "conflicts", "reason"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysExact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return Object.keys(record).every((key) => allowed.has(key)) && required.every((key) => key in record);
}

function opaqueId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_ID.test(value) && !TERMINAL_CONTROL.test(value) && Buffer.byteLength(value, "utf8") <= 128;
}

function nonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function intOrNull(value: unknown): value is number | null {
	return value === null || nonNegativeInt(value);
}

function boundedReason(value: unknown): value is string {
	return typeof value === "string" && BOUNDED_REASON.test(value);
}

function parseUsageFields(value: unknown): ObservedUsage | undefined {
	if (!isRecord(value) || !keysExact(value, METRIC_KEYS)) return undefined;
	const usage = {} as Record<RecordedUsageMetric, number | null>;
	for (const field of METRIC_KEYS) {
		const item = value[field];
		if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0)) return undefined;
		usage[field] = item as number | null;
	}
	return usage;
}

export function parseRecordedUsageProjection(value: unknown): RecordedUsageProjection | undefined {
	if (!isRecord(value) || !keysExact(value, USAGE_KEYS.slice(0, 7), ["reason"])) return undefined;
	if (!COVERAGES.includes(value.status as RecordedCoverage) || !COVERAGES.includes(value.turnsCoverage as RecordedCoverage)) return undefined;
	if (!nonNegativeInt(value.conflicts)) return undefined;
	const usage = parseUsageFields(value.usage);
	if (usage === undefined || !intOrNull(value.assistantTurns)) return undefined;
	const metrics = value.metrics;
	if (!isRecord(metrics) || !keysExact(metrics, METRIC_KEYS)
		|| !METRIC_KEYS.every((field) => COVERAGES.includes(metrics[field] as RecordedCoverage))) return undefined;
	if (!isRecord(value.episodes) || !keysExact(value.episodes, ["recorded", "missing", "orphaned", "unprovable"])
		|| !nonNegativeInt(value.episodes.recorded) || !nonNegativeInt(value.episodes.missing) || !nonNegativeInt(value.episodes.orphaned)
		|| typeof value.episodes.unprovable !== "boolean") return undefined;
	if (value.reason !== undefined && !FAILURES.includes(value.reason as RecordedUsageFailure)) return undefined;
	// Failure and unknown-aggregation shapes never smuggle a complete metric or a fabricated total.
	if (value.status === "unavailable") {
		if (value.assistantTurns !== null || METRIC_KEYS.some((field) => usage[field] !== null)) return undefined;
		if (!METRIC_KEYS.every((field) => metrics[field] === "unavailable") || value.turnsCoverage !== "unavailable") return undefined;
	}
	if (value.reason !== undefined && value.status !== "unavailable") return undefined;
	return { status: value.status as RecordedCoverage, usage, assistantTurns: value.assistantTurns as number | null,
		metrics: metrics as Record<RecordedUsageMetric, RecordedCoverage>, turnsCoverage: value.turnsCoverage as RecordedCoverage,
		episodes: { recorded: value.episodes.recorded, missing: value.episodes.missing, orphaned: value.episodes.orphaned, unprovable: value.episodes.unprovable },
		conflicts: value.conflicts, ...(value.reason === undefined ? {} : { reason: value.reason as RecordedUsageFailure }) };
}

export function parseSessionViewRequest(value: unknown): SessionViewRequest | undefined {
	if (!isRecord(value) || !keysExact(value, REQUEST_KEYS)) return undefined;
	if (value.version !== SESSION_VIEW_VERSION || !opaqueId(value.requestId) || !nonNegativeInt(value.page) || value.page > SESSION_VIEW_LIMITS.maxRequestPage) return undefined;
	return { version: SESSION_VIEW_VERSION, requestId: value.requestId, page: value.page };
}

function parseHistoryRow(value: unknown): SessionViewHistoryRow | undefined {
	if (!isRecord(value) || !keysExact(value, ROW_KEYS, ["route"])) return undefined;
	const route = value.route === undefined ? undefined : parseObserverRoute(value.route);
	if (value.route !== undefined && route === undefined) return undefined;
	if (!opaqueId(value.handle) || !["worker", "reviewer", "explorer"].includes(value.role as string)) return undefined;
	if (!MANAGED_STATES.includes(value.state as ManagedState) || !OUTCOMES.includes(value.latestOutcome as SessionViewOutcome)) return undefined;
	if (!nonNegativeInt(value.episode) || !intOrNull(value.acceptedEpisodes)) return undefined;
	if (typeof value.onCurrentBranch !== "boolean" || typeof value.legacy !== "boolean" || typeof value.reportComplete !== "boolean" || typeof value.retained !== "boolean") return undefined;
	const recordedUsage = parseRecordedUsageProjection(value.recordedUsage);
	if (recordedUsage === undefined) return undefined;
	return { handle: value.handle, ...(route === undefined ? {} : { route }), role: value.role as SessionViewHistoryRow["role"], state: value.state as ManagedState, episode: value.episode,
		latestOutcome: value.latestOutcome as SessionViewOutcome, acceptedEpisodes: value.acceptedEpisodes as number | null,
		onCurrentBranch: value.onCurrentBranch, legacy: value.legacy, reportComplete: value.reportComplete, retained: value.retained, recordedUsage };
}

export function parseSessionViewReply(value: unknown): { ok: true; value: SessionViewReply } | { ok: false } {
	if (!isRecord(value) || !keysExact(value, ["version", "requestId", "ownerSessionId", "anchor", "generation", "revision", "inventory", "summary", "live", "history", "usage"])) return { ok: false };
	try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > SESSION_VIEW_LIMITS.maxPayloadBytes) return { ok: false }; } catch { return { ok: false }; }
	if (value.version !== SESSION_VIEW_VERSION || !opaqueId(value.requestId) || !opaqueId(value.ownerSessionId)) return { ok: false };
	if ((value.anchor !== null && !opaqueId(value.anchor)) || !opaqueId(value.generation) || !nonNegativeInt(value.revision)) return { ok: false };
	if (!isRecord(value.inventory) || !keysExact(value.inventory, ["state", "complete", "unreadableRecords"], ["reason"])) return { ok: false };
	if (value.inventory.state !== "ready" && value.inventory.state !== "unavailable") return { ok: false };
	if (value.inventory.reason !== undefined && !boundedReason(value.inventory.reason)) return { ok: false };
	if (typeof value.inventory.complete !== "boolean" || !nonNegativeInt(value.inventory.unreadableRecords)) return { ok: false };
	if (value.inventory.complete && value.inventory.state !== "ready") return { ok: false };
	let summary: SessionViewSummary | null = null;
	if (value.summary !== null) {
		if (!isRecord(value.summary) || !keysExact(value.summary, SUMMARY_KEYS)) return { ok: false };
		if (!nonNegativeInt(value.summary.agents) || !intOrNull(value.summary.acceptedEpisodes) || !nonNegativeInt(value.summary.liveAgents)) return { ok: false };
		const states = value.summary.states;
		if (!isRecord(states) || !keysExact(states, MANAGED_STATES) || !MANAGED_STATES.every((state) => nonNegativeInt(states[state]))) return { ok: false };
		summary = { agents: value.summary.agents, acceptedEpisodes: value.summary.acceptedEpisodes as number | null,
			states: states as Record<ManagedState, number>, liveAgents: value.summary.liveAgents };
	}
	if (!Array.isArray(value.live) || value.live.length > SESSION_VIEW_LIMITS.maxLiveRows) return { ok: false };
	const live: ObserverTask[] = [];
	const liveIds = new Set<string>();
	for (const row of value.live) {
		const task = parseObserverTask(row);
		if (!task || liveIds.has(task.id) || (task.status !== "pending" && task.status !== "running")) return { ok: false };
		liveIds.add(task.id);
		live.push(task);
	}
	if (!isRecord(value.history) || !keysExact(value.history, ["state", "pageSize", "page", "totalRows", "totalPages", "rows"], ["reason"])) return { ok: false };
	if (value.history.state !== "ready" && value.history.state !== "unavailable") return { ok: false };
	if (value.history.reason !== undefined && !boundedReason(value.history.reason)) return { ok: false };
	if (!nonNegativeInt(value.history.pageSize) || value.history.pageSize === 0 || value.history.pageSize > SESSION_VIEW_LIMITS.pageSize || !nonNegativeInt(value.history.page)
		|| !nonNegativeInt(value.history.totalRows) || !nonNegativeInt(value.history.totalPages)) return { ok: false };
	if (!Array.isArray(value.history.rows) || value.history.rows.length > value.history.pageSize) return { ok: false };
	if (value.history.totalPages !== Math.ceil(value.history.totalRows / value.history.pageSize)) return { ok: false };
	if (value.history.page >= Math.max(1, value.history.totalPages)) return { ok: false };
	if (value.history.state === "unavailable" && value.history.rows.length > 0) return { ok: false };
	const rows: SessionViewHistoryRow[] = [];
	const rowIds = new Set<string>();
	for (const row of value.history.rows) {
		const parsed = parseHistoryRow(row);
		if (!parsed || rowIds.has(parsed.handle) || liveIds.has(parsed.handle)) return { ok: false };
		rowIds.add(parsed.handle);
		rows.push(parsed);
	}
	let usage: RecordedUsageProjection | null = null;
	if (value.usage !== null) {
		const parsed = parseRecordedUsageProjection(value.usage);
		if (parsed === undefined) return { ok: false };
		usage = parsed;
	}
	if (summary !== null && summary.liveAgents !== live.length) return { ok: false };
	if (summary === null && value.inventory.state === "ready" && value.inventory.complete) return { ok: false };
	if (value.history.state === "ready" && value.usage === null && value.summary !== null) return { ok: false };
	return { ok: true, value: { version: SESSION_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId,
		anchor: value.anchor as string | null, generation: value.generation, revision: value.revision,
		inventory: { state: value.inventory.state, ...(value.inventory.reason === undefined ? {} : { reason: value.inventory.reason as string }),
			complete: value.inventory.complete, unreadableRecords: value.inventory.unreadableRecords },
		summary, live,
		history: { state: value.history.state, ...(value.history.reason === undefined ? {} : { reason: value.history.reason as string }),
			pageSize: value.history.pageSize, page: value.history.page, totalRows: value.history.totalRows, totalPages: value.history.totalPages, rows },
		usage } };
}

/** Retained read-only projection of the session inventory plus recorded usage, with lifecycle invalidation. */
export class SessionViewBuilder {
	private revision = 0;
	private cache: ProjectionCache | undefined;
	private pending: { key: string; revision: number; promise: Promise<ProjectionCache> } | undefined;
	private readonly limits: SessionViewLimits;
	constructor(private readonly options: { store: ManagedSessionStore; limits?: Partial<SessionViewLimits> }) {
		this.limits = { ...SESSION_VIEW_LIMITS, ...options.limits };
	}
	/** Lifecycle invalidation; coalesced into the next query's rebuild. */
	invalidate(): void { this.revision++; }
	/** Owner/session change: drop the retained projection entirely. */
	reset(): void { this.invalidate(); this.cache = undefined; }
	private async rebuild(key: string, owner: CurrentOwner, revision: number): Promise<ProjectionCache> {
		const inventory = await this.options.store.inventory(owner);
		if (!inventory.available) return { key, revision, inventory, usage: null, rows: new Map() };
		const inputs: RecordedUsageHandleInput[] = [];
		const rows = new Map<string, RecordedUsageProjection>();
		for (const entry of inventory.entries) {
			const episodes = await this.options.store.recordedObservations(entry.handle, entry.usageEvidence.episodes);
			const input = { handle: entry.handle, expectedEpisodes: entry.acceptedEpisodes, episodes };
			inputs.push(input);
			rows.set(entry.handle, projectRecordedUsage([input]));
		}
		return { key, revision, inventory, usage: projectRecordedUsage(inputs), rows };
	}
	async build(request: SessionViewRequest, scope: SessionViewScope): Promise<SessionViewReply> {
		const revision = this.revision;
		const live = scope.trusted ? [...scope.live] : [];
		const gate = !scope.trusted ? "project_trust_required" : scope.owner === null ? (scope.reason ?? "owner_unavailable") : undefined;
		let inventory: SessionViewReply["inventory"] = gate === undefined ? { state: "ready", complete: true, unreadableRecords: 0 } : { state: "unavailable", reason: gate, complete: false, unreadableRecords: 0 };
		let summary: SessionViewSummary | null = null;
		let usage: RecordedUsageProjection | null = null;
		let nonLive: SessionViewHistoryRow[] = [];
		let historyReason = gate;
		if (gate === undefined && scope.owner !== null) {
			const key = JSON.stringify([scope.owner.repo, scope.owner.parentSessionId, scope.owner.anchor, scope.owner.branch]);
			try {
				let cache = this.cache;
				if (!cache || cache.key !== key || cache.revision !== revision) {
					let pending = this.pending;
					if (!pending || pending.key !== key || pending.revision !== revision) {
						pending = { key, revision, promise: this.rebuild(key, scope.owner, revision) };
						this.pending = pending;
					}
					try { cache = await pending.promise; } finally { if (this.pending === pending) this.pending = undefined; }
					// A late read may answer its original request, but cannot poison the new owner's/revision's cache.
					if (this.revision === revision) this.cache = cache;
				}
				if (!cache.inventory.available) {
					// Unusable storage is an explicit unavailable history, never an empty success.
					inventory = { state: "unavailable", reason: cache.inventory.reason, complete: false, unreadableRecords: 0 };
					historyReason = cache.inventory.reason;
				} else {
					inventory = { state: "ready", complete: cache.inventory.complete, unreadableRecords: cache.inventory.problems.unreadableRecords };
					summary = { ...cache.inventory.summary, liveAgents: live.length };
					usage = cache.usage;
					const liveHandles = new Set(live.map((row) => row.id));
					nonLive = cache.inventory.entries.filter((entry) => !liveHandles.has(entry.handle)).map((entry) => ({
						handle: entry.handle, route: entry.route, role: entry.role, state: entry.state, episode: entry.episode, latestOutcome: entry.latestOutcome,
						acceptedEpisodes: entry.acceptedEpisodes, onCurrentBranch: entry.onCurrentBranch, legacy: entry.legacy,
						reportComplete: entry.reportComplete, retained: entry.retained, recordedUsage: cache.rows.get(entry.handle)!,
					}));
				}
			} catch {
				// An unexpected history failure stays visible; live rows and core execution continue independently.
				inventory = { state: "unavailable", reason: "history_query_failed", complete: false, unreadableRecords: 0 };
				historyReason = "history_query_failed";
			}
		}
		const pageSize = this.limits.pageSize;
		const totalRows = nonLive.length;
		const totalPages = Math.ceil(totalRows / pageSize);
		const page = Math.min(request.page, Math.max(0, totalPages - 1));
		let reply: SessionViewReply = { version: SESSION_VIEW_VERSION, requestId: request.requestId, ownerSessionId: scope.ownerSessionId,
			anchor: scope.anchor, generation: scope.generation, revision, inventory, summary, live,
			history: historyReason === undefined ? { state: "ready", pageSize, page, totalRows, totalPages, rows: nonLive.slice(page * pageSize, page * pageSize + pageSize) }
				: { state: "unavailable", reason: historyReason, pageSize, page: 0, totalRows: 0, totalPages: 0, rows: [] },
			usage };
		if (Buffer.byteLength(JSON.stringify(reply), "utf8") > this.limits.maxPayloadBytes) {
			// A page that cannot be delivered degrades visibly; it never pretends to be complete inventory.
			reply = { ...reply, history: { ...reply.history, state: "unavailable", reason: "payload_limit", page: 0, rows: [] } };
		}
		if (Buffer.byteLength(JSON.stringify(reply), "utf8") > this.limits.maxPayloadBytes) {
			reply = { ...reply, summary: null, usage: null, live: [],
				inventory: { state: "ready", complete: false, unreadableRecords: 0 },
				history: { state: "unavailable", reason: "payload_limit", pageSize, page: 0, totalRows: 0, totalPages: 0, rows: [] } };
		}
		return reply;
	}
}
