import { nativeLines } from "./native-lines.ts";
import { createHash, randomUUID } from "node:crypto";
import { isTaskLabel, mintProductId } from "./identity.ts";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { childProofSettled, type ChildProofBinding } from "./child-proof.ts";
import { newWriterMarker, parseWriterMarker, writerRecoveryEvidence, type WriterMarker } from "./writer-recovery.ts";
import { privateDirectory, syncDirectory } from "./private-directory.ts";
import { archiveBucket, archiveFilename, nativeArchiveDirectory, projectBucket } from "./native-archive.ts";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { NormalizedTask } from "./graph.ts";
import { AgentTaskSchema, ROLE_NAME_PATTERN, type EffectiveRoute, type TaskResult } from "./contracts.ts";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { validateGraphStructure } from "./graph.ts";
import { boundNativeObservation, unavailableObservation, type NativeObservation, type RecordedUsageEpisodes } from "./observability.ts";
import type { WorkerInputState } from "./worker-inputs.ts";
import { observerHeadline, parseObserverRoute, type ObserverTask } from "./observer-events.ts";
import type { CapturedProjectSkill } from "./guidance-resources.ts";
import { MANAGED_LIMITS, MANAGED_SESSION_VERSION, ManagedError, uncertainApply, type CandidateRef, type CurrentOwner, type ManagedState, type OwnedRootOutcome, type SessionOwner, type SessionView, type SessionActionResult, type EpisodeExecution } from "./session-contracts.ts";

function withoutObservation(result: TaskResult): TaskResult {
	const copy = { ...result }; delete copy.observation; return copy;
}

const LEGACY_PROFILE_KEYS = new Set([
	"reasoningProfile",
	"reasoningProfiles",
	"reasoningProfileRequested",
	"reasoningProfileApplied",
	"reasoningProfileSources",
]);

/** Current-version records that still name the retired profile concept are excluded, not interpreted or rewritten. */
function hasLegacyProfileField(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => hasLegacyProfileField(item));
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (LEGACY_PROFILE_KEYS.has(key)) return true;
		if (key === "profileFallbacks" && Array.isArray(item) && item.includes("reasoning-role-default")) return true;
		if (hasLegacyProfileField(item)) return true;
	}
	return false;
}

function excludedListError(error: unknown): boolean {
	return !(error instanceof ManagedError) || error.code === "managed_owner_mismatch" || error.code === "unsupported_contract" || error.code === "legacy_profile_field";
}

export interface ManagedRootState {
	id: string;
	source: string;
	permission: "read" | "write";
	git: boolean;
	paths: string[];
	target?: import("./repository-policy.ts").RepositoryTarget;
	pins?: Array<{ path: string; dev: number; ino: number }>;
	input?: import("./git-workspace.ts").GitInput;
	inputRef?: string;
	inputs?: WorkerInputState;
	workspaceReleased?: boolean;
	released?: boolean;
}
export interface ManagedRecord {
	version: typeof MANAGED_SESSION_VERSION;
	execution?: EpisodeExecution;
	handle: string;
	owner: SessionOwner;
	task: import("./contracts.ts").AgentTask;
	roots: ManagedRootState[];
	state: ManagedState;
	episode: number;
	nativeLeaf: string | null;
	/** Absent on pre-cutover records; these cannot resume native execution. */
	native?: { bucket: string; filename: string };
	route?: EffectiveRoute;
	inheritSkills?: boolean;
	projectSkills?: CapturedProjectSkill[];
	result?: TaskResult;
	candidate?: CandidateRef;
	retained?: boolean;
	/** A scoped recovery proved quiescence for this episode; never an execution result. */
	reconciledEpisode?: number;
	release?: { status: "pending" | "partial" | "complete"; remaining: string[] };
	dispatch?: { runId: string; generation: string; toolCallId: string; taskId: string; initiator?: string };
	assigner?: string;
	requests: Array<{ id: string; fingerprint: string; episode: number; state: "running" | "complete" | "unknown"; result?: TaskResult; candidate?: CandidateRef; execution?: EpisodeExecution; error?: { code: string; detail?: string }; runId?: string; generation?: string }>;
}
export function managedWriteRoots(record: ManagedRecord): ManagedRootState[] {
	return record.roots.filter((root) => root.permission === "write" && root.git);
}
/**
 * Writable roots that run in a private worktree and freeze a candidate; shared writers edit the checkout.
 * invoke_agent always records the workspace (shared by default); an engine-level task without one is isolated.
 */
export function isolatedWriteRoots(record: ManagedRecord): ManagedRootState[] {
	return record.task.workspace === "shared" ? [] : managedWriteRoots(record);
}
function rootReleaseStatus(record: ManagedRecord, rootId: string): "pending" | "remaining" | "released" {
	if (record.release === undefined) return "pending";
	return record.release.remaining.includes(rootId) ? "remaining" : "released";
}
/** Bounded per-root outcome projection; survives a discarded or never-frozen candidate. */
function ownedRootProjection(record: ManagedRecord): OwnedRootOutcome[] {
	const candidateRoots = new Map((record.candidate?.roots ?? []).map((root) => [root.rootId, root]));
	return managedWriteRoots(record).slice(0, 8).map((root) => {
		const candidateRoot = candidateRoots.get(root.id);
		const recovery = candidateRoot && ["applying", "partial", "unknown"].includes(candidateRoot.status) ? "required" as const : undefined;
		return { id: root.id, destination: root.source.slice(0, 128), status: candidateRoot?.status ?? "not-applied",
			...(recovery ? { recovery } : {}), release: rootReleaseStatus(record, root.id) };
	});
}

interface BatchRecord { version: typeof MANAGED_SESSION_VERSION; fingerprint: string; handles: string[]; complete: boolean; requestFingerprint?: string; response?: SessionActionResult }

/** Internal marker: a valid retained record owned by another session/repository; excluded from inventory without exposing details. */
class OutOfScopeRecord extends Error {}

export interface SessionInventoryEntry {
	handle: string;
	label?: string;
	elapsedMs?: number;
	route: ObserverTask["route"];
	role: string;
	/** Durable managed state; persisted running/queued is not proof that a child is currently alive. */
	state: ManagedState;
	episode: number;
	latestOutcome: "succeeded" | "failed" | "blocked" | "aborted" | "unknown";
	/** Distinct accepted episode identities; null when persistence cannot prove the count. */
	acceptedEpisodes: number | null;
	/** Retained ownership anchor for cheap per-query branch projection without rescanning storage. */
	ownerAnchor: string | null;
	onCurrentBranch: boolean;
	legacy: boolean;
	reportComplete: boolean;
	retained: boolean;
	roots?: OwnedRootOutcome[];
	release?: { status: string; remaining: number };
	usageEvidence: { episodes: number[] };
}

export interface SessionInventory {
	available: true;
	entries: SessionInventoryEntry[];
	complete: boolean;
	/** Generic completeness counts; unreadable contents and foreign owners stay unexposed. */
	problems: { unreadableRecords: number };
	summary: { agents: number; acceptedEpisodes: number | null; states: Record<ManagedState, number> };
}

export type SessionInventoryResult = SessionInventory | { available: false; reason: string };

function inventoryReason(error: unknown): string {
	if (error instanceof ManagedError) return error.code;
	const code = (error as NodeJS.ErrnoException)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{1,31}$/.test(code) ? code : "inventory_unavailable";
}

export function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
			: item,
	)).digest("hex");
}
const productId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9]+$" });
const hostId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const causeSchema = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" });
const digestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const fileStateSchema = Type.Union([
	Type.Object({ kind: Type.Literal("absent") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("directory"), mode: Type.Integer({ minimum: 0, maximum: 0o777 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("file"), mode: Type.Integer({ minimum: 0, maximum: 0o777 }), digest: digestSchema }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("symlink"), mode: Type.Integer({ minimum: 0, maximum: 0o777 }), link: Type.String({ maxLength: 4096 }) }, { additionalProperties: false }),
]);
const resultSchema = Type.Object({ id: productId, label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), role: Type.String({ pattern: ROLE_NAME_PATTERN }),
	status: Type.String({ pattern: "^(pending|running|succeeded|failed|blocked|aborted)$" }),
	executionStatus: Type.Optional(Type.String({ pattern: "^(pending|running|succeeded|failed|blocked|aborted|not-started|unavailable)$" })),
	finalization: Type.Optional(Type.Object({ status: Type.Literal("failed"), stage: Type.Union([Type.Literal("native-validation"), Type.Literal("candidate-freeze"), Type.Literal("result-save")]), code: hostId, reason: Type.Optional(causeSchema) }, { additionalProperties: false })),
	output: Type.String(), stderr: Type.String(), usage: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Number(), turns: Type.Number() }),
	durationMs: Type.Number(), changedPaths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries }), convergence: Type.String({ pattern: "^(not-applicable|applied|not-applied|conflict)$" }), reportComplete: Type.Optional(Type.Boolean()),
});
const gitOid = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const gitWorkspaceSchema = Type.Object({ version: Type.Literal(1), id: Type.String({ pattern: "^[a-z0-9]{32}$" }), repo: Type.String(), path: Type.String(), commonDir: Type.String(), gitDir: Type.String(), inputBase: gitOid, ownedRefs: Type.Record(Type.String({ pattern: "^refs/pi-extensions/agents/" }), gitOid), pendingRefs: Type.Optional(Type.Record(Type.String({ pattern: "^refs/pi-extensions/agents/" }), gitOid)) }, { additionalProperties: false });
const gitCandidateSchema = Type.Object({ id: Type.String({ pattern: "^[a-z0-9]{32}$" }), workspaceId: Type.String({ pattern: "^[a-z0-9]{32}$" }), inputBase: gitOid, commit: gitOid, tree: gitOid, changedPaths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries }) }, { additionalProperties: false });
const applyAttemptSchema = Type.Object({ parentCommit: gitOid, parentTree: gitOid, mergeTree: gitOid, paths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries }), integrationRef: Type.String({ pattern: "^refs/pi-extensions/agents/" }) }, { additionalProperties: false });
const candidateRootSchema = Type.Object({ rootId: productId, destination: Type.String(), status: Type.String({ pattern: "^(not-applied|applying|applied|partial|conflict|unknown)$" }), changedPaths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries }), appliedPaths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries }), git: Type.Optional(gitCandidateSchema), attempt: Type.Optional(applyAttemptSchema) }, { additionalProperties: false });
const candidateSchema = Type.Object({ id: productId, episode: Type.Integer({ minimum: 1, maximum: MANAGED_LIMITS.maxEpisodes }),
	status: Type.String({ pattern: "^(not-applied|applying|applied|partial|conflict|unknown)$" }),
	changedPaths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries, uniqueItems: true }),
	appliedPaths: Type.Array(Type.String(), { maxItems: MANAGED_LIMITS.maxEntries, uniqueItems: true }),
	roots: Type.Array(candidateRootSchema, { maxItems: 32 }),
}, { additionalProperties: false });
const storageVersion = Type.Literal(MANAGED_SESSION_VERSION);
const rootSchema = Type.Object({
	id: productId, source: Type.String(), permission: Type.Union([Type.Literal("read"), Type.Literal("write")]), git: Type.Boolean(), paths: Type.Array(Type.String(), { maxItems: 32 }),
	target: Type.Optional(Type.Object({ declared: Type.String(), root: Type.String(), identities: Type.Array(Type.Object({ path: Type.String(), dev: Type.Number(), ino: Type.Number() }, { additionalProperties: false }), { minItems: 3, maxItems: 3 }) }, { additionalProperties: false })),
	pins: Type.Optional(Type.Array(Type.Object({ path: Type.String(), dev: Type.Number(), ino: Type.Number() }, { additionalProperties: false }), { maxItems: 32 })),
	input: Type.Optional(Type.Object({ commit: gitOid, tree: gitOid }, { additionalProperties: false })),
	inputRef: Type.Optional(Type.String({ pattern: "^refs/pi-extensions/agents/inputs/[a-z0-9]{32}$" })),
	inputs: Type.Optional(Type.Object({ version: Type.Literal(2), gitWorkspace: gitWorkspaceSchema }, { additionalProperties: false })),
	workspaceReleased: Type.Optional(Type.Boolean()),
	released: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const executionSchema = Type.Object({ startedAtMs: Type.Number({ minimum: 0 }), inheritSkills: Type.Optional(Type.Boolean()), provenance: Type.Union([
	Type.Object({ available: Type.Literal(false) }, { additionalProperties: false }),
	Type.Object({ available: Type.Literal(true), extensionEpoch: hostId, configurationEpoch: hostId }, { additionalProperties: false }),
]) }, { additionalProperties: false });
const ownedRootSchema = Type.Object({ id: productId, destination: Type.String(), status: Type.String(), recovery: Type.Optional(Type.Literal("required")), release: Type.String() }, { additionalProperties: false });
const viewSchema = Type.Object({ handle: productId, label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), role: Type.String({ pattern: ROLE_NAME_PATTERN }), episode: Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes }), state: Type.String({ pattern: "^(idle|queued|running|interrupted|closed)$" }), reportComplete: Type.Boolean(), result: Type.Optional(resultSchema), candidate: Type.Optional(candidateSchema), retained: Type.Optional(Type.Boolean()), execution: Type.Optional(executionSchema), route: Type.Optional(Type.Object({})), release: Type.Optional(Type.Object({ status: Type.Union([Type.Literal("pending"), Type.Literal("partial"), Type.Literal("complete")]), remaining: Type.Array(Type.String(), { maxItems: 32 }) }, { additionalProperties: false })), roots: Type.Optional(Type.Array(ownedRootSchema, { maxItems: 8 })), requestError: Type.Optional(Type.Object({ code: hostId, detail: Type.Optional(causeSchema) }, { additionalProperties: false })) }, { additionalProperties: false });
const batchSchema = Type.Object({ version: storageVersion, fingerprint: digestSchema, handles: Type.Array(productId, { minItems: 1, maxItems: MANAGED_LIMITS.maxSessions, uniqueItems: true }), complete: Type.Boolean(), requestFingerprint: Type.Optional(digestSchema), response: Type.Optional(Type.Object({ schemaVersion: storageVersion, action: Type.Literal("create"), status: Type.String({ pattern: "^(accepted|succeeded|partial|failed|aborted)$" }), kind: Type.Optional(Type.String()), runId: Type.Optional(productId), generation: Type.Optional(hostId), sessions: Type.Array(viewSchema, { minItems: 1, maxItems: MANAGED_LIMITS.maxSessions }), error: Type.Optional(Type.Object({ code: hostId, detail: Type.Optional(causeSchema) }, { additionalProperties: false })) }, { additionalProperties: false })) }, { additionalProperties: false });
const recordSchema = Type.Object({
	version: storageVersion, handle: productId, execution: Type.Optional(executionSchema),
	owner: Type.Object({ repo: Type.String(), parentSessionId: hostId, anchor: Type.Union([hostId, Type.Null()]) }, { additionalProperties: false }),
	task: AgentTaskSchema, roots: Type.Array(rootSchema, { maxItems: 32 }), state: Type.String({ pattern: "^(idle|queued|running|interrupted|closed)$" }),
	dispatch: Type.Optional(Type.Object({ runId: productId, generation: hostId, toolCallId: Type.String({ maxLength: 256 }), taskId: productId, initiator: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, { additionalProperties: false })),
	assigner: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	episode: Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes }), nativeLeaf: Type.Union([hostId, Type.Null()]),
	native: Type.Optional(Type.Object({ bucket: Type.String({ maxLength: 255, pattern: archiveBucket.source }), filename: Type.String({ pattern: archiveFilename.source }) }, { additionalProperties: false })),
	route: Type.Optional(Type.Object({})), inheritSkills: Type.Optional(Type.Boolean()),
	projectSkills: Type.Optional(Type.Array(Type.Object({ path: Type.String({ maxLength: 4096 }), name: Type.String({ maxLength: 128 }) }, { additionalProperties: false }), { maxItems: 1024 })),
	result: Type.Optional(resultSchema), retained: Type.Optional(Type.Boolean()), reconciledEpisode: Type.Optional(Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes })),
	release: Type.Optional(Type.Object({ status: Type.Union([Type.Literal("pending"), Type.Literal("partial"), Type.Literal("complete")]), remaining: Type.Array(Type.String(), { maxItems: 32 }) }, { additionalProperties: false })),
	candidate: Type.Optional(candidateSchema),
	requests: Type.Array(Type.Object({ id: productId, fingerprint: digestSchema, episode: Type.Integer({ minimum: 1, maximum: MANAGED_LIMITS.maxEpisodes }), state: Type.String({ pattern: "^(running|complete|unknown)$" }), error: Type.Optional(Type.Object({ code: hostId, detail: Type.Optional(causeSchema) }, { additionalProperties: false })), runId: Type.Optional(productId), generation: Type.Optional(hostId), result: Type.Optional(resultSchema), candidate: Type.Optional(candidateSchema), execution: Type.Optional(executionSchema) }, { additionalProperties: false }), { maxItems: MANAGED_LIMITS.maxEpisodes }),
}, { additionalProperties: false });

const safeHandle = (value: string) => /^[A-Za-z0-9]{1,128}$/.test(value);
/** Caller-independent admission identity: any bounded string, never a path or handle. */
const safeCallIdentity = (value: string) => typeof value === "string" && value.length >= 1 && value.length <= 256;
const safeForeignId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
function shallowVersion(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const version = (value as { version?: unknown }).version;
	return typeof version === "number" ? version : undefined;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function readJson<T>(file: string): Promise<T> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > MANAGED_LIMITS.maxRegistryBytes) throw new ManagedError("managed_registry_invalid");
		return JSON.parse(await handle.readFile("utf8")) as T;
	} finally { await handle.close(); }
}


async function readWriterMarker(file: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > 4096) throw new ManagedError("managed_storage_invalid");
		return await handle.readFile("utf8");
	} finally { await handle.close(); }
}

// Serialize only known in-process root mutations. Disk locks still reject foreign/unknown writers.
const rootWriters = new Map<string, Promise<void>>();
const activeMarkers = new Map<string, { handle: FileHandle; marker: WriterMarker }>();
export class ManagedSessionStore {
	readonly root: string;
	private readonly sessions: string;
	constructor(agentDirectory: string) {
		this.root = join(agentDirectory, "managed-agents");
		this.sessions = join(agentDirectory, "sessions");
	}
	private archiveBucket(owner: CurrentOwner): string {
		if (owner.parentSessionFile && isAbsolute(owner.parentSessionFile)) {
			const parts = relative(this.sessions, owner.parentSessionFile).split(sep);
			if (archiveBucket.test(parts[0]!) && (parts.length === 2 || (parts.length === 3 && parts[1] === "agents"))) return parts[0]!;
		}
		const cwd = owner.parentCwd ?? owner.repo;
		const underManaged = relative(this.root, cwd);
		if (!isAbsolute(cwd) || resolve(cwd) !== cwd || (!isAbsolute(underManaged) && underManaged !== ".." && !underManaged.startsWith(`..${sep}`))) throw new ManagedError("managed_native_project_unavailable");
		return projectBucket(cwd);
	}
	nativePath(record: ManagedRecord): string {
		if (!record.native) throw new ManagedError("managed_native_binding_missing");
		const { bucket, filename } = record.native;
		if (!archiveBucket.test(bucket) || !archiveFilename.test(filename)) throw new ManagedError("managed_native_invalid", undefined, "binding");
		return join(this.sessions, bucket, "agents", filename);
	}
	nativeCwd(record: ManagedRecord): string {
		const shared = managedWriteRoots(record);
		if (shared.length > 0 && record.task.workspace === "shared") return shared[0]!.source;
		const writes = managedWriteRoots(record);
		const roots = join(this.path(record.handle), "roots");
		return writes.length === 1 ? join(roots, writes[0]!.id) : roots;
	}
	private async ensure(create: boolean): Promise<void> {
		if (create) await privateDirectory(dirname(this.root), false, 0o022);
		await privateDirectory(this.root, create);
	}
	path(handle: string): string {
		if (!safeHandle(handle)) throw new ManagedError("invalid_handle");
		return join(this.root, handle);
	}
	async write(file: string, value: unknown): Promise<void> {
		const bytes = JSON.stringify(value);
		if (Buffer.byteLength(bytes) > MANAGED_LIMITS.maxRegistryBytes) throw new ManagedError("managed_registry_limit");
		const temporary = `${file}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(bytes); await handle.sync(); await handle.close();
			await rename(temporary, file);
			await syncDirectory(dirname(file));
		} finally { await handle.close(); await rm(temporary, { force: true }); }
	}
	private async lock<T>(directory: string, action: () => Promise<T>): Promise<T> {
		if (directory !== this.root) return this.diskLock(directory, action);
		const predecessor = rootWriters.get(directory);
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		rootWriters.set(directory, pending);
		try { await predecessor; return await this.diskLock(directory, action); }
		finally { if (rootWriters.get(directory) === pending) rootWriters.delete(directory); release(); }
	}
	private async diskLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
		const marker = join(directory, ".writer-lock");
		let handle: FileHandle;
		try { handle = await open(marker, "wx", 0o600); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ManagedError("managed_writer_busy_or_unknown"); throw error; }
		try {
			if (directory !== this.root) {
				try { await lstat(join(directory, ".recovery-claim")); throw new ManagedError("managed_recovery_busy_or_unknown"); }
				catch (error) { if (!missing(error)) throw error; }
			}
			const evidence = directory === this.root ? undefined : await newWriterMarker();
			await handle.writeFile(evidence ? JSON.stringify(evidence) : randomUUID()); await handle.sync();
			if (evidence) activeMarkers.set(directory, { handle, marker: evidence });
			return await action();
		} finally { activeMarkers.delete(directory); await handle.close(); await rm(marker); }
	}
	private receiptPath(handle: string, episode: number): string { return join(this.path(handle), `child_${episode}.receipt`); }
	childProofBinding(handle: string, episode: number): ChildProofBinding | undefined {
		const marker = activeMarkers.get(this.path(handle))?.marker;
		return marker?.phase === "launch-intent" ? { path: this.receiptPath(handle, episode), episode, marker: { ...marker } } : undefined;
	}
	/** Called under withSession: persist launch intent before spawning, and settlement only after all writers settle. */
	async writerPhase(handle: string, phase: WriterMarker["phase"]): Promise<void> {
		const active = activeMarkers.get(this.path(handle));
		if (!active) return; // Unsupported host identity: preserve normal execution and require offline recovery.
		const prior = active.marker.phase;
		if (!((prior === "unknown" && phase === "not-started") || (prior === "not-started" && phase === "launch-intent") || (prior === "launch-intent" && phase === "settled"))) throw new ManagedError("managed_writer_phase_invalid");
		active.marker.phase = phase;
		const bytes = Buffer.from(JSON.stringify(active.marker));
		await active.handle.truncate(0); await active.handle.write(bytes, 0, bytes.length, 0); await active.handle.sync();
	}
	async reconcile(handle: string, owner: CurrentOwner, expectedEpisode: number): Promise<ManagedRecord> {
		const initial = await this.load(handle, owner);
		if (initial.episode !== expectedEpisode) throw new ManagedError("stale_episode");
		const directory = this.path(handle), claim = join(directory, ".recovery-claim"), marker = join(directory, ".writer-lock");
		let claimHandle: FileHandle;
		try { claimHandle = await open(claim, "wx", 0o600); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ManagedError("managed_recovery_busy_or_unknown", undefined, "Offline coordinated scoped remediation required if the claim is abandoned."); throw error; }
		try {
			const record = await this.load(handle, owner);
			if (record.episode !== expectedEpisode) throw new ManagedError("stale_episode");
			if (await this.finalizationPending(handle, record.episode) || uncertainApply(record.candidate)) throw new ManagedError("managed_recovery_uncertain_finalization");
			let raw: string;
			try { raw = await readWriterMarker(marker); }
			catch (error) { if (missing(error)) { if (record.state === "interrupted") return record; throw new ManagedError("managed_recovery_no_writer_evidence", undefined, "Offline coordinated scoped remediation required."); } throw error; }
			const evidence = parseWriterMarker(raw);
			if (!evidence) throw new ManagedError("managed_recovery_legacy_or_invalid_writer", undefined, "Offline coordinated scoped remediation required.");
			const status = await writerRecoveryEvidence(evidence, () => childProofSettled(
				{ marker: evidence, path: this.receiptPath(handle, expectedEpisode), episode: expectedEpisode }, this.nativePath(record),
				async () => (await this.nativeRevision(record)).leaf !== null, record.nativeLeaf,
			));
			if (status !== "gone") throw new ManagedError(status === "active" ? "managed_writer_active" : "managed_writer_settlement_unknown", undefined, "Wait for settlement or use offline coordinated scoped remediation.");
			if (await readWriterMarker(marker) !== raw) throw new ManagedError("managed_writer_changed");
			if (record.state !== "running" && record.state !== "queued" && record.state !== "interrupted") throw new ManagedError("managed_recovery_state_changed");
			record.state = "interrupted"; record.reconciledEpisode = expectedEpisode;
			const operation = record.requests.find(request => request.episode === record.episode && request.state === "running");
			if (operation) operation.state = "unknown";
			await this.save(record);
			await rm(marker); await syncDirectory(directory);
			return record;
		} finally { await claimHandle.close(); await rm(claim); }
	}
	private matches(record: ManagedRecord, owner: CurrentOwner): boolean {
		return record.owner.repo === owner.repo && record.owner.parentSessionId === owner.parentSessionId &&
			(record.owner.anchor === null || owner.branch.includes(record.owner.anchor) || owner.anchor === record.owner.anchor);
	}
	private finalizationPath(handle: string, episode: number): string { return join(this.path(handle), `finalization_${episode}.pending`); }
	async beginFinalization(handle: string, episode: number): Promise<void> { await this.write(this.finalizationPath(handle, episode), { episode }); }
	async endFinalization(handle: string, episode: number): Promise<void> { await rm(this.finalizationPath(handle, episode)); }
	async finalizationPending(handle: string, episode: number): Promise<boolean> {
		try { const info = await lstat(this.finalizationPath(handle, episode)); if (!info.isFile() || info.isSymbolicLink()) throw new ManagedError("managed_storage_invalid"); return true; }
		catch (error) { if (missing(error)) return false; throw error; }
	}
	async load(handle: string, owner: CurrentOwner): Promise<ManagedRecord> {
		await this.ensure(false);
		const directory = this.path(handle);
		await privateDirectory(directory, false);
		const raw = await readJson<unknown>(join(directory, "registry.json"));
		if (shallowVersion(raw) !== MANAGED_SESSION_VERSION) throw new ManagedError("unsupported_contract");
		const record = raw as ManagedRecord;
		this.validateRecord(handle, directory, record);
		if (!this.matches(record, owner)) throw new ManagedError("managed_owner_mismatch");
		if (record.result) record.result = await this.withObservation(handle, record.episode, record.result);
		for (const request of record.requests) if (request.result) request.result = withoutObservation(request.result);
		await this.finalizationView(handle, record);
		return record;
	}
	private validateRecord(handle: string, directory: string, record: ManagedRecord): void {
		if (hasLegacyProfileField(record)) throw new ManagedError("legacy_profile_field");
		if (!Check(recordSchema, record) || record.version !== MANAGED_SESSION_VERSION || record.handle !== handle) throw new ManagedError("managed_registry_invalid");
		if (!validateGraphStructure({ tasks: [{ ...record.task, dependsOn: [] }] }).ok) throw new ManagedError("managed_registry_invalid");
		if (record.roots.some((root) => root.permission === "write" && (!root.git || !root.target || root.inputs && root.inputs.gitWorkspace?.path !== join(directory, "roots", root.id)))) throw new ManagedError("managed_registry_invalid");
		if (new Set(record.requests.map((request) => request.id)).size !== record.requests.length || record.requests.some((request) => request.episode > record.episode)) throw new ManagedError("managed_registry_invalid");
		if (record.candidate && (record.candidate.episode !== record.episode || record.candidate.roots.some((root) => !record.roots.some((item) => item.id === root.rootId)))) throw new ManagedError("managed_registry_invalid");
	}
	/** In-memory view of an unconfirmed finalization; never repairs or rewrites persisted state. */
	private async finalizationView(handle: string, record: ManagedRecord): Promise<void> {
		if (await this.finalizationPending(handle, record.episode)) {
			if (record.state !== "closed") record.state = "interrupted";
			delete record.candidate;
			if (record.result) record.result = { ...record.result, status: "failed", executionStatus: record.result.executionStatus ?? "unavailable", finalization: { status: "failed", stage: "result-save", code: "result_persistence_unknown" }, error: { code: "result_persistence_unknown", message: "Finalization was not durably confirmed." } };
			const operation = record.requests.at(-1); if (operation) { operation.state = "unknown"; delete operation.candidate; if (record.result) operation.result = record.result; }
		}
	}
	async save(record: ManagedRecord): Promise<void> {
		await privateDirectory(this.path(record.handle), false);
		await this.write(join(this.path(record.handle), "registry.json"), { ...record,
			...(record.result ? { result: withoutObservation(record.result) } : {}),
			requests: record.requests.map((request) => ({ ...request, ...(request.result ? { result: withoutObservation(request.result) } : {}) })),
		});
	}
	async withSession<T>(handle: string, owner: CurrentOwner, action: (record: ManagedRecord) => Promise<T>): Promise<T> {
		await this.load(handle, owner);
		return this.lock(this.path(handle), async () => action(await this.load(handle, owner)));
	}
	/** Derived performance data is separate from the required registry/ACK commit. */
	async saveObservation(handle: string, episode: number, value: NativeObservation): Promise<NativeObservation> {
		try {
			if (!Number.isSafeInteger(episode) || episode < 1 || episode > MANAGED_LIMITS.maxEpisodes) return unavailableObservation();
			const bounded = boundNativeObservation(value);
			await this.write(join(this.path(handle), `observation_${episode}.json`), bounded);
			return await this.readObservation(handle, episode);
		} catch { return unavailableObservation(); }
	}
	async withObservation(handle: string, episode: number, result: TaskResult): Promise<TaskResult> {
		const core = withoutObservation(result);
		return core.observationVersion === 1 ? { ...core, observation: await this.readObservation(handle, episode) } : core;
	}
	private async readObservation(handle: string, episode: number): Promise<NativeObservation> {
		let observation = unavailableObservation();
		try {
			if (Number.isSafeInteger(episode) && episode >= 1 && episode <= MANAGED_LIMITS.maxEpisodes) {
				const file = join(this.path(handle), `observation_${episode}.json`);
				if ((await lstat(file)).size <= 64 * 1024) observation = boundNativeObservation(await readJson<NativeObservation>(file));
			}
		} catch { /* Optional evidence unavailable; core state remains authoritative. */ }
		return observation;
	}
	async recordedObservations(handle: string, episodes: readonly number[]): Promise<RecordedUsageEpisodes[]> {
		const unique = [...new Set(episodes)].filter((episode) => Number.isSafeInteger(episode) && episode >= 1 && episode <= MANAGED_LIMITS.maxEpisodes).sort((left, right) => left - right);
		const recorded: RecordedUsageEpisodes[] = [];
		for (const episode of unique) recorded.push({ episode, observation: await this.readObservation(handle, episode) });
		return recorded;
	}
	async list(owner: CurrentOwner): Promise<SessionView[]> {
		try { await this.ensure(false); } catch (error) { if (missing(error)) return []; throw error; }
		const views: SessionView[] = [];
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (!safeHandle(entry.name)) continue;
			try {
				const record = await this.load(entry.name, owner);
				if (record.state !== "closed") views.push(this.view(record));
			} catch (error) { if (excludedListError(error)) continue; throw error; }
			if (views.length > MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_session_limit");
		}
		return views;
	}
	/** Agent names bound in this parent session, across branches and including released agents. */
	async namedRecords(owner: CurrentOwner): Promise<Array<{ name: string; handle: string }>> {
		let names: string[];
		try { await this.ensure(false); names = (await readdir(this.root, { withFileTypes: true })).map((entry) => entry.name).filter((name) => safeHandle(name)); }
		catch (error) { if (missing(error)) return []; throw error; }
		const bound: Array<{ name: string; handle: string }> = [];
		for (const handle of names) {
			try {
				const raw = await readJson<unknown>(join(this.path(handle), "registry.json"));
				if (shallowVersion(raw) !== MANAGED_SESSION_VERSION) continue;
				const record = raw as ManagedRecord;
				if (record.owner?.repo !== owner.repo || record.owner?.parentSessionId !== owner.parentSessionId || typeof record.task?.id !== "string") continue;
				bound.push({ name: record.task.id, handle });
			} catch { /* Unreadable records hold no name this session can address. */ }
		}
		return bound;
	}
	async inventory(owner: CurrentOwner): Promise<SessionInventoryResult> {
		let names: string[];
		try {
			await this.ensure(false);
			names = (await readdir(this.root, { withFileTypes: true })).map((entry) => entry.name).filter((name) => safeHandle(name));
		} catch (error) {
			if (missing(error)) return { available: true, entries: [], complete: true, problems: { unreadableRecords: 0 }, summary: { agents: 0, acceptedEpisodes: 0, states: { idle: 0, queued: 0, running: 0, interrupted: 0, closed: 0 } } };
			return { available: false, reason: inventoryReason(error) };
		}
		const entries: SessionInventoryEntry[] = [];
		let unreadableRecords = 0;
		for (const name of names) {
			try { entries.push(await this.inventoryEntry(name, owner)); }
			catch (error) { if (error instanceof OutOfScopeRecord || (error instanceof ManagedError && (error.code === "unsupported_contract" || error.code === "legacy_profile_field"))) continue; unreadableRecords++; }
		}
		entries.sort((left, right) => left.handle < right.handle ? -1 : left.handle > right.handle ? 1 : 0);
		const states: Record<ManagedState, number> = { idle: 0, queued: 0, running: 0, interrupted: 0, closed: 0 };
		for (const entry of entries) states[entry.state]++;
		const acceptedEpisodes = entries.every((entry) => entry.acceptedEpisodes !== null)
			? entries.reduce((total, entry) => total + entry.acceptedEpisodes!, 0) : null;
		return { available: true, entries, complete: unreadableRecords === 0, problems: { unreadableRecords },
			summary: { agents: entries.length, acceptedEpisodes, states } };
	}
	private async inventoryEntry(name: string, owner: CurrentOwner): Promise<SessionInventoryEntry> {
		const directory = this.path(name);
		await privateDirectory(directory, false);
		const raw = await readJson<unknown>(join(directory, "registry.json"));
		const ownerRecord = raw && typeof raw === "object" ? (raw as { owner?: { repo?: unknown; parentSessionId?: unknown } }).owner : undefined;
		if (ownerRecord && typeof ownerRecord.repo === "string" && typeof ownerRecord.parentSessionId === "string"
			&& (ownerRecord.repo !== owner.repo || ownerRecord.parentSessionId !== owner.parentSessionId)) throw new OutOfScopeRecord();
		if (shallowVersion(raw) !== MANAGED_SESSION_VERSION) throw new ManagedError("unsupported_contract");
		const record = raw as ManagedRecord;
		this.validateRecord(name, directory, record);
		// Intentional read-only widening: same repository and parent session, regardless of branch anchor.
		if (record.owner.repo !== owner.repo || record.owner.parentSessionId !== owner.parentSessionId) throw new OutOfScopeRecord();
		await this.finalizationView(name, record);
		const acceptedEpisodes = new Set(record.requests.map((request) => request.episode)).size;
		const episodes: number[] = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const match = /^observation_(\d+)\.json$/.exec(entry.name);
			if (!match || !entry.isFile()) continue;
			const episode = Number(match[1]);
			if (episode >= 1 && episode <= MANAGED_LIMITS.maxEpisodes) episodes.push(episode);
		}
		episodes.sort((left, right) => left - right);
		const result = record.result;
		const status = result?.status;
		// Prefer the child's actual runtime, the scope of the live clock. A not-started or unknown zero is a placeholder.
		const ran = result?.executionStatus === undefined ? result != null && result.durationMs > 0
			: result.executionStatus === "succeeded" || result.executionStatus === "failed" || result.executionStatus === "aborted";
		const duration = result?.telemetry ? (result.telemetry.childStarted ? result.telemetry.childMs : undefined) : ran ? result?.durationMs : undefined;
		const route = result?.route ?? record.route;
		const roots = (record.candidate || record.release) ? ownedRootProjection(record) : [];
		return { handle: record.handle, label: observerHeadline(record.task.id), role: record.task.role, state: record.state, episode: record.episode,
			...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { elapsedMs: duration } : {}),
			route: route ? parseObserverRoute({ provider: route.provider, model: route.model, thinking: route.thinking }) ?? null : null,
			latestOutcome: status === "succeeded" || status === "failed" || status === "aborted" || status === "blocked" ? status : "unknown",
			acceptedEpisodes: acceptedEpisodes === record.episode ? acceptedEpisodes : null,
			ownerAnchor: record.owner.anchor,
			onCurrentBranch: record.owner.anchor === null || owner.branch.includes(record.owner.anchor) || owner.anchor === record.owner.anchor,
			legacy: record.version !== MANAGED_SESSION_VERSION, reportComplete: record.result?.reportComplete === true,
			retained: record.retained === true,
			...(roots.length ? { roots } : {}),
			...(record.release ? { release: { status: record.release.status, remaining: record.release.remaining.length } } : {}),
			usageEvidence: { episodes } };
	}
	private batchPath(owner: CurrentOwner, requestId: string): string { return join(this.root, `request_${fingerprint([owner.repo, owner.parentSessionId, requestId])}.json`); }
	private async readBatch(owner: CurrentOwner, requestId: string): Promise<BatchRecord | undefined> {
		let batch: BatchRecord;
		try { await this.ensure(false); batch = await readJson<BatchRecord>(this.batchPath(owner, requestId)); }
		catch (error) { if (missing(error)) return undefined; throw error; }
		if (hasLegacyProfileField(batch)) throw new ManagedError("legacy_profile_field");
		if (!Check(batchSchema, batch)) throw new ManagedError("managed_registry_invalid");
		if (!batch.complete) throw new ManagedError("request_outcome_unknown");
		const records = await Promise.all(batch.handles.map((handle) => this.load(handle, owner)));
		for (const record of records) this.nativePath(record);
		if (fingerprint(records.map((record) => record.task)) !== batch.fingerprint) throw new ManagedError("managed_registry_invalid");
		if (batch.response && (batch.response.sessions.length !== records.length || batch.response.sessions.some((view, index) => view.handle !== records[index]!.handle || view.role !== records[index]!.task.role || view.episode > records[index]!.episode))) throw new ManagedError("managed_registry_invalid");
		return batch;
	}
	async replayBatch(owner: CurrentOwner, requestId: string, requestFingerprint: string): Promise<SessionActionResult | undefined> {
		const batch = await this.readBatch(owner, requestId);
		if (!batch) return undefined;
		if (batch.requestFingerprint !== requestFingerprint) throw new ManagedError("request_id_conflict");
		if (!batch.response) throw new ManagedError("request_outcome_unknown");
		return { ...batch.response, sessions: await Promise.all(batch.response.sessions.map(async (view) => ({ ...view,
			...(view.result ? { result: await this.withObservation(view.handle, view.episode, view.result) } : {}),
		}))) };
	}
	async completeBatch(owner: CurrentOwner, requestId: string, response: SessionActionResult): Promise<void> {
		await this.lock(this.root, async () => {
			const batch = await this.readBatch(owner, requestId);
			if (!batch || (batch.response && batch.response.kind !== "submission")) throw new ManagedError("request_outcome_unknown");
			const terminal = { ...batch, version: MANAGED_SESSION_VERSION, response: { ...response,
				sessions: response.sessions.map((view) => ({ ...view, ...(view.result ? { result: withoutObservation(view.result) } : {}) })),
			} };
			const path = this.batchPath(owner, requestId);
			await this.write(path, terminal);
		});
	}
	async releaseReservation(owner: CurrentOwner, requestId: string): Promise<boolean> {
		await this.ensure(false);
		return this.lock(this.root, async () => {
			const path = this.batchPath(owner, requestId);
			let batch: BatchRecord;
			try { batch = await readJson<BatchRecord>(path); }
			catch (error) { if (missing(error)) return false; throw error; }
			if (!Check(batchSchema, batch) || batch.response) return false;
			const records = await Promise.all(batch.handles.map((handle) => this.load(handle, owner)));
			const pristine = records.every((record) => record.state === "idle" && record.episode === 0 && record.requests.length === 0
				&& record.result === undefined && record.dispatch === undefined && record.candidate === undefined
				&& record.retained === undefined && record.release === undefined);
			if (!pristine) return false;
			for (const record of records) if ((await this.nativeRevision(record)).leaf !== null) return false;
			for (const record of records) {
				await rm(this.nativePath(record));
				await rm(this.path(record.handle), { recursive: true, force: false });
			}
			await rm(path, { force: false });
			return true;
		});
	}
	async allocate(owner: CurrentOwner, requestId: string, tasks: readonly NormalizedTask[], requestFingerprint?: string): Promise<{ records: ManagedRecord[]; fresh: boolean }> {
		if (!safeCallIdentity(requestId)) throw new ManagedError("invalid_request_id");
		if (tasks.length < 1 || tasks.length > MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_session_limit");
		await this.ensure(true);
		return this.lock(this.root, async () => {
			const key = fingerprint([owner.repo, owner.parentSessionId, requestId]);
			const requestPath = join(this.root, `request_${key}.json`);
			const digest = fingerprint(tasks.map(({ roots: _roots, grants: _grants, ...task }) => task));
			let prior: BatchRecord | undefined;
			try { prior = await readJson<BatchRecord>(requestPath); } catch (error) { if (!missing(error)) throw error; }
			if (prior !== undefined) {
				if (hasLegacyProfileField(prior)) throw new ManagedError("legacy_profile_field");
				if (!prior || typeof prior !== "object" || prior.version !== MANAGED_SESSION_VERSION || typeof prior.complete !== "boolean" || typeof prior.fingerprint !== "string" || !Array.isArray(prior.handles) || prior.handles.length !== tasks.length || new Set(prior.handles).size !== prior.handles.length || prior.handles.some((handle) => typeof handle !== "string" || !safeHandle(handle))) throw new ManagedError("managed_registry_invalid");
				if (prior.fingerprint !== digest) throw new ManagedError("request_id_conflict");
				if (!prior.complete) throw new ManagedError("request_outcome_unknown");
				const records = await Promise.all(prior.handles.map((handle) => this.load(handle, owner)));
				for (const record of records) this.nativePath(record);
				if (fingerprint(records.map((record) => record.task)) !== digest) throw new ManagedError("managed_registry_invalid");
				return { records, fresh: false };
			}
			let count = 0;
			for (const entry of await readdir(this.root)) {
				if (!safeHandle(entry)) continue;
				await privateDirectory(this.path(entry), false);
				const stored = await readJson<unknown>(join(this.path(entry), "registry.json"));
				if (shallowVersion(stored) !== MANAGED_SESSION_VERSION || hasLegacyProfileField(stored)) continue;
				if (!Check(recordSchema, stored)) throw new ManagedError("managed_registry_invalid");
				if (stored.state !== "closed" && stored.owner.repo === owner.repo && stored.owner.parentSessionId === owner.parentSessionId) count++;
			}
			if (count + tasks.length > MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_session_limit");
			for (const task of tasks) if (!isTaskLabel(task.id)) throw new ManagedError("invalid_task_id");
			const handles = tasks.map(() => mintProductId());
			if (new Set(handles).size !== handles.length) throw new ManagedError("duplicate_task_id");
			for (const handle of handles) {
				try { await lstat(this.path(handle)); throw new ManagedError("agent_id_conflict"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof ManagedError)) throw error; if (error instanceof ManagedError) throw error; }
			}
			const bucket = this.archiveBucket(owner);
			const archive = await nativeArchiveDirectory(this.sessions, bucket, true);
			await this.write(requestPath, { version: MANAGED_SESSION_VERSION, fingerprint: digest, handles, complete: false, ...(requestFingerprint ? { requestFingerprint } : {}) } satisfies BatchRecord);
			const records: ManagedRecord[] = [];
			const createdDirectories: string[] = [];
			const createdFiles: string[] = [];
			try {
				for (const [index, task] of tasks.entries()) {
					const handle = handles[index]!;
					const directory = this.path(handle);
					await mkdir(directory, { mode: 0o700 }); createdDirectories.push(directory);
					await privateDirectory(join(directory, "scratch"), true);
					const { roots, grants: _grants, ...persistedTask } = task;
					const record: ManagedRecord = {
						version: MANAGED_SESSION_VERSION, handle, owner: { repo: owner.repo, parentSessionId: owner.parentSessionId, anchor: owner.anchor },
						task: persistedTask, roots: roots ?? [], state: "idle", episode: 0, nativeLeaf: null, requests: [],
					};
					const session = SessionManager.create(this.nativeCwd(record), archive, owner.parentSessionFile ? { parentSession: owner.parentSessionFile } : undefined);
					record.native = { bucket, filename: basename(session.getSessionFile()!) };
					const path = this.nativePath(record);
					const native = await open(path, "wx", 0o600); createdFiles.push(path);
					try { await native.writeFile(`${JSON.stringify(session.getHeader())}\n`); await native.sync(); }
					finally { await native.close(); }
					await syncDirectory(archive); // Persist the new filename before its private registry binding.
					await this.save(record); records.push(record);
				}
			} catch (error) {
				try {
					if (createdFiles.length) await nativeArchiveDirectory(this.sessions, bucket, false);
					for (const path of createdFiles) await rm(path);
					for (const directory of createdDirectories) await rm(directory, { recursive: true });
					await rm(requestPath);
				} catch { throw new ManagedError("admission_cleanup_incomplete"); }
				throw error;
			}
			await this.write(requestPath, { version: MANAGED_SESSION_VERSION, fingerprint: digest, handles, complete: true, ...(requestFingerprint ? { requestFingerprint } : {}) } satisfies BatchRecord);
			return { records, fresh: true };
		});
	}
	async nativeRevision(record: ManagedRecord): Promise<{ sessionId: string; leaf: string | null }> {
		const path = this.nativePath(record);
		await this.ensure(false);
		await privateDirectory(this.path(record.handle), false);
		await nativeArchiveDirectory(this.sessions, record.native!.bucket, false);
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new ManagedError("managed_native_invalid", undefined, "attributes");
			let index = 0;
			let sessionId: string | null = null;
			let leaf: string | null = null;
			const identifiers = new Set<string>();
			for await (const entry of nativeLines(file)) {
				if (index++ === 0) {
					if (entry.type !== "session" || entry.version !== CURRENT_SESSION_VERSION || typeof entry.id !== "string" || typeof entry.timestamp !== "string" || `${entry.timestamp.replace(/[:.]/g, "-")}_${entry.id}.jsonl` !== basename(path)) throw new ManagedError("managed_native_invalid", undefined, "header");
					if (entry.cwd !== this.nativeCwd(record)) throw new ManagedError("managed_native_invalid", undefined, "cwd");
					sessionId = entry.id;
				} else {
					if (typeof entry.type !== "string" || !entry.type || entry.type === "session" || typeof entry.id !== "string" || !safeForeignId(entry.id) || entry.id === sessionId || identifiers.has(entry.id) || (entry.parentId !== null && (typeof entry.parentId !== "string" || !identifiers.has(entry.parentId)))) throw new ManagedError("managed_native_invalid", undefined, "lineage");
					if (entry.type === "message" && (!entry.message || typeof entry.message !== "object" || typeof (entry.message as Record<string, unknown>).role !== "string")) throw new ManagedError("managed_native_invalid", undefined, "message");
					identifiers.add(entry.id); leaf = entry.id;
				}
			}
			if (sessionId === null) throw new ManagedError("managed_native_invalid", undefined, "header");
			const after = await lstat(path);
			if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.ctimeMs !== info.ctimeMs) throw new ManagedError("managed_native_invalid", undefined, "changed");
			return { sessionId, leaf };
		} catch (error) {
			if (error instanceof SyntaxError) throw new ManagedError("managed_native_invalid", undefined, "parse");
			throw error;
		} finally { await file.close(); }
	}
	view(record: ManagedRecord): SessionView {
		// Release facts are meaningless without the owned-root mapping; candidate-only roots already travel
		// inside `candidate`, so the ordinary view adds the projection once an explicit release exists.
		const roots = record.release ? ownedRootProjection(record) : [];
		return { handle: record.handle, label: record.task.id, role: record.task.role, episode: record.episode, state: record.state,
			reportComplete: record.result?.reportComplete === true,
			...(record.requests.at(-1)?.error ? { requestError: record.requests.at(-1)!.error! } : {}),
			...(record.execution ? { execution: record.execution } : {}), ...(record.result?.route ?? record.route ? { route: record.result?.route ?? record.route } : {}),
			...(record.result ? { result: record.result } : {}), ...(record.candidate ? { candidate: record.candidate } : {}),
			...(record.retained === undefined ? {} : { retained: record.retained }),
			...(record.release ? { release: record.release } : {}),
			...(roots.length ? { roots } : {}),
		};
	}
}
