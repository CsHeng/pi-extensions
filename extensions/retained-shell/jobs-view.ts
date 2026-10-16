/** Owner-scoped read-only Jobs snapshot. Queries never start, cancel, renew, wake, or enter model context. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ShellExecutionView, ShellScope, ShellStatus } from "./execution.ts";

export const JOBS_VIEW_VERSION = 1;
export const JOBS_VIEW_REQUEST_EVENT = "csheng.shell.jobs-view.request";
export const JOBS_VIEW_EVENT = "csheng.shell.jobs-view";
/** Invalidation only; contains no execution payload and prompts an open consumer to requery. */
export const JOBS_VIEW_CHANGED_EVENT = "csheng.shell.jobs-view.changed";
/** Owner reset or shutdown. Consumers drop cached snapshots and requery after a new bind. */
export const JOBS_VIEW_RESET_EVENT = "csheng.shell.jobs-view.reset";

const STATUSES = ["running", "exited", "cancelled", "deadline", "interrupted"] as const;
const REASONS = ["untrusted", "other-owner", "unreachable"] as const;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const REQUEST_KEYS = ["version", "requestId"];
const CHANGED_KEYS = ["version", "generation"];
const RESET_KEYS = ["version", "generation"];
const RESET_OPTIONAL = ["ownerSessionId", "anchor"];
const REPLY_KEYS = ["version", "requestId", "ownerSessionId", "anchor", "generation", "availability"];
const REPLY_OPTIONAL = ["reason", "records", "retained"];
const RECORD_KEYS = ["executionId", "label", "status", "exitCode", "startedAt", "terminalAt", "lastOutputAt"];

export type JobsClaim = "ready" | "other-owner" | "inactive";
export type JobsViewReason = (typeof REASONS)[number];
export interface JobsViewRequest { version: typeof JOBS_VIEW_VERSION; requestId: string }
export interface JobsViewChanged { version: typeof JOBS_VIEW_VERSION; generation: string }
export interface JobsViewReset { version: typeof JOBS_VIEW_VERSION; generation: string; ownerSessionId?: string; anchor?: string | null }
export interface JobsViewRecord {
	executionId: string;
	label: string;
	/** Human-only bounded first command line; not persisted in shell events. */
	commandPreview?: string;
	status: ShellStatus;
	exitCode: number | null;
	startedAt: number;
	terminalAt: number | null;
	lastOutputAt: number | null;
}
export interface JobsViewReply {
	version: typeof JOBS_VIEW_VERSION;
	requestId: string;
	ownerSessionId: string;
	anchor: string | null;
	generation: string;
	availability: "ready" | "unavailable";
	reason?: JobsViewReason;
	/** Inline Jobs projection: background work only, with brief successful exits omitted. */
	records?: JobsViewRecord[];
	/** Every owner-retained record in the current session and branch. Not durable history. */
	retained?: JobsViewRecord[];
}
export interface JobsViewSource {
	list(scope: ShellScope): ShellExecutionView[];
	subscribeDisplay(listener: () => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysExact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return Object.keys(record).every((key) => allowed.has(key)) && required.every((key) => key in record);
}
function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !TERMINAL_CONTROL.test(value);
}
function instant(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function exitCode(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}
function leafId(ctx: ExtensionContext): string | null {
	const leaf = ctx.sessionManager.getLeafId();
	return typeof leaf === "string" && leaf.length > 0 ? leaf : null;
}
function scopeOf(ctx: ExtensionContext): ShellScope {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		branchAnchor: leafId(ctx),
		branchIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
	};
}

export function parseJobsViewRequest(value: unknown): JobsViewRequest | undefined {
	if (!isRecord(value) || !keysExact(value, REQUEST_KEYS)) return undefined;
	if (value.version !== JOBS_VIEW_VERSION || !boundedText(value.requestId, 128)) return undefined;
	return { version: JOBS_VIEW_VERSION, requestId: value.requestId };
}
export function parseJobsViewChanged(value: unknown): JobsViewChanged | undefined {
	if (!isRecord(value) || !keysExact(value, CHANGED_KEYS)) return undefined;
	if (value.version !== JOBS_VIEW_VERSION || !boundedText(value.generation, 32)) return undefined;
	return { version: JOBS_VIEW_VERSION, generation: value.generation };
}
export function parseJobsViewReset(value: unknown): JobsViewReset | undefined {
	if (!isRecord(value) || !keysExact(value, RESET_KEYS, RESET_OPTIONAL)) return undefined;
	if (value.version !== JOBS_VIEW_VERSION || !boundedText(value.generation, 32)) return undefined;
	if ("ownerSessionId" in value && !boundedText(value.ownerSessionId, 256)) return undefined;
	if ("anchor" in value && value.anchor !== null && !boundedText(value.anchor, 256)) return undefined;
	return {
		version: JOBS_VIEW_VERSION,
		generation: value.generation,
		...("ownerSessionId" in value ? { ownerSessionId: value.ownerSessionId as string } : {}),
		...("anchor" in value ? { anchor: value.anchor as string | null } : {}),
	};
}
function parseRecords(value: unknown): JobsViewRecord[] | undefined {
	// The owner controls retention; validate every row without imposing a UI execution quota.
	if (!Array.isArray(value)) return undefined;
	const records: JobsViewRecord[] = [];
	for (const item of value) {
		const parsed = parseRecord(item);
		if (!parsed) return undefined;
		records.push(parsed);
	}
	return records;
}
function parseRecord(value: unknown): JobsViewRecord | undefined {
	if (!isRecord(value) || !keysExact(value, RECORD_KEYS, ["commandPreview"])) return undefined;
	if (!boundedText(value.executionId, 64) || !boundedText(value.label, 32)) return undefined;
	if (value.commandPreview !== undefined && !boundedText(value.commandPreview, 512)) return undefined;
	if (typeof value.status !== "string" || !STATUSES.includes(value.status as ShellStatus)) return undefined;
	if (!exitCode(value.exitCode) || !instant(value.startedAt)) return undefined;
	if (value.terminalAt !== null && !instant(value.terminalAt)) return undefined;
	if (value.lastOutputAt !== null && !instant(value.lastOutputAt)) return undefined;
	if (value.status === "running" && value.exitCode !== null) return undefined;
	return {
		executionId: value.executionId,
		label: value.label,
		...(value.commandPreview === undefined ? {} : { commandPreview: value.commandPreview as string }),
		status: value.status as ShellStatus,
		exitCode: value.exitCode,
		startedAt: value.startedAt,
		terminalAt: value.terminalAt as number | null,
		lastOutputAt: value.lastOutputAt as number | null,
	};
}
export function parseJobsViewReply(value: unknown): { ok: true; value: JobsViewReply } | { ok: false } {
	if (!isRecord(value) || !keysExact(value, REPLY_KEYS, REPLY_OPTIONAL)) return { ok: false };
	if (value.version !== JOBS_VIEW_VERSION || !boundedText(value.requestId, 128) || !boundedText(value.ownerSessionId, 256)) return { ok: false };
	if (value.anchor !== null && !boundedText(value.anchor, 256)) return { ok: false };
	if (!boundedText(value.generation, 32) || (value.availability !== "ready" && value.availability !== "unavailable")) return { ok: false };
	if (value.availability === "unavailable") {
		if (!("reason" in value) || typeof value.reason !== "string" || !REASONS.includes(value.reason as JobsViewReason) || "records" in value || "retained" in value) return { ok: false };
		return { ok: true, value: { version: JOBS_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId, anchor: value.anchor, generation: value.generation, availability: "unavailable", reason: value.reason as JobsViewReason } };
	}
	if ("reason" in value) return { ok: false };
	const records = parseRecords(value.records);
	if (!records) return { ok: false };
	if (!("retained" in value)) return { ok: true, value: { version: JOBS_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId, anchor: value.anchor, generation: value.generation, availability: "ready", records } };
	const retained = parseRecords(value.retained);
	if (!retained) return { ok: false };
	return { ok: true, value: { version: JOBS_VIEW_VERSION, requestId: value.requestId, ownerSessionId: value.ownerSessionId, anchor: value.anchor, generation: value.generation, availability: "ready", records, retained } };
}

/** Running detached work is visible immediately. Brief successful background work disappears on close. */
export function isVisibleBackgroundJob(view: ShellExecutionView): boolean {
	if (!view.background) return false;
	if (view.status === "running" || view.status !== "exited" || view.exitCode !== 0) return true;
	return view.terminalAt !== null && view.terminalAt - view.startedAt >= 30_000;
}

function project(view: ShellExecutionView): JobsViewRecord {
	const running = view.status === "running";
	return {
		executionId: view.executionId,
		label: view.label,
		commandPreview: view.commandPreview,
		status: view.status,
		exitCode: running ? null : view.exitCode,
		startedAt: view.startedAt,
		terminalAt: running ? null : view.terminalAt,
		lastOutputAt: view.lastOutputAt,
	};
}

export function registerJobsView(pi: ExtensionAPI, source: JobsViewSource, claim: () => JobsClaim) {
	let ctx: ExtensionContext | undefined;
	let generation = 0;
	let bound = false;
	let boundSession = "";
	let boundAnchor: string | null = null;
	const generationId = () => String(generation);
	const emit = (name: string, data: unknown) => { try { pi.events.emit(name, data); } catch { /* Observer delivery cannot change execution. */ } };
	const unsubscribe = source.subscribeDisplay(() => { if (bound) invalidate(); });
	const invalidate = (): void => {
		if (!bound) return;
		emit(JOBS_VIEW_CHANGED_EVENT, { version: JOBS_VIEW_VERSION, generation: generationId() } satisfies JobsViewChanged);
	};
	const answer = (data: unknown): void => {
		const request = parseJobsViewRequest(data);
		if (!request || !ctx || !bound) return;
		const ownerSessionId = ctx.sessionManager.getSessionId();
		if (!ownerSessionId) return;
		const anchor = leafId(ctx);
		const trusted = ctx.isProjectTrusted();
		const mode = claim();
		const reason: JobsViewReason | undefined = !trusted ? "untrusted" : mode === "other-owner" ? "other-owner" : mode === "inactive" ? "unreachable" : undefined;
		const listed = reason ? undefined : source.list(scopeOf(ctx));
		const reply: JobsViewReply = reason
			? { version: JOBS_VIEW_VERSION, requestId: request.requestId, ownerSessionId, anchor, generation: generationId(), availability: "unavailable", reason }
			: { version: JOBS_VIEW_VERSION, requestId: request.requestId, ownerSessionId, anchor, generation: generationId(), availability: "ready", records: listed?.filter(isVisibleBackgroundJob).map(project) ?? [], retained: listed?.map(project) ?? [] };
		const parsed = parseJobsViewReply(reply);
		if (parsed.ok) emit(JOBS_VIEW_EVENT, parsed.value);
	};
	pi.events.on(JOBS_VIEW_REQUEST_EVENT, answer);
	const bind = (next: ExtensionContext): void => {
		ctx = next;
		generation += 1;
		bound = true;
		boundSession = next.sessionManager.getSessionId() ?? "";
		boundAnchor = leafId(next);
		const ownerSessionId = next.sessionManager.getSessionId();
		emit(JOBS_VIEW_RESET_EVENT, { version: JOBS_VIEW_VERSION, generation: generationId(), ...(ownerSessionId ? { ownerSessionId } : {}), anchor: boundAnchor } satisfies JobsViewReset);
		emit(JOBS_VIEW_CHANGED_EVENT, { version: JOBS_VIEW_VERSION, generation: generationId() } satisfies JobsViewChanged);
	};
	return {
		bind,
		ensure(next: ExtensionContext) {
			const sessionId = next.sessionManager.getSessionId() ?? "";
			const anchor = leafId(next);
			if (bound && boundSession === sessionId && boundAnchor === anchor) { ctx = next; return; }
			bind(next);
		},
		unbind() {
			bound = false;
			generation += 1;
			ctx = undefined;
			boundSession = "";
			boundAnchor = null;
			emit(JOBS_VIEW_RESET_EVENT, { version: JOBS_VIEW_VERSION, generation: generationId() } satisfies JobsViewReset);
		},
		dispose() { unsubscribe(); },
	};
}
