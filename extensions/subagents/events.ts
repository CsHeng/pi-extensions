import {
	HARD_LIMITS,
	ROLE_NAMES,
	TASK_EXECUTION_PHASES,
	type RoleName,
	type TaskExecutionPhase,
	type TaskStatus,
} from "./contracts.ts";

export const SNAPSHOT_EVENT = "csheng.subagents.snapshot.v1";
export const CANCEL_REQUEST_EVENT = "csheng.subagents.cancel.request.v1";
export const CANCEL_RECEIPT_EVENT = "csheng.subagents.cancel.receipt.v1";
export const EVENT_PROTOCOL_VERSION = 1 as const;
export const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FIXED_CHILD_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;
export const RUN_UI_PHASES = ["accepted", "running", "settling", "settled"] as const;
export const CANCEL_TARGETS = ["run", "task"] as const;
export const CANCEL_RECEIPT_OUTCOMES = [
	"accepted",
	"not-active",
	"unknown-task",
	"already-settled",
	"too-late",
] as const;
export const TASK_STATUSES = ["pending", "running", "succeeded", "failed", "blocked", "aborted"] as const;

export type FixedChildTool = (typeof FIXED_CHILD_TOOLS)[number];
export type RunUiPhase = (typeof RUN_UI_PHASES)[number];
export type CancelTarget = (typeof CANCEL_TARGETS)[number];
export type CancelReceiptOutcome = (typeof CANCEL_RECEIPT_OUTCOMES)[number];

export interface SnapshotTaskV1 {
	id: string;
	ordinal: number;
	role: RoleName;
	status: TaskStatus;
	executionPhase: TaskExecutionPhase;
	assistantTurns: number;
	elapsedMs: number;
	inactiveForMs: number;
	activeTools: FixedChildTool[];
	errorCount: number;
	cancellationRequested: boolean;
}

export interface SnapshotV1 {
	version: typeof EVENT_PROTOCOL_VERSION;
	runId: string;
	phase: RunUiPhase;
	requestedTasks: number;
	admittedTasks: number;
	launchedChildren: number;
	activeChildren: number;
	settledTasks: number;
	aggregateAssistantTurns: number;
	elapsedMs: number;
	peakConcurrency: number;
	cancellationRequested: boolean;
	tasks: SnapshotTaskV1[];
}

export interface CancelRequestV1 {
	version: typeof EVENT_PROTOCOL_VERSION;
	requestId: string;
	runId: string;
	target: CancelTarget;
	taskId?: string;
}

export interface CancelReceiptV1 {
	version: typeof EVENT_PROTOCOL_VERSION;
	requestId: string;
	runId: string;
	target: CancelTarget;
	outcome: CancelReceiptOutcome;
	taskId?: string;
}

export type EventParse<T> = { ok: true; value: T } | { ok: false };

const SNAPSHOT_KEYS = [
	"version", "runId", "phase", "requestedTasks", "admittedTasks", "launchedChildren",
	"activeChildren", "settledTasks", "aggregateAssistantTurns", "elapsedMs", "peakConcurrency",
	"cancellationRequested", "tasks",
] as const;
const TASK_KEYS = [
	"id", "ordinal", "role", "status", "executionPhase", "assistantTurns", "elapsedMs",
	"inactiveForMs", "activeTools", "errorCount", "cancellationRequested",
] as const;
const REQUEST_KEYS = ["version", "requestId", "runId", "target", "taskId"] as const;
const RECEIPT_KEYS = ["version", "requestId", "runId", "target", "outcome", "taskId"] as const;
const ROLE_SET = new Set<string>(ROLE_NAMES);
const PHASE_SET = new Set<string>(RUN_UI_PHASES);
const EXECUTION_SET = new Set<string>(TASK_EXECUTION_PHASES);
const STATUS_SET = new Set<string>(TASK_STATUSES);
const TOOL_SET = new Set<string>(FIXED_CHILD_TOOLS);
const TARGET_SET = new Set<string>(CANCEL_TARGETS);
const OUTCOME_SET = new Set<string>(CANCEL_RECEIPT_OUTCOMES);
const SENSITIVE_KEY = /prompt|objective|output|stderr|path|model|selector|credential|token|env/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysExact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(record);
	if (keys.some((key) => !allowed.has(key) || SENSITIVE_KEY.test(key))) return false;
	return required.every((key) => key in record);
}

function nonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_EVENT_ID.test(value);
}

function parseTask(value: unknown): SnapshotTaskV1 | undefined {
	if (!isRecord(value) || !keysExact(value, TASK_KEYS)) return undefined;
	if (!safeId(value.id) || !nonNegativeInt(value.ordinal) || value.ordinal < 1 || value.ordinal > HARD_LIMITS.maxTasks) {
		return undefined;
	}
	if (!ROLE_SET.has(value.role as string) || !STATUS_SET.has(value.status as string) || !EXECUTION_SET.has(value.executionPhase as string)) {
		return undefined;
	}
	if (!nonNegativeInt(value.assistantTurns) || !finiteNonNegative(value.elapsedMs) || !finiteNonNegative(value.inactiveForMs) || !nonNegativeInt(value.errorCount)) {
		return undefined;
	}
	if (typeof value.cancellationRequested !== "boolean" || !Array.isArray(value.activeTools)) return undefined;
	if (value.activeTools.length > FIXED_CHILD_TOOLS.length) return undefined;
	const tools: FixedChildTool[] = [];
	const seen = new Set<string>();
	for (const tool of value.activeTools) {
		if (typeof tool !== "string" || !TOOL_SET.has(tool) || seen.has(tool)) return undefined;
		seen.add(tool);
		tools.push(tool as FixedChildTool);
	}
	return {
		id: value.id,
		ordinal: value.ordinal,
		role: value.role as RoleName,
		status: value.status as TaskStatus,
		executionPhase: value.executionPhase as TaskExecutionPhase,
		assistantTurns: value.assistantTurns,
		elapsedMs: value.elapsedMs,
		inactiveForMs: value.inactiveForMs,
		activeTools: tools,
		errorCount: value.errorCount,
		cancellationRequested: value.cancellationRequested,
	};
}

export function parseSnapshot(value: unknown): EventParse<SnapshotV1> {
	if (!isRecord(value) || !keysExact(value, SNAPSHOT_KEYS) || value.version !== EVENT_PROTOCOL_VERSION) return { ok: false };
	if (!safeId(value.runId) || !PHASE_SET.has(value.phase as string) || typeof value.cancellationRequested !== "boolean") {
		return { ok: false };
	}
	const requestedTasks = value.requestedTasks;
	const admittedTasks = value.admittedTasks;
	const launchedChildren = value.launchedChildren;
	const activeChildren = value.activeChildren;
	const settledTasks = value.settledTasks;
	const aggregateAssistantTurns = value.aggregateAssistantTurns;
	const peakConcurrency = value.peakConcurrency;
	const elapsedMs = value.elapsedMs;
	if (
		!nonNegativeInt(requestedTasks) || !nonNegativeInt(admittedTasks) || !nonNegativeInt(launchedChildren)
		|| !nonNegativeInt(activeChildren) || !nonNegativeInt(settledTasks) || !nonNegativeInt(aggregateAssistantTurns)
		|| !nonNegativeInt(peakConcurrency) || !finiteNonNegative(elapsedMs) || !Array.isArray(value.tasks)
	) {
		return { ok: false };
	}
	if (
		requestedTasks > HARD_LIMITS.maxTasks
		|| admittedTasks > requestedTasks
		|| launchedChildren > admittedTasks
		|| activeChildren > launchedChildren
		|| settledTasks > admittedTasks
		|| peakConcurrency > admittedTasks
		|| value.tasks.length > HARD_LIMITS.maxTasks
		|| value.tasks.length > admittedTasks
	) {
		return { ok: false };
	}
	const tasks: SnapshotTaskV1[] = [];
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
			version: EVENT_PROTOCOL_VERSION,
			runId: value.runId,
			phase: value.phase as RunUiPhase,
			requestedTasks,
			admittedTasks,
			launchedChildren,
			activeChildren,
			settledTasks,
			aggregateAssistantTurns,
			elapsedMs,
			peakConcurrency,
			cancellationRequested: value.cancellationRequested,
			tasks,
		},
	};
}

function parseControlBase(value: unknown): {
	version: typeof EVENT_PROTOCOL_VERSION;
	requestId: string;
	runId: string;
	target: CancelTarget;
	taskId?: string;
} | undefined {
	if (!isRecord(value) || value.version !== EVENT_PROTOCOL_VERSION) return undefined;
	if (!safeId(value.requestId) || !safeId(value.runId) || !TARGET_SET.has(value.target as string)) return undefined;
	const taskId = value.taskId;
	if (value.target === "task") {
		if (!safeId(taskId)) return undefined;
		return {
			version: EVENT_PROTOCOL_VERSION,
			requestId: value.requestId,
			runId: value.runId,
			target: "task",
			taskId,
		};
	}
	if (taskId !== undefined) return undefined;
	return {
		version: EVENT_PROTOCOL_VERSION,
		requestId: value.requestId,
		runId: value.runId,
		target: "run",
	};
}

export function parseCancelRequest(value: unknown): EventParse<CancelRequestV1> {
	if (!isRecord(value) || !keysExact(value, ["version", "requestId", "runId", "target"], ["taskId"])) return { ok: false };
	const parsed = parseControlBase(value);
	if (!parsed) return { ok: false };
	if (parsed.target === "run" && parsed.taskId !== undefined) return { ok: false };
	return { ok: true, value: parsed };
}

export function parseCancelReceipt(value: unknown): EventParse<CancelReceiptV1> {
	if (!isRecord(value) || !keysExact(value, ["version", "requestId", "runId", "target", "outcome"], ["taskId"])) {
		return { ok: false };
	}
	if (!OUTCOME_SET.has(value.outcome as string)) return { ok: false };
	const parsed = parseControlBase(value);
	if (!parsed) return { ok: false };
	if (parsed.target === "run" && parsed.taskId !== undefined) return { ok: false };
	return {
		ok: true,
		value: { ...parsed, outcome: value.outcome as CancelReceiptOutcome },
	};
}
