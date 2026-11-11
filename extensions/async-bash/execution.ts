import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { scheduleDelay, requireDurationMs, timestampAfter, type CancellableDelay } from "../shared/duration-timer.ts";
import { OUTPUT_MAX_BYTES, BASH_OWNER } from "./policy.ts";

/** `timeout` is the opt-in hard lifetime; reaching the checkpoint deadline never ends an execution. */
export type BashStatus = "running" | "exited" | "cancelled" | "timeout" | "interrupted";
export type BashPhase = "started" | "renewed" | "checkpoint" | "exited" | "cancelled" | "timeout" | "interrupted" | "unavailable";
export type BashNotice = "idle-wake-or-next-request" | "wake-unavailable" | "not-a-completion";

export interface BashScope {
	sessionId: string | null;
	branchAnchor: string | null;
	/** Entry ids on the current branch. A stored anchor remains in scope while it is still on this branch. */
	branchIds?: readonly string[];
}

export interface BashExecutionView {
	executionId: string;
	owner: typeof BASH_OWNER;
	status: BashStatus;
	startedAt: number;
	/** Checkpoint: when the model is asked whether to renew or cancel. The process keeps running. */
	deadlineAt: number;
	/** Opt-in hard lifetime; null when the model did not request a kill time. */
	timeoutAt: number | null;
	/** True after the checkpoint passed while running, until renew. */
	overdue: boolean;
	/** Increments at each reached checkpoint; identifies its notice. */
	checkpoint: number;
	exitCode: number | null;
	output: string;
	truncated: boolean;
	toolCallId: string | null;
	sessionId: string | null;
	branchAnchor: string | null;
	/** Executable basename retained for telemetry; preview is human UI only. */
	label: string;
	commandPreview: string;
	/** True only after start returned a still-running execution. */
	background: boolean;
	/** Actual close time. Null while running. */
	terminalAt: number | null;
	/** Last stdout/stderr time. Null when the process has produced no output. */
	lastOutputAt: number | null;
}

export interface BashExecutionEvent {
	version: 1;
	executionId: string;
	owner: typeof BASH_OWNER;
	sessionId: string | null;
	branchAnchor: string | null;
	toolCallId: string | null;
	phase: BashPhase;
	status: BashStatus | "unavailable";
	exitCode: number | null;
	deadlineAt: string | null;
	timeoutAt: string | null;
	overdue: boolean;
	checkpoint: number;
	truncated: boolean;
	outputTail: string;
	notice: BashNotice;
	label: string;
	terminalAt: string | null;
	lastOutputAt: string | null;
}

export interface StartBashInput {
	command: string;
	/** Configured command prefix, applied once before the command. The label and preview use the command alone. */
	commandPrefix?: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionId: string | null;
	branchAnchor: string | null;
	toolCallId: string | null;
	/** Checkpoint delay. */
	deadlineMs: number;
	/** Opt-in hard lifetime. */
	timeoutMs?: number;
	foregroundWindowMs: number;
	signal?: AbortSignal;
	/** Releases the foreground window early; the execution continues. */
	yieldSignal?: AbortSignal;
}

interface ExecutionRecord {
	executionId: string;
	sessionId: string | null;
	branchAnchor: string | null;
	toolCallId: string | null;
	status: BashStatus;
	startedAt: number;
	deadlineAt: number;
	timeoutAt: number | null;
	overdue: boolean;
	checkpoint: number;
	exitCode: number | null;
	output: BoundedOutput;
	/** Execution-scoped cancellation. Native abort tears down the process tree. */
	abort: AbortController;
	deadlineTimer: CancellableDelay | undefined;
	timeoutTimer: CancellableDelay | undefined;
	waiters: Array<() => void>;
	/** Observation windows that end when the checkpoint is reached. */
	checkpointWaiters: Array<() => void>;
	settled: boolean;
	terminalCause: Exclude<BashStatus, "running" | "exited"> | undefined;
	closed: Promise<void>;
	resolveClosed: () => void;
	label: string;
	commandPreview: string;
	background: boolean;
	terminalAt: number | null;
	lastOutputAt: number | null;
}

export interface BashExecutionOwner {
	readonly startCount: number;
	start(input: StartBashInput): Promise<BashExecutionView>;
	inspect(executionId: string, scope: BashScope): BashExecutionView | undefined;
	/** Read-only in-scope snapshot. It does not start, wait, renew, cancel, or trim. */
	list(scope: BashScope): BashExecutionView[];
	/** Display-fact invalidation only. The listener receives no output and cannot affect execution. */
	subscribeDisplay(listener: () => void): () => void;
	/** Ends at terminal, checkpoint, waitMs, abort or yield. Only terminal changes the execution. */
	wait(executionId: string, scope: BashScope, options: { signal?: AbortSignal; yieldSignal?: AbortSignal; waitMs: number }): Promise<BashExecutionView>;
	renew(executionId: string, scope: BashScope, deadlineMs: number): BashExecutionView;
	cancel(executionId: string, scope: BashScope): Promise<BashExecutionView>;
	/** Interrupt running executions that belong to a different session or branch. Same-scope idle is not a switch. */
	interruptOthers(scope: BashScope): Promise<void>;
	shutdown(): Promise<void>;
}

const ABORTED_BEFORE_START = "Job start aborted before execution";
const OUTSIDE_SCOPE = "Bash job is outside the current session branch";
const LABEL_LIMIT = 24;

/** Conservative executable basename, or Bash. Arguments, assignments, and shell syntax are not labels. */
export function commandLabel(command: string): string {
	const trimmed = command.trim();
	if (!trimmed || /[\n\r;&|<>`$(){}='"]/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return "Bash";
	const token = trimmed.split(/\s+/)[0] ?? "";
	if (!token || token.startsWith("-") || token.includes("=")) return "Bash";
	const base = token.split(/[/\\]/).filter(Boolean).pop() ?? "";
	if (!/^[A-Za-z0-9._+-]+$/.test(base) || base === "." || base === "..") return "Bash";
	return base.length > LABEL_LIMIT ? base.slice(0, LABEL_LIMIT) : base;
}

/** Bounded first command line for the session-local human view, never telemetry or output. */
export function commandPreview(command: string): string {
	const first = stripTerminalSequences(command.trimStart().split(/\r?\n/, 1)[0] ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
	// Keep command structure, not assignment values or common credential-bearing options.
	const safe = first.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;]+)/gu, "$1=…")
		.replace(/((?:--(?:token|password|secret|api-key|authorization|header|user)|-[Hu])(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/giu, "$1…");
	return safe.slice(0, 512) || "Bash";
}

function isoTime(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

/**
 * Async Bash job execution over Pi's exported local bash operations.
 *
 * Pi owns shell discovery, spawn, output streaming, process-tree teardown and
 * shutdown tracking. This owner retains the execution promise, a renewable
 * wrapper deadline, observation waits and the published terminal facts.
 */
export function createBashExecutionOwner(options: {
	operations: BashOperations | (() => BashOperations);
	onEvent?: (event: BashExecutionEvent) => void;
	maxOutputBytes?: number;
	now?: () => number;
}): BashExecutionOwner {
	const records = new Map<string, ExecutionRecord>();
	const displayListeners = new Set<() => void>();
	const maxOutputBytes = options.maxOutputBytes ?? OUTPUT_MAX_BYTES;
	const now = options.now ?? Date.now;
	let startCount = 0;
	const notifyDisplay = (): void => {
		for (const listener of displayListeners) {
			try { listener(); } catch { /* A display observer cannot change execution. */ }
		}
	};

	const emit = (record: ExecutionRecord, phase: BashPhase): void => {
		try {
			options.onEvent?.({
				version: 1,
				executionId: record.executionId,
				owner: BASH_OWNER,
				sessionId: record.sessionId,
				branchAnchor: record.branchAnchor,
				toolCallId: record.toolCallId,
				phase,
				status: record.status,
				exitCode: record.exitCode,
				deadlineAt: new Date(record.deadlineAt).toISOString(),
				timeoutAt: isoTime(record.timeoutAt),
				overdue: record.overdue,
				checkpoint: record.checkpoint,
				truncated: record.output.truncated,
				outputTail: record.output.text(),
				notice: phase === "started" || phase === "renewed" ? "not-a-completion" : "idle-wake-or-next-request",
				label: record.label,
				terminalAt: isoTime(record.terminalAt),
				lastOutputAt: isoTime(record.lastOutputAt),
			});
		} catch { /* An observer failure must not strand or fail the execution. */ }
	};

	const viewOf = (record: ExecutionRecord): BashExecutionView => ({
		executionId: record.executionId,
		owner: BASH_OWNER,
		status: record.status,
		startedAt: record.startedAt,
		deadlineAt: record.deadlineAt,
		timeoutAt: record.timeoutAt,
		overdue: record.overdue,
		checkpoint: record.checkpoint,
		exitCode: record.exitCode,
		output: record.output.text(),
		truncated: record.output.truncated,
		toolCallId: record.toolCallId,
		sessionId: record.sessionId,
		branchAnchor: record.branchAnchor,
		label: record.label,
		commandPreview: record.commandPreview,
		background: record.background,
		terminalAt: record.terminalAt,
		lastOutputAt: record.lastOutputAt,
	});

	const sameScope = (record: ExecutionRecord, scope: BashScope): boolean => inBashScope(record, scope);

	const requireRecord = (executionId: string, scope: BashScope): ExecutionRecord => {
		const record = records.get(executionId);
		if (!record || !sameScope(record, scope)) throw new Error(record ? OUTSIDE_SCOPE : `Unknown job: ${executionId}`);
		return record;
	};

	const noteOutput = (record: ExecutionRecord, chunk: Buffer): void => {
		if (chunk.length === 0 || record.settled) return;
		record.output.append(chunk);
		record.lastOutputAt = now();
		notifyDisplay();
	};

	const finish = (record: ExecutionRecord, status: Exclude<BashStatus, "running">, exitCode: number | null): void => {
		if (record.settled) return;
		record.settled = true;
		record.status = status;
		record.exitCode = exitCode;
		record.terminalAt = now();
		record.deadlineTimer?.cancel();
		record.deadlineTimer = undefined;
		record.timeoutTimer?.cancel();
		record.timeoutTimer = undefined;
		record.overdue = false;
		record.checkpointWaiters = [];
		const waiters = record.waiters;
		record.waiters = [];
		for (const waiter of waiters) waiter();
		emit(record, status);
		notifyDisplay();
		record.resolveClosed();
	};

	/** Execution-scoped cancellation. The native abort handler owns process-tree teardown. */
	const stop = (record: ExecutionRecord): void => { record.abort.abort(); };

	/** The checkpoint asks the model to decide; the process keeps running and no later checkpoint arms without renew. */
	const armDeadline = (record: ExecutionRecord): void => {
		record.deadlineTimer?.cancel();
		const delay = Math.max(0, record.deadlineAt - now());
		record.deadlineTimer = scheduleDelay(delay, () => {
			record.deadlineTimer = undefined;
			if (record.settled) return;
			record.overdue = true;
			record.checkpoint += 1;
			const waiters = record.checkpointWaiters;
			record.checkpointWaiters = [];
			for (const waiter of waiters) waiter();
			emit(record, "checkpoint");
			notifyDisplay();
		});
	};

	/** Only an explicit timeout ends the process at a fixed time. */
	const armTimeout = (record: ExecutionRecord): void => {
		record.timeoutTimer?.cancel();
		if (record.timeoutAt === null) { record.timeoutTimer = undefined; return; }
		record.timeoutTimer = scheduleDelay(Math.max(0, record.timeoutAt - now()), () => {
			if (record.settled) return;
			record.terminalCause = "timeout";
			stop(record);
		});
	};

	const operationsOf = (): BashOperations => (typeof options.operations === "function" ? options.operations() : options.operations);

	return {
		get startCount() { return startCount; },
		async start(input) {
			if (input.signal?.aborted) throw new Error(ABORTED_BEFORE_START);
			if (input.command.trim().length === 0) throw new Error("Shell command is empty");
			const deadlineMs = requireDurationMs(input.deadlineMs);
			const timeoutMs = input.timeoutMs === undefined ? undefined : requireDurationMs(input.timeoutMs);
			if (!Number.isFinite(input.foregroundWindowMs) || input.foregroundWindowMs < 0) throw new Error("Invalid foreground window");
			if (input.foregroundWindowMs > 0) requireDurationMs(input.foregroundWindowMs);
			try {
				await access(input.cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${input.cwd}`);
			}
			if (input.signal?.aborted) throw new Error(ABORTED_BEFORE_START);
			const startedAt = now();
			const deadlineAt = timestampAfter(startedAt, deadlineMs);
			const timeoutAt = timeoutMs === undefined ? null : timestampAfter(startedAt, timeoutMs);
			let resolveClosed: () => void = () => {};
			const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
			const record: ExecutionRecord = {
				executionId: `exec_${randomBytes(8).toString("hex")}`,
				sessionId: input.sessionId,
				branchAnchor: input.branchAnchor,
				toolCallId: input.toolCallId,
				status: "running",
				startedAt,
				deadlineAt,
				timeoutAt,
				overdue: false,
				checkpoint: 0,
				exitCode: null,
				output: new BoundedOutput(maxOutputBytes),
				abort: new AbortController(),
				deadlineTimer: undefined,
				timeoutTimer: undefined,
				waiters: [],
				checkpointWaiters: [],
				settled: false,
				terminalCause: undefined,
				closed,
				resolveClosed,
				label: commandLabel(input.command),
				commandPreview: commandPreview(input.command),
				background: false,
				terminalAt: null,
				lastOutputAt: null,
			};
			const command = input.commandPrefix ? `${input.commandPrefix}\n${input.command}` : input.command;
			// One native invocation per start. A synchronous refusal propagates before the record is kept.
			const execution = operationsOf().exec(command, input.cwd, {
				onData: (chunk: Buffer) => { noteOutput(record, chunk); },
				signal: record.abort.signal,
				env: input.env,
			});
			startCount += 1;
			records.set(record.executionId, record);
			execution.then(
				(result) => { finish(record, record.terminalCause ?? "exited", record.terminalCause ? null : result.exitCode); },
				(error: unknown) => {
					if (record.terminalCause === undefined) noteOutput(record, Buffer.from(error instanceof Error ? error.message : String(error)));
					finish(record, record.terminalCause ?? "interrupted", null);
				},
			);
			armDeadline(record);
			armTimeout(record);
			emit(record, "started");
			notifyDisplay();
			if (input.signal?.aborted && !record.settled) {
				record.terminalCause = "cancelled";
				stop(record);
				await record.closed;
				return viewOf(record);
			}
			const release = () => {
				if (record.status === "running") { record.background = true; notifyDisplay(); }
				return viewOf(record);
			};
			if (input.foregroundWindowMs <= 0) return release();
			const outcome = await raceWindow(record, input.foregroundWindowMs, input.signal, input.yieldSignal);
			if (outcome === "abort" && !record.settled) {
				record.terminalCause = "cancelled";
				stop(record);
				await record.closed;
			}
			return release();
		},
		inspect(executionId, scope) {
			const record = records.get(executionId);
			if (!record || !sameScope(record, scope)) return undefined;
			return viewOf(record);
		},
		list(scope) {
			return [...records.values()]
				.filter((record) => sameScope(record, scope))
				.sort((left, right) => left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId))
				.map(viewOf);
		},
		subscribeDisplay(listener) {
			displayListeners.add(listener);
			return () => { displayListeners.delete(listener); };
		},
		wait(executionId, scope, waitOptions) {
			const record = requireRecord(executionId, scope);
			if (record.status !== "running") return Promise.resolve(viewOf(record));
			const waitMs = requireDurationMs(waitOptions.waitMs);
			return new Promise((resolve) => {
				let timer: CancellableDelay | undefined;
				let finished = false;
				const done = () => {
					if (finished) return;
					finished = true;
					timer?.cancel();
					waitOptions.signal?.removeEventListener("abort", onAbort);
					waitOptions.yieldSignal?.removeEventListener("abort", onAbort);
					record.waiters = record.waiters.filter((waiter) => waiter !== onTerminal);
					record.checkpointWaiters = record.checkpointWaiters.filter((waiter) => waiter !== onTerminal);
					resolve(viewOf(record));
				};
				const onTerminal = () => done();
				const onAbort = () => done();
				record.waiters.push(onTerminal);
				// A reached checkpoint is for the model to judge; the wait returns it instead of sitting on it.
				if (!record.overdue) record.checkpointWaiters.push(onTerminal);
				timer = scheduleDelay(waitMs, done);
				if (record.status !== "running" || waitOptions.signal?.aborted || waitOptions.yieldSignal?.aborted) {
					onAbort();
					return;
				}
				waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
				waitOptions.yieldSignal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		renew(executionId, scope, deadlineMs) {
			const record = requireRecord(executionId, scope);
			if (record.status !== "running") throw new Error(`Cannot renew job ${executionId}; status is ${record.status}`);
			const duration = requireDurationMs(deadlineMs);
			record.deadlineAt = timestampAfter(now(), duration);
			record.overdue = false;
			armDeadline(record);
			emit(record, "renewed");
			return viewOf(record);
		},
		async cancel(executionId, scope) {
			const record = requireRecord(executionId, scope);
			if (record.status !== "running") return viewOf(record);
			record.terminalCause = "cancelled";
			stop(record);
			await record.closed;
			return viewOf(record);
		},
		async interruptOthers(scope) {
			const pending: Promise<void>[] = [];
			for (const record of records.values()) {
				if (record.status !== "running" || sameScope(record, scope)) continue;
				record.terminalCause = "interrupted";
				stop(record);
				pending.push(record.closed);
			}
			await Promise.all(pending);
		},
		async shutdown() {
			const pending: Promise<void>[] = [];
			for (const record of records.values()) {
				if (record.status !== "running") continue;
				record.terminalCause = "interrupted";
				stop(record);
				pending.push(record.closed);
			}
			await Promise.all(pending);
		},
	};
}

export function inBashScope(record: { sessionId: string | null; branchAnchor: string | null }, scope: BashScope): boolean {
	if (record.sessionId !== scope.sessionId) return false;
	if (!record.branchAnchor || !scope.branchAnchor || record.branchAnchor === scope.branchAnchor) return true;
	return scope.branchIds?.includes(record.branchAnchor) === true;
}

/** Foreground window. Tool abort cancels the execution; a yield or checkpoint only ends the window. */
function raceWindow(record: ExecutionRecord, windowMs: number, signal: AbortSignal | undefined, yieldSignal: AbortSignal | undefined): Promise<"terminal" | "window" | "abort"> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: CancellableDelay | undefined;
		const finish = (outcome: "terminal" | "window" | "abort") => {
			if (settled) return;
			settled = true;
			timer?.cancel();
			signal?.removeEventListener("abort", onAbort);
			yieldSignal?.removeEventListener("abort", onYield);
			record.waiters = record.waiters.filter((waiter) => waiter !== onTerminal);
			record.checkpointWaiters = record.checkpointWaiters.filter((waiter) => waiter !== onYield);
			resolve(outcome);
		};
		const onTerminal = () => finish("terminal");
		const onAbort = () => finish("abort");
		const onYield = () => finish("window");
		timer = scheduleDelay(windowMs, () => finish("window"));
		record.waiters.push(onTerminal);
		record.checkpointWaiters.push(onYield);
		if (record.settled) {
			onTerminal();
			return;
		}
		if (signal?.aborted) {
			onAbort();
			return;
		}
		if (yieldSignal?.aborted) {
			onYield();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		yieldSignal?.addEventListener("abort", onYield, { once: true });
	});
}

class BoundedOutput {
	private chunks: Buffer[] = [];
	private bytes = 0;
	truncated = false;

	constructor(private readonly maxBytes: number) {}

	append(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > this.maxBytes && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			if (!dropped) break;
			this.bytes -= dropped.length;
			this.truncated = true;
		}
		const only = this.chunks[0];
		if (only && this.bytes > this.maxBytes) {
			this.chunks[0] = only.subarray(only.length - this.maxBytes);
			this.bytes = this.maxBytes;
			this.truncated = true;
		}
	}

	text(): string {
		return sanitize(Buffer.concat(this.chunks).toString("utf8"));
	}
}

function sanitize(value: string): string {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFF9-\uFFFB]/g, "");
}
