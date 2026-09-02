import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { HARD_LIMITS, isSafeDiagnosticRef, truncateUtf8 } from "./contracts.ts";

const ROOT_NAME = "subagent-sessions";
const ACTIVE_MARKER = ".active";
const LOCK_NAME = ".allocation-lock";
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const TIMELINE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TIMELINE_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "pending"]);
const TIMELINE_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

export type DiagnosticErrorCode = "diagnostic_session_unavailable" | "diagnostic_storage_unavailable" | "diagnostic_session_limit";

export class DiagnosticError extends Error {
	readonly code: DiagnosticErrorCode;

	constructor(code: DiagnosticErrorCode, message: string) {
		super(message);
		this.name = "DiagnosticError";
		this.code = code;
	}
}

export interface DiagnosticTaskSession {
	path: string;
	ref: string;
	removeUnused(): Promise<void>;
}

export interface DiagnosticLimitResult {
	ok: boolean;
	code?: "diagnostic_session_limit";
	scope?: "child" | "run";
}

export interface DiagnosticRun {
	readonly path: string;
	readonly ref: string;
	readonly parentSegment: string;
	readonly runSegment: string;
	createTask(taskId: string): Promise<DiagnosticTaskSession>;
	checkLimits(taskPath?: string): Promise<DiagnosticLimitResult>;
	settle(): Promise<void>;
}

export interface DiagnosticScope {
	ref: string;
	path: string;
	active: boolean;
	staleActive: boolean;
	mtimeMs: number;
	bytes: number;
}

export interface DiagnosticTimelineEntry {
	timestamp?: string;
	entryType: "session" | "message";
	role?: string;
	stopReason?: string;
	toolNames?: string[];
	toolResultError?: boolean;
}

export interface DiagnosticInspection {
	path: string;
	ref: string;
	entries: DiagnosticTimelineEntry[];
	truncated: boolean;
	transcriptComplete: boolean;
}

export interface DiagnosticStoreLike {
	allocateRun(parentSessionId: string, runId: string): Promise<DiagnosticRun>;
	discover(parentSessionId?: string): Promise<DiagnosticScope[]>;
	inspect(reference: string): Promise<DiagnosticInspection>;
}

export interface DiagnosticStoreOptions {
	now?: () => number;
	lockWaitMs?: number;
}

interface RunRecord {
	path: string;
	ref: string;
	active: boolean;
	mtimeMs: number;
	bytes: number;
}

export class DiagnosticStore {
	readonly agentDir: string;
	readonly root: string;
	private readonly now: () => number;
	private readonly lockWaitMs: number;

	constructor(agentDir: string, options: DiagnosticStoreOptions = {}) {
		this.agentDir = agentDir;
		this.root = join(agentDir, ROOT_NAME);
		this.now = options.now ?? Date.now;
		this.lockWaitMs = options.lockWaitMs ?? 2_000;
	}

	async allocateRun(parentSessionId: string, runId: string): Promise<DiagnosticRun> {
		await this.ensureRoot(true);
		return this.withLock(async () => {
			const parentSegment = safeSegment(parentSessionId);
			const runSegment = safeSegment(runId);
			await this.cleanup(true);
			const parentPath = join(this.root, parentSegment);
			await ensurePrivateDirectory(parentPath, true);
			const runPath = join(parentPath, runSegment);
			try {
				await mkdir(runPath, { mode: 0o700 });
			} catch (error) {
				throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic run directory is unavailable (${errorCode(error)}).`);
			}
			try {
				await verifyPrivateDirectory(runPath);
				await createPrivateFile(join(runPath, ACTIVE_MARKER));
			} catch (error) {
				await rm(runPath, { recursive: true, force: true });
				if (error instanceof DiagnosticError) throw error;
				throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic run initialization failed (${errorCode(error)}).`);
			}
			const ref = `${ROOT_NAME}/${parentSegment}/${runSegment}`;
			let settled = false;
			return {
				path: runPath,
				ref,
				parentSegment,
				runSegment,
				createTask: async (taskId) => {
					if (settled) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic run is already settled.");
					await verifyPrivateDirectory(runPath);
					const taskSegment = safeTaskSegment(taskId);
					const taskPath = join(runPath, `${taskSegment}.jsonl`);
					await createPrivateFile(taskPath);
					const taskRef = `${ref}/${taskSegment}.jsonl`;
					return {
						path: taskPath,
						ref: taskRef,
						removeUnused: async () => { await rm(taskPath, { force: true }); },
					};
				},
				checkLimits: async (taskPath) => checkRunLimits(runPath, taskPath),
				settle: async () => {
					if (settled) return;
					settled = true;
					await this.withLock(async () => {
						await rm(join(runPath, ACTIVE_MARKER), { force: true });
						await this.cleanup(false);
					});
				},
			};
		});
	}

	async discover(parentSessionId?: string): Promise<DiagnosticScope[]> {
		if (!await this.ensureRoot(false)) return [];
		const parentFilter = parentSessionId === undefined ? undefined : safeSegment(parentSessionId);
		const records = await scanRuns(this.root, parentFilter);
		return records
			.sort((a, b) => b.mtimeMs - a.mtimeMs || a.ref.localeCompare(b.ref))
			.slice(0, HARD_LIMITS.maxDiagnosticScopes)
			.map((record) => ({ ...record, staleActive: record.active }));
	}

	async inspect(reference: string): Promise<DiagnosticInspection> {
		const normalized = normalizeRef(reference);
		if (!isSafeDiagnosticRef(normalized) || normalized.split("/").length !== 4 || !normalized.endsWith(".jsonl")) {
			throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic task reference is invalid.");
		}
		if (!await this.ensureRoot(false)) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic root does not exist.");
		const [, parentSegment, runSegment] = normalized.split("/");
		if (!parentSegment || !runSegment) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic task reference is invalid.");
		await verifyPrivateDirectory(join(this.root, parentSegment));
		await verifyPrivateDirectory(join(this.root, parentSegment, runSegment));
		const taskPath = confinedPath(this.agentDir, normalized);
		let handle: FileHandle | undefined;
		try {
			handle = await open(taskPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const info = await handle.stat();
			if (!info.isFile()) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic session is not a regular file.");
			verifyOwnerAndMode(info, false);
			const parsed = await parseTimeline(handle);
			return { path: taskPath, ref: normalized, ...parsed };
		} catch (error) {
			if (error instanceof DiagnosticError) throw error;
			throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic session cannot be inspected (${errorCode(error)}).`);
		} finally {
			await handle?.close();
		}
	}

	private async ensureRoot(create: boolean): Promise<boolean> {
		try {
			await verifyPrivateDirectory(this.root);
			return true;
		} catch (error) {
			if (errorCode(error) === "ENOENT" && !create) return false;
			if (errorCode(error) === "ENOENT" && create) {
				try {
					await ensurePrivateDirectory(this.root, true);
					return true;
				} catch (creationError) {
					if (creationError instanceof DiagnosticError) throw creationError;
					throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic root is unavailable (${errorCode(creationError)}).`);
				}
			}
			if (error instanceof DiagnosticError) throw error;
			throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic root is unavailable (${errorCode(error)}).`);
		}
	}

	private async withLock<T>(action: () => Promise<T>): Promise<T> {
		const lockPath = join(this.root, LOCK_NAME);
		const deadline = this.now() + this.lockWaitMs;
		const maxAttempts = Math.max(1, Math.ceil(this.lockWaitMs / 25));
		let attempts = 0;
		while (true) {
			try {
				await mkdir(lockPath, { mode: 0o700 });
				await verifyPrivateDirectory(lockPath);
				break;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw new DiagnosticError("diagnostic_storage_unavailable", `Diagnostic allocation lock is unavailable (${errorCode(error)}).`);
				attempts += 1;
				if (attempts >= maxAttempts || this.now() >= deadline) throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic allocation lock is busy.");
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
		}
		try {
			return await action();
		} finally {
			await rm(lockPath, { recursive: true, force: true });
		}
	}

	private async cleanup(forAdmission: boolean): Promise<void> {
		const records = await scanRuns(this.root);
		const active = records.filter((record) => record.active);
		const settled = records.filter((record) => !record.active);
		let reservations = active.reduce((total, record) => total + Math.max(record.bytes, HARD_LIMITS.diagnosticRunBytes), 0);
		if (forAdmission) reservations += HARD_LIMITS.diagnosticRunBytes;
		if (reservations > HARD_LIMITS.diagnosticRootBytes) {
			throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic active-run reservations exhaust the total-root ceiling.");
		}
		const expiry = this.now() - HARD_LIMITS.diagnosticRetentionMs;
		const expired = settled.filter((record) => record.mtimeMs < expiry).sort(oldestFirst);
		for (const record of expired) await removeSettledRun(record);
		let remaining = settled.filter((record) => record.mtimeMs >= expiry).sort(oldestFirst);
		let settledBytes = remaining.reduce((total, record) => total + record.bytes, 0);
		while (remaining.length > 0 && settledBytes + reservations > HARD_LIMITS.diagnosticRootBytes) {
			const record = remaining.shift() as RunRecord;
			await removeSettledRun(record);
			settledBytes -= record.bytes;
		}
		if (settledBytes + reservations > HARD_LIMITS.diagnosticRootBytes) {
			throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic storage cannot reserve capacity for a new run.");
		}
	}
}

export function safeSegment(value: string): string {
	if (SAFE_SEGMENT.test(value) && value !== "." && value !== "..") return value;
	return `id-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function safeTaskSegment(value: string): string {
	const segment = safeSegment(value);
	return segment.endsWith(".jsonl") ? `${segment.slice(0, -6)}-task` : segment;
}

function normalizeRef(reference: string): string {
	const value = reference.trim().replace(/^\.\//, "");
	return value.startsWith(`${ROOT_NAME}/`) ? value : `${ROOT_NAME}/${value}`;
}

function confinedPath(base: string, relative: string): string {
	const candidate = resolve(base, relative);
	const prefix = `${resolve(base)}${sep}`;
	if (!candidate.startsWith(prefix)) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic reference escapes its root.");
	return candidate;
}

async function ensurePrivateDirectory(path: string, create: boolean): Promise<void> {
	try {
		await verifyPrivateDirectory(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT" || !create) throw error;
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (mkdirError) {
			if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
		}
		await verifyPrivateDirectory(path);
	}
}

async function verifyPrivateDirectory(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic path is not a private directory.");
	verifyOwnerAndMode(info, true);
}

async function verifyPrivateRegularFile(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic session is not a regular file.");
	verifyOwnerAndMode(info, false);
}

function verifyOwnerAndMode(info: Awaited<ReturnType<typeof lstat>>, directory: boolean): void {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && Number(info.uid) !== uid) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic path is not owned by the current user.");
	if ((Number(info.mode) & 0o077) !== 0) throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic ${directory ? "directory" : "file"} permissions are not private.`);
}

async function createPrivateFile(path: string): Promise<void> {
	let created = false;
	try {
		const handle = await open(path, "wx", 0o600);
		created = true;
		await handle.close();
		await verifyPrivateRegularFile(path);
	} catch (error) {
		if (created) await rm(path, { force: true }).catch(() => {});
		if (error instanceof DiagnosticError) throw error;
		throw new DiagnosticError("diagnostic_session_unavailable", `Diagnostic session file is unavailable (${errorCode(error)}).`);
	}
}

async function scanRuns(root: string, parentFilter?: string): Promise<RunRecord[]> {
	const records: RunRecord[] = [];
	for (const parent of await safeDirectoryEntries(root)) {
		if (parent.name === LOCK_NAME) continue;
		if (!parent.isDirectory() || parent.isSymbolicLink() || !SAFE_SEGMENT.test(parent.name)) throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic root contains an unsafe entry.");
		if (parentFilter && parent.name !== parentFilter) continue;
		const parentPath = join(root, parent.name);
		await verifyPrivateDirectory(parentPath);
		for (const run of await safeDirectoryEntries(parentPath)) {
			if (!run.isDirectory() || run.isSymbolicLink() || !SAFE_SEGMENT.test(run.name)) throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic parent contains an unsafe entry.");
			const runPath = join(parentPath, run.name);
			await verifyPrivateDirectory(runPath);
			const entries = await safeDirectoryEntries(runPath);
			const marker = entries.find((entry) => entry.name === ACTIVE_MARKER);
			if (marker && (!marker.isFile() || marker.isSymbolicLink())) throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic active marker is unsafe.");
			if (marker) await verifyPrivateRegularFile(join(runPath, ACTIVE_MARKER));
			let bytes = 0;
			let mtimeMs = (await stat(runPath)).mtimeMs;
			for (const entry of entries) {
				if (entry.name === ACTIVE_MARKER) continue;
				if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) throw new DiagnosticError("diagnostic_storage_unavailable", "Diagnostic run contains an unsafe entry.");
				const info = await lstat(join(runPath, entry.name));
				verifyOwnerAndMode(info, false);
				bytes += info.size;
				mtimeMs = Math.max(mtimeMs, info.mtimeMs);
			}
			records.push({ path: runPath, ref: `${ROOT_NAME}/${parent.name}/${run.name}`, active: marker !== undefined, mtimeMs, bytes });
		}
	}
	return records;
}

async function safeDirectoryEntries(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		throw new DiagnosticError("diagnostic_storage_unavailable", `Diagnostic directory cannot be read (${errorCode(error)}).`);
	}
}

async function removeSettledRun(record: RunRecord): Promise<void> {
	if (record.active) throw new DiagnosticError("diagnostic_storage_unavailable", "Refusing to remove an active diagnostic run.");
	await rm(record.path, { recursive: true, force: false });
}

function oldestFirst(a: RunRecord, b: RunRecord): number {
	return a.mtimeMs - b.mtimeMs || a.ref.localeCompare(b.ref);
}

async function checkRunLimits(runPath: string, taskPath?: string): Promise<DiagnosticLimitResult> {
	if (taskPath) {
		const info = await lstat(taskPath);
		if (info.size > HARD_LIMITS.diagnosticChildBytes) return { ok: false, code: "diagnostic_session_limit", scope: "child" };
	}
	let bytes = 0;
	for (const entry of await safeDirectoryEntries(runPath)) {
		if (entry.name === ACTIVE_MARKER) continue;
		if (!entry.isFile() || entry.isSymbolicLink()) return { ok: false, code: "diagnostic_session_limit", scope: "run" };
		bytes += (await lstat(join(runPath, entry.name))).size;
	}
	return bytes > HARD_LIMITS.diagnosticRunBytes
		? { ok: false, code: "diagnostic_session_limit", scope: "run" }
		: { ok: true };
}

async function parseTimeline(handle: FileHandle): Promise<Omit<DiagnosticInspection, "path" | "ref">> {
	const entries: DiagnosticTimelineEntry[] = [];
	let buffer = "";
	let truncated = false;
	let structurallyValid = true;
	let sawHeader = false;
	let nonEmptyLines = 0;
	let lastAssistantStop: string | undefined;
	let lastRole: string | undefined;
	const processLine = (line: string) => {
		if (!line.trim()) return;
		nonEmptyLines += 1;
		if (Buffer.byteLength(line, "utf8") > HARD_LIMITS.maxDiagnosticLineBytes) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic session line exceeds the inspection limit.");
		let value: unknown;
		try { value = JSON.parse(line) as unknown; } catch { structurallyValid = false; return; }
		if (!isRecord(value)) { structurallyValid = false; return; }
		let projected: DiagnosticTimelineEntry | undefined;
		if (value.type === "session") {
			const validHeader = nonEmptyLines === 1 && typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1;
			if (!validHeader) structurallyValid = false;
			else sawHeader = true;
			const timestamp = safeTimestamp(value.timestamp);
			projected = { entryType: "session", ...(timestamp === undefined ? {} : { timestamp }) };
		} else if (value.type === "message" && isRecord(value.message) && typeof value.message.role === "string") {
			const message = value.message;
			const candidateRole = message.role as string;
			const role = TIMELINE_ROLES.has(candidateRole) ? candidateRole : "unknown";
			lastRole = role;
			const toolNames = role === "assistant" && Array.isArray(message.content)
				? [...new Set(message.content.filter(isRecord).filter((part) => part.type === "toolCall" && typeof part.name === "string" && TIMELINE_TOOLS.has(part.name)).map((part) => part.name as string))].sort()
				: role === "toolResult" && typeof message.toolName === "string" && TIMELINE_TOOLS.has(message.toolName)
					? [message.toolName]
					: undefined;
			const candidateStopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const stopReason = role === "assistant" && candidateStopReason !== undefined && TIMELINE_STOP_REASONS.has(candidateStopReason) ? candidateStopReason : undefined;
			if (stopReason !== undefined) lastAssistantStop = stopReason;
			const timestamp = safeTimestamp(value.timestamp);
			projected = {
				entryType: "message",
				role,
				...(timestamp === undefined ? {} : { timestamp }),
				...(stopReason === undefined ? {} : { stopReason }),
				...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
				...(role === "toolResult" ? { toolResultError: message.isError === true } : {}),
			};
		} else if (value.type === "message") {
			structurallyValid = false;
		}
		if (!projected) return;
		if (entries.length >= HARD_LIMITS.maxDiagnosticTimelineEntries) { truncated = true; return; }
		entries.push(projected);
	};
	for await (const chunk of handle.createReadStream({ encoding: "utf8", autoClose: false })) {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > HARD_LIMITS.maxDiagnosticLineBytes && !buffer.includes("\n")) throw new DiagnosticError("diagnostic_session_unavailable", "Diagnostic session line exceeds the inspection limit.");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	}
	if (buffer) processLine(buffer);
	const transcriptComplete = sawHeader && structurallyValid && !truncated && lastRole === "assistant" && (lastAssistantStop === "stop" || lastAssistantStop === "length");
	return { entries, truncated, transcriptComplete };
}

export function renderDiagnosticInspection(inspection: DiagnosticInspection): string {
	const warning = "Opening this path with pi --session creates an ordinary continuable Pi session; it does not continue the original subagent task, and a worker snapshot may no longer exist.";
	const body = [
		`Diagnostic session: ${inspection.path}`,
		`Transcript complete: ${inspection.transcriptComplete ? "yes" : "no"}${inspection.truncated ? " (timeline truncated)" : ""}`,
		...inspection.entries.map((entry) => {
			const fields = [entry.timestamp, entry.entryType, entry.role, entry.stopReason && `stop=${entry.stopReason}`, entry.toolNames?.length ? `tools=${entry.toolNames.join(",")}` : undefined, entry.toolResultError === undefined ? undefined : `toolError=${entry.toolResultError}`];
			return fields.filter(Boolean).join(" ");
		}),
	].join("\n");
	const warningBytes = Buffer.byteLength(`\n${warning}`, "utf8");
	return `${truncateUtf8(body, Math.max(0, HARD_LIMITS.maxDiagnosticRenderBytes - warningBytes)).text}\n${warning}`;
}

function safeTimestamp(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= 64 && /^[0-9TZ:.-]+$/.test(value) ? value : undefined;
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
