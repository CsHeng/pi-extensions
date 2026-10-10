import {
	HARD_LIMITS,
	ROLE_NAMES,
	TASK_EXECUTION_PHASES,
	THINKING_LEVELS,
	type RoleName,
	type TaskExecutionPhase,
	type TaskStatus,
	type ThinkingLevel,
} from "./contracts.ts";

import { isProductId } from "./identity.ts";

export const OBSERVER_EVENT = "csheng.subagents.observer.v4";
export const OBSERVER_VERSION = 4 as const;
export const OBSERVER_PHASES = ["accepted", "running", "settling", "settled"] as const;
export const MAX_HEADLINE_BYTES = 240;
export const MAX_ACTIVE_TOOLS = 16;
export const MAX_TOOL_NAME_BYTES = 64;
const TASK_STATUSES = ["pending", "running", "succeeded", "failed", "blocked", "aborted"] as const;

const SNAPSHOT_KEYS = [
	"version", "parentSessionId", "anchor", "generation", "runId", "revision", "phase",
	"requestedTasks", "admittedTasks", "launchedChildren", "activeChildren", "settledTasks",
	"aggregateAssistantTurns", "elapsedMs", "tasks",
] as const;
const TASK_KEYS = [
	"id", "ordinal", "role", "episode", "status", "executionPhase", "route",
	"assistantTurns", "elapsedMs", "replayed", "headline", "activeTools",
] as const;
const ROUTE_KEYS = ["provider", "model", "thinking"] as const;
const ROLE_SET = new Set<string>(ROLE_NAMES);
const PHASE_SET = new Set<string>(OBSERVER_PHASES);
const EXECUTION_SET = new Set<string>(TASK_EXECUTION_PHASES);
const STATUS_SET = new Set<string>(TASK_STATUSES);
const THINKING_SET = new Set<string>(THINKING_LEVELS);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const SENSITIVE_KEY = /prompt|objective|output|stderr|path|model|selector|credential|token|env/i;
const MAX_ROUTE_BYTES = 512;
const HEADLINE_ELLIPSIS = "…";

export type ObserverSnapshotVersion = typeof OBSERVER_VERSION;
export type ObserverPhase = (typeof OBSERVER_PHASES)[number];
export type ObserverParse<T> = { ok: true; value: T } | { ok: false };

export interface ObserverTask {
	id: string;
	ordinal: number;
	role: RoleName;
	episode: number | null;
	status: TaskStatus;
	executionPhase: TaskExecutionPhase;
	route: { provider: string; model: string; thinking: ThinkingLevel } | null;
	assistantTurns: number;
	elapsedMs: number | null;
	replayed: boolean;
	headline: string;
	activeTools: string[];
}

export interface ObserverSnapshot {
	version: ObserverSnapshotVersion;
	parentSessionId: string;
	anchor: string | null;
	generation: string;
	/** Null for an aggregate current scope, which is not a single execution run. */
	runId: string | null;
	revision: number;
	phase: ObserverPhase;
	requestedTasks: number;
	admittedTasks: number;
	launchedChildren: number;
	activeChildren: number;
	settledTasks: number;
	aggregateAssistantTurns: number;
	elapsedMs: number | null;
	tasks: ObserverTask[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysExact(record: Record<string, unknown>, required: readonly string[], allowSensitive = false): boolean {
	const allowed = new Set(required);
	const keys = Object.keys(record);
	if (keys.some((key) => !allowed.has(key) || (!allowSensitive && SENSITIVE_KEY.test(key)))) return false;
	return required.every((key) => key in record);
}

function nonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegativeOrNull(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function opaqueId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_ID.test(value) && !TERMINAL_CONTROL.test(value)
		&& Buffer.byteLength(value, "utf8") <= 128;
}

function routeString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !TERMINAL_CONTROL.test(value)
		&& Buffer.byteLength(value, "utf8") <= MAX_ROUTE_BYTES;
}

export function parseObserverRoute(value: unknown): ObserverTask["route"] | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !keysExact(value, ROUTE_KEYS, true)) return undefined;
	if (!routeString(value.provider) || !routeString(value.model) || !THINKING_SET.has(value.thinking as string)) {
		return undefined;
	}
	return {
		provider: value.provider,
		model: value.model,
		thinking: value.thinking as ThinkingLevel,
	};
}

function parseHeadline(value: unknown): string | undefined {
	if (typeof value !== "string" || TERMINAL_CONTROL.test(value) || Buffer.byteLength(value, "utf8") > MAX_HEADLINE_BYTES) {
		return undefined;
	}
	return value;
}

function parseActiveTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ACTIVE_TOOLS) return undefined;
	const tools: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (
			typeof item !== "string"
			|| !TOOL_NAME.test(item)
			|| TERMINAL_CONTROL.test(item)
			|| Buffer.byteLength(item, "utf8") > MAX_TOOL_NAME_BYTES
			|| seen.has(item)
		) {
			return undefined;
		}
		seen.add(item);
		tools.push(item);
	}
	return tools;
}

/** Control and invisible separators that must become visible spaces in headlines. */
const HEADLINE_SEPARATOR = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u00AD]+/g;

export function observerHeadline(objective: string): string {
	const collapsed = objective.replace(HEADLINE_SEPARATOR, " ").replace(/\s+/g, " ").trim();
	if (!collapsed) return "";
	if (Buffer.byteLength(collapsed, "utf8") <= MAX_HEADLINE_BYTES) return collapsed;
	const budget = MAX_HEADLINE_BYTES - Buffer.byteLength(HEADLINE_ELLIPSIS, "utf8");
	let acc = "";
	for (const char of collapsed) {
		const next = acc + char;
		if (Buffer.byteLength(next, "utf8") > budget) break;
		acc = next;
	}
	return `${acc.trimEnd()}${HEADLINE_ELLIPSIS}`;
}

export function observerTools(tools: readonly string[] | undefined): string[] {
	if (!tools) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		if (
			out.length >= MAX_ACTIVE_TOOLS
			|| !TOOL_NAME.test(tool)
			|| TERMINAL_CONTROL.test(tool)
			|| Buffer.byteLength(tool, "utf8") > MAX_TOOL_NAME_BYTES
			|| seen.has(tool)
		) {
			continue;
		}
		seen.add(tool);
		out.push(tool);
	}
	return out;
}

function productId(value: unknown): value is string { return typeof value === "string" && isProductId(value); }

function parseTask(value: unknown): ObserverTask | undefined {
	if (!isRecord(value) || !keysExact(value, TASK_KEYS)) return undefined;
	if (!productId(value.id) || !nonNegativeInt(value.ordinal) || value.ordinal < 1 || value.ordinal > HARD_LIMITS.maxTasks) {
		return undefined;
	}
	if (!ROLE_SET.has(value.role as string) || !STATUS_SET.has(value.status as string) || !EXECUTION_SET.has(value.executionPhase as string)) {
		return undefined;
	}
	if ((value.episode !== null && !nonNegativeInt(value.episode)) || !nonNegativeInt(value.assistantTurns) || !finiteNonNegativeOrNull(value.elapsedMs)) {
		return undefined;
	}
	if (typeof value.replayed !== "boolean") return undefined;
	const route = parseObserverRoute(value.route);
	if (route === undefined) return undefined;
	const headline = parseHeadline(value.headline);
	const activeTools = parseActiveTools(value.activeTools);
	if (headline === undefined || activeTools === undefined) return undefined;
	return {
		id: value.id,
		ordinal: value.ordinal,
		role: value.role as RoleName,
		episode: value.episode as number | null,
		status: value.status as TaskStatus,
		executionPhase: value.executionPhase as TaskExecutionPhase,
		route,
		assistantTurns: value.assistantTurns,
		elapsedMs: value.elapsedMs,
		replayed: value.replayed,
		headline,
		activeTools,
	};
}

function snapshotVersion(value: unknown): ObserverSnapshotVersion | undefined {
	if (value === OBSERVER_VERSION) return value;
	return undefined;
}

/** Strict consumer-side validation of one current-version observer task row. */
export function parseObserverTask(value: unknown): ObserverTask | undefined {
	return parseTask(value);
}

export function parseObserverSnapshot(value: unknown): ObserverParse<ObserverSnapshot> {
	if (!isRecord(value) || !keysExact(value, SNAPSHOT_KEYS)) return { ok: false };
	const version = snapshotVersion(value.version);
	if (version === undefined) return { ok: false };
	if (!opaqueId(value.parentSessionId) || (value.anchor !== null && !opaqueId(value.anchor))) return { ok: false };
	if (!productId(value.generation) || (value.runId !== null && !productId(value.runId)) || !nonNegativeInt(value.revision) || !PHASE_SET.has(value.phase as string)) {
		return { ok: false };
	}
	const requestedTasks = value.requestedTasks;
	const admittedTasks = value.admittedTasks;
	const launchedChildren = value.launchedChildren;
	const activeChildren = value.activeChildren;
	const settledTasks = value.settledTasks;
	const aggregateAssistantTurns = value.aggregateAssistantTurns;
	const elapsedMs = value.elapsedMs;
	if (
		!nonNegativeInt(requestedTasks) || !nonNegativeInt(admittedTasks) || !nonNegativeInt(launchedChildren)
		|| !nonNegativeInt(activeChildren) || !nonNegativeInt(settledTasks) || !nonNegativeInt(aggregateAssistantTurns)
		|| !finiteNonNegativeOrNull(elapsedMs) || !Array.isArray(value.tasks)
	) {
		return { ok: false };
	}
	if (
		requestedTasks > HARD_LIMITS.maxTasks
		|| admittedTasks > requestedTasks
		|| launchedChildren > admittedTasks
		|| activeChildren > launchedChildren
		|| settledTasks > admittedTasks
		|| value.tasks.length > HARD_LIMITS.maxTasks
		|| value.tasks.length > admittedTasks
	) {
		return { ok: false };
	}
	const tasks: ObserverTask[] = [];
	const ids = new Set<string>();
	const ordinals = new Set<number>();
	for (const entry of value.tasks) {
		const task = parseTask(entry);
		if (!task || ids.has(task.id) || ordinals.has(task.ordinal)) return { ok: false };
		ids.add(task.id);
		ordinals.add(task.ordinal);
		tasks.push(task);
	}
	return {
		ok: true,
		value: {
			version,
			parentSessionId: value.parentSessionId,
			anchor: value.anchor as string | null,
			generation: value.generation,
			runId: value.runId,
			revision: value.revision,
			phase: value.phase as ObserverPhase,
			requestedTasks,
			admittedTasks,
			launchedChildren,
			activeChildren,
			settledTasks,
			aggregateAssistantTurns,
			elapsedMs,
			tasks,
		},
	};
}
