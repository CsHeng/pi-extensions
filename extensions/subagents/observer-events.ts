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

export const OBSERVER_EVENT = "csheng.subagents.observer.v2";
export const OBSERVER_VERSION = 2 as const;
export const OBSERVER_PHASES = ["accepted", "running", "settling", "settled"] as const;
const TASK_STATUSES = ["pending", "running", "succeeded", "failed", "blocked", "aborted"] as const;

const SNAPSHOT_KEYS = [
	"version", "parentSessionId", "anchor", "generation", "runId", "revision", "phase",
	"requestedTasks", "admittedTasks", "launchedChildren", "activeChildren", "settledTasks",
	"aggregateAssistantTurns", "elapsedMs", "tasks",
] as const;
const TASK_KEYS = [
	"id", "ordinal", "role", "episode", "status", "executionPhase", "route",
	"assistantTurns", "elapsedMs", "replayed",
] as const;
const ROUTE_KEYS = ["provider", "model", "thinking"] as const;
const ROLE_SET = new Set<string>(ROLE_NAMES);
const PHASE_SET = new Set<string>(OBSERVER_PHASES);
const EXECUTION_SET = new Set<string>(TASK_EXECUTION_PHASES);
const STATUS_SET = new Set<string>(TASK_STATUSES);
const THINKING_SET = new Set<string>(THINKING_LEVELS);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const SENSITIVE_KEY = /prompt|objective|output|stderr|path|model|selector|credential|token|env/i;
const MAX_ROUTE_BYTES = 512;

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
}

export interface ObserverSnapshot {
	version: typeof OBSERVER_VERSION;
	parentSessionId: string;
	anchor: string | null;
	generation: string;
	runId: string;
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

function parseRoute(value: unknown): ObserverTask["route"] | undefined {
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

function parseTask(value: unknown): ObserverTask | undefined {
	if (!isRecord(value) || !keysExact(value, TASK_KEYS)) return undefined;
	if (!opaqueId(value.id) || !nonNegativeInt(value.ordinal) || value.ordinal < 1 || value.ordinal > HARD_LIMITS.maxTasks) {
		return undefined;
	}
	if (!ROLE_SET.has(value.role as string) || !STATUS_SET.has(value.status as string) || !EXECUTION_SET.has(value.executionPhase as string)) {
		return undefined;
	}
	if ((value.episode !== null && !nonNegativeInt(value.episode)) || !nonNegativeInt(value.assistantTurns) || !finiteNonNegativeOrNull(value.elapsedMs)) {
		return undefined;
	}
	if (typeof value.replayed !== "boolean") return undefined;
	const route = parseRoute(value.route);
	if (route === undefined) return undefined;
	return {
		id: value.id,
		ordinal: value.ordinal,
		role: value.role as RoleName,
		episode: value.episode,
		status: value.status as TaskStatus,
		executionPhase: value.executionPhase as TaskExecutionPhase,
		route,
		assistantTurns: value.assistantTurns,
		elapsedMs: value.elapsedMs,
		replayed: value.replayed,
	};
}

export function parseObserverSnapshot(value: unknown): ObserverParse<ObserverSnapshot> {
	if (!isRecord(value) || !keysExact(value, SNAPSHOT_KEYS) || value.version !== OBSERVER_VERSION) return { ok: false };
	if (!opaqueId(value.parentSessionId) || (value.anchor !== null && !opaqueId(value.anchor))) return { ok: false };
	if (!opaqueId(value.generation) || !opaqueId(value.runId) || !nonNegativeInt(value.revision) || !PHASE_SET.has(value.phase as string)) {
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
			version: OBSERVER_VERSION,
			parentSessionId: value.parentSessionId,
			anchor: value.anchor,
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
