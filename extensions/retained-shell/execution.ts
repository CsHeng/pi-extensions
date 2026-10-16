import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { scheduleDelay, requireDurationMs, timestampAfter, type CancellableDelay } from "../shared/duration-timer.ts";
import { OUTPUT_MAX_BYTES, SHELL_OWNER } from "./policy.ts";

export type ShellStatus = "running" | "exited" | "cancelled" | "deadline" | "interrupted";
export type ShellPhase = "started" | "renewed" | "exited" | "cancelled" | "deadline" | "interrupted" | "unavailable";
export type ShellNotification = "idle-wake-or-next-request" | "wake-unavailable" | "not-a-completion";

/** Oldest terminal records beyond this cap are dropped. Live processes are not. */
export const MAX_TERMINAL_RECORDS = 8;

export interface ShellSpawnSpec {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

export interface ShellScope {
	sessionId: string | null;
	branchAnchor: string | null;
	/** Entry ids on the current branch. A stored anchor remains in scope while it is still on this branch. */
	branchIds?: readonly string[];
}

export interface ShellExecutionView {
	executionId: string;
	owner: typeof SHELL_OWNER;
	status: ShellStatus;
	startedAt: number;
	deadlineAt: number;
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

export interface ShellExecutionEvent {
	version: 1;
	executionId: string;
	owner: typeof SHELL_OWNER;
	sessionId: string | null;
	branchAnchor: string | null;
	toolCallId: string | null;
	phase: ShellPhase;
	status: ShellStatus | "unavailable";
	exitCode: number | null;
	deadlineAt: string | null;
	truncated: boolean;
	outputTail: string;
	notification: ShellNotification;
	label: string;
	terminalAt: string | null;
	lastOutputAt: string | null;
}

export interface StartShellInput {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionId: string | null;
	branchAnchor: string | null;
	toolCallId: string | null;
	deadlineMs: number;
	foregroundWindowMs: number;
	signal?: AbortSignal;
}

interface LaunchedProcess {
	pid?: number;
	stdout: Readable | null;
	stderr: Readable | null;
	stdin: Writable | null;
	once(event: "close", listener: (code: number | null) => void): void;
	once(event: "error", listener: (error: Error) => void): void;
	removeAllListeners?(event?: string): void;
}

interface ExecutionRecord {
	executionId: string;
	sessionId: string | null;
	branchAnchor: string | null;
	toolCallId: string | null;
	status: ShellStatus;
	startedAt: number;
	deadlineAt: number;
	exitCode: number | null;
	output: BoundedOutput;
	child: LaunchedProcess | undefined;
	pid: number | undefined;
	deadlineTimer: CancellableDelay | undefined;
	waiters: Array<() => void>;
	settled: boolean;
	terminalCause: Exclude<ShellStatus, "running" | "exited"> | undefined;
	closed: Promise<number | null>;
	resolveClosed: (code: number | null) => void;
	label: string;
	commandPreview: string;
	background: boolean;
	terminalAt: number | null;
	lastOutputAt: number | null;
}

export interface ShellExecutionOwner {
	readonly startCount: number;
	start(input: StartShellInput): Promise<ShellExecutionView>;
	inspect(executionId: string, scope: ShellScope): ShellExecutionView | undefined;
	/** Read-only in-scope snapshot. It does not start, wait, renew, cancel, or trim. */
	list(scope: ShellScope): ShellExecutionView[];
	/** Display-fact invalidation only. The listener receives no output and cannot affect execution. */
	subscribeDisplay(listener: () => void): () => void;
	wait(executionId: string, scope: ShellScope, options: { signal?: AbortSignal; waitMs: number }): Promise<ShellExecutionView>;
	renew(executionId: string, scope: ShellScope, deadlineMs: number): ShellExecutionView;
	cancel(executionId: string, scope: ShellScope): Promise<ShellExecutionView>;
	/** Interrupt running executions that belong to a different session or branch. Same-scope idle is not a switch. */
	interruptOthers(scope: ShellScope): Promise<void>;
	shutdown(): Promise<void>;
}

const ABORTED_BEFORE_START = "Shell start aborted before execution";
const OUTSIDE_SCOPE = "Shell execution is outside the current session branch";
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

export function createShellExecutionOwner(options: {
	spawnSpec: () => ShellSpawnSpec;
	onEvent?: (event: ShellExecutionEvent) => void;
	maxOutputBytes?: number;
	maxTerminalRecords?: number;
	now?: () => number;
	launch?: (spec: ShellSpawnSpec, command: string, input: { cwd: string; env: NodeJS.ProcessEnv }) => LaunchedProcess;
	stop?: (pid: number) => void;
}): ShellExecutionOwner {
	const records = new Map<string, ExecutionRecord>();
	const displayListeners = new Set<() => void>();
	const maxOutputBytes = options.maxOutputBytes ?? OUTPUT_MAX_BYTES;
	const maxTerminalRecords = options.maxTerminalRecords ?? MAX_TERMINAL_RECORDS;
	const now = options.now ?? Date.now;
	let startCount = 0;
	const notifyDisplay = (): void => {
		for (const listener of displayListeners) {
			try { listener(); } catch { /* A display observer cannot change execution. */ }
		}
	};

	const emit = (record: ExecutionRecord, phase: ShellPhase): void => {
		try {
			options.onEvent?.({
				version: 1,
				executionId: record.executionId,
				owner: SHELL_OWNER,
				sessionId: record.sessionId,
				branchAnchor: record.branchAnchor,
				toolCallId: record.toolCallId,
				phase,
				status: record.status,
				exitCode: record.exitCode,
				deadlineAt: new Date(record.deadlineAt).toISOString(),
				truncated: record.output.truncated,
				outputTail: record.output.text(),
				notification: phase === "started" || phase === "renewed" ? "not-a-completion" : "idle-wake-or-next-request",
				label: record.label,
				terminalAt: isoTime(record.terminalAt),
				lastOutputAt: isoTime(record.lastOutputAt),
			});
		} catch { /* An observer failure must not strand or fail the execution. */ }
	};

	const viewOf = (record: ExecutionRecord): ShellExecutionView => ({
		executionId: record.executionId,
		owner: SHELL_OWNER,
		status: record.status,
		startedAt: record.startedAt,
		deadlineAt: record.deadlineAt,
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

	const sameScope = (record: ExecutionRecord, scope: ShellScope): boolean => inShellScope(record, scope);

	const requireRecord = (executionId: string, scope: ShellScope): ExecutionRecord => {
		const record = records.get(executionId);
		if (!record || !sameScope(record, scope)) throw new Error(record ? OUTSIDE_SCOPE : `Unknown shell execution: ${executionId}`);
		return record;
	};

	const releaseHandles = (record: ExecutionRecord): void => {
		record.child?.stdout?.removeAllListeners("data");
		record.child?.stderr?.removeAllListeners("data");
		record.child?.removeAllListeners?.();
		record.child = undefined;
		record.pid = undefined;
	};

	const trimTerminals = (): void => {
		const terminals = [...records.values()].filter((record) => record.status !== "running").sort((left, right) => left.startedAt - right.startedAt);
		while (terminals.length > maxTerminalRecords) {
			const oldest = terminals.shift();
			if (oldest) records.delete(oldest.executionId);
		}
	};

	const noteOutput = (record: ExecutionRecord, chunk: Buffer): void => {
		if (chunk.length === 0 || record.settled) return;
		record.output.append(chunk);
		record.lastOutputAt = now();
		notifyDisplay();
	};

	const finish = (record: ExecutionRecord, status: Exclude<ShellStatus, "running">, exitCode: number | null): void => {
		if (record.settled) return;
		record.settled = true;
		record.status = status;
		record.exitCode = exitCode;
		record.terminalAt = now();
		record.deadlineTimer?.cancel();
		record.deadlineTimer = undefined;
		releaseHandles(record);
		const waiters = record.waiters;
		record.waiters = [];
		for (const waiter of waiters) waiter();
		emit(record, status);
		trimTerminals();
		notifyDisplay();
		record.resolveClosed(exitCode);
	};

	const stop = (record: ExecutionRecord): void => {
		if (record.pid === undefined) return;
		try { (options.stop ?? killProcessTree)(record.pid); } catch { /* The close handler still settles the record. */ }
	};

	const armDeadline = (record: ExecutionRecord): void => {
		record.deadlineTimer?.cancel();
		const delay = Math.max(0, record.deadlineAt - now());
		record.deadlineTimer = scheduleDelay(delay, () => {
			if (record.settled) return;
			record.terminalCause = "deadline";
			stop(record);
		});
	};

	const launch = (spec: ShellSpawnSpec, command: string, input: StartShellInput): LaunchedProcess => {
		if (options.launch) return options.launch(spec, command, { cwd: input.cwd, env: input.env });
		const fromStdin = spec.commandTransport === "stdin";
		return spawn(spec.shell, fromStdin ? spec.args : [...spec.args, command], {
			cwd: input.cwd,
			detached: process.platform !== "win32",
			env: input.env,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		}) as LaunchedProcess;
	};

	return {
		get startCount() { return startCount; },
		async start(input) {
			if (input.signal?.aborted) throw new Error(ABORTED_BEFORE_START);
			if (input.command.trim().length === 0) throw new Error("Shell command is empty");
			const deadlineMs = requireDurationMs(input.deadlineMs);
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
			const spec = options.spawnSpec();
			const child = launch(spec, input.command, input);
			startCount += 1;
			let resolveClosed: (code: number | null) => void = () => {};
			const closed = new Promise<number | null>((resolve) => { resolveClosed = resolve; });
			const record: ExecutionRecord = {
				executionId: `exec_${randomBytes(8).toString("hex")}`,
				sessionId: input.sessionId,
				branchAnchor: input.branchAnchor,
				toolCallId: input.toolCallId,
				status: "running",
				startedAt,
				deadlineAt,
				exitCode: null,
				output: new BoundedOutput(maxOutputBytes),
				child,
				pid: child.pid,
				deadlineTimer: undefined,
				waiters: [],
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
			records.set(record.executionId, record);
			child.stdout?.on("data", (chunk: Buffer) => { noteOutput(record, chunk); });
			child.stderr?.on("data", (chunk: Buffer) => { noteOutput(record, chunk); });
			if (spec.commandTransport === "stdin") {
				child.stdin?.on("error", () => {});
				child.stdin?.end(input.command);
			}
			child.once("error", (error) => {
				noteOutput(record, Buffer.from(error.message));
				finish(record, record.terminalCause ?? "interrupted", null);
			});
			child.once("close", (code) => {
				finish(record, record.terminalCause ?? "exited", code);
			});
			armDeadline(record);
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
			const outcome = await raceWindow(record, input.foregroundWindowMs, input.signal);
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
				const done = () => {
					timer?.cancel();
					waitOptions.signal?.removeEventListener("abort", onAbort);
					record.waiters = record.waiters.filter((waiter) => waiter !== onTerminal);
					resolve(viewOf(record));
				};
				const onTerminal = () => done();
				const onAbort = () => done();
				record.waiters.push(onTerminal);
				timer = scheduleDelay(waitMs, done);
				if (record.status !== "running" || waitOptions.signal?.aborted) {
					onAbort();
					return;
				}
				waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		renew(executionId, scope, deadlineMs) {
			const record = requireRecord(executionId, scope);
			if (record.status !== "running") throw new Error(`Cannot renew shell execution ${executionId}; status is ${record.status}`);
			const duration = requireDurationMs(deadlineMs);
			record.deadlineAt = timestampAfter(now(), duration);
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
			const pending: Promise<number | null>[] = [];
			for (const record of records.values()) {
				if (record.status !== "running" || sameScope(record, scope)) continue;
				record.terminalCause = "interrupted";
				stop(record);
				pending.push(record.closed);
			}
			await Promise.all(pending);
		},
		async shutdown() {
			const pending: Promise<number | null>[] = [];
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

export function inShellScope(record: { sessionId: string | null; branchAnchor: string | null }, scope: ShellScope): boolean {
	if (record.sessionId !== scope.sessionId) return false;
	if (!record.branchAnchor || !scope.branchAnchor || record.branchAnchor === scope.branchAnchor) return true;
	return scope.branchIds?.includes(record.branchAnchor) === true;
}

function raceWindow(record: ExecutionRecord, windowMs: number, signal: AbortSignal | undefined): Promise<"terminal" | "window" | "abort"> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: CancellableDelay | undefined;
		const finish = (outcome: "terminal" | "window" | "abort") => {
			if (settled) return;
			settled = true;
			timer?.cancel();
			signal?.removeEventListener("abort", onAbort);
			record.waiters = record.waiters.filter((waiter) => waiter !== onTerminal);
			resolve(outcome);
		};
		const onTerminal = () => finish("terminal");
		const onAbort = () => finish("abort");
		timer = scheduleDelay(windowMs, () => finish("window"));
		record.waiters.push(onTerminal);
		if (record.settled) {
			onTerminal();
			return;
		}
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
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

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.unref();
		child.once("error", () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
	}
}

export type { ChildProcess };
