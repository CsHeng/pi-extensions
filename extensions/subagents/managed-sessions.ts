import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedTask } from "./graph.ts";
import { SubagentTaskSchema, type EffectiveRoute, type TaskResult } from "./contracts.ts";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { validateGraphStructure } from "./graph.ts";
import { boundNativeObservation, unavailableObservation, type NativeObservation } from "./observability.ts";
import type { SavedWorkspace } from "./candidates.ts";
import { MANAGED_LIMITS, MANAGED_SESSION_VERSION, ManagedError, type CandidateRef, type CurrentOwner, type ManagedState, type SessionOwner, type SessionView, type SessionActionResult, type EpisodeExecution } from "./session-contracts.ts";

function withoutObservation(result: TaskResult): TaskResult {
	const copy = { ...result }; delete copy.observation; return copy;
}

export interface ManagedRecord {
	version: 1 | 2;
	execution?: EpisodeExecution;
	handle: string;
	owner: SessionOwner;
	task: NormalizedTask;
	state: ManagedState;
	episode: number;
	nativeLeaf: string | null;
	route?: EffectiveRoute;
	result?: TaskResult;
	candidate?: CandidateRef;
	retained?: boolean;
	workspace?: SavedWorkspace;
	/** Only bounded request identities/digests, not a business task ledger. */
	requests: Array<{ id: string; fingerprint: string; episode: number; state: "running" | "complete" | "unknown"; result?: TaskResult; candidate?: CandidateRef; execution?: EpisodeExecution }>;
}
interface BatchRecord { version: 1 | 2; fingerprint: string; handles: string[]; complete: boolean; requestFingerprint?: string; response?: SessionActionResult }

export function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
			: item,
	)).digest("hex");
}
const identity = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const digestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const fileStateSchema = Type.Union([
	Type.Object({ kind: Type.Literal("absent") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("directory"), mode: Type.Integer({ minimum: 0, maximum: 0o777 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("file"), mode: Type.Integer({ minimum: 0, maximum: 0o777 }), digest: digestSchema }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("symlink"), mode: Type.Integer({ minimum: 0, maximum: 0o777 }), link: Type.String({ maxLength: 4096 }) }, { additionalProperties: false }),
]);
const resultSchema = Type.Object({ id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }), role: Type.Union([Type.Literal("worker"), Type.Literal("reviewer"), Type.Literal("explorer")]),
	status: Type.String({ pattern: "^(pending|running|succeeded|failed|blocked|aborted)$" }),
	output: Type.String(), stderr: Type.String(), usage: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Number(), turns: Type.Number() }),
	durationMs: Type.Number(), changedPaths: Type.Array(Type.String(), { maxItems: 32 }), convergence: Type.String({ pattern: "^(not-applicable|applied|not-applied|conflict)$" }), reportComplete: Type.Optional(Type.Boolean()),
});
const candidateSchema = Type.Object({ id: identity, episode: Type.Integer({ minimum: 1, maximum: MANAGED_LIMITS.maxEpisodes }),
	status: Type.String({ pattern: "^(not-applied|applying|applied|partial|conflict|unknown)$" }),
	changedPaths: Type.Array(Type.String(), { minItems: 1, maxItems: 32, uniqueItems: true }),
	appliedPaths: Type.Array(Type.String(), { maxItems: 32, uniqueItems: true }),
}, { additionalProperties: false });
const storageVersion = Type.Union([Type.Literal(1), Type.Literal(2)]);
const executionSchema = Type.Object({ startedAtMs: Type.Number({ minimum: 0 }), provenance: Type.Union([
	Type.Object({ available: Type.Literal(false) }, { additionalProperties: false }),
	Type.Object({ available: Type.Literal(true), extensionEpoch: identity, configurationEpoch: identity }, { additionalProperties: false }),
]) }, { additionalProperties: false });
const viewSchema = Type.Object({ handle: identity, role: Type.String({ pattern: "^(worker|reviewer|explorer)$" }), episode: Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes }), state: Type.String({ pattern: "^(idle|running|interrupted|closed)$" }), reportComplete: Type.Boolean(), result: Type.Optional(resultSchema), candidate: Type.Optional(candidateSchema), retained: Type.Optional(Type.Boolean()), execution: Type.Optional(executionSchema), route: Type.Optional(Type.Object({})), requestError: Type.Optional(Type.Object({ code: identity }, { additionalProperties: false })) }, { additionalProperties: false });
const batchSchema = Type.Object({ version: storageVersion, fingerprint: digestSchema, handles: Type.Array(identity, { minItems: 1, maxItems: MANAGED_LIMITS.maxSessions, uniqueItems: true }), complete: Type.Boolean(), requestFingerprint: Type.Optional(digestSchema), response: Type.Optional(Type.Object({ schemaVersion: storageVersion, action: Type.Literal("create"), status: Type.String({ pattern: "^(succeeded|partial|failed|aborted)$" }), sessions: Type.Array(viewSchema, { minItems: 1, maxItems: MANAGED_LIMITS.maxSessions }), error: Type.Optional(Type.Object({ code: identity }, { additionalProperties: false })) }, { additionalProperties: false })) }, { additionalProperties: false });
const recordSchema = Type.Object({
	version: storageVersion, handle: identity, execution: Type.Optional(executionSchema),
	owner: Type.Object({ repo: Type.String(), parentSessionId: identity, anchor: Type.Union([identity, Type.Null()]) }, { additionalProperties: false }),
	task: SubagentTaskSchema, state: Type.String({ pattern: "^(idle|running|interrupted|closed)$" }),
	episode: Type.Integer({ minimum: 0, maximum: MANAGED_LIMITS.maxEpisodes }), nativeLeaf: Type.Union([identity, Type.Null()]),
	route: Type.Optional(Type.Object({})), result: Type.Optional(resultSchema), retained: Type.Optional(Type.Boolean()),
	candidate: Type.Optional(candidateSchema),
	workspace: Type.Optional(Type.Object({ baseline: Type.Record(Type.String(), fileStateSchema), parentBaseline: Type.Record(Type.String(), fileStateSchema), inputs: Type.Object({ version: Type.Literal(1), dependencyRoots: Type.Array(Type.Literal("node_modules"), { maxItems: 1, uniqueItems: true }), parentDependencyKey: digestSchema, dependencyKey: digestSchema }, { additionalProperties: false }) }, { additionalProperties: false })),
	requests: Type.Array(Type.Object({ id: identity, fingerprint: digestSchema, episode: Type.Integer({ minimum: 1, maximum: MANAGED_LIMITS.maxEpisodes }), state: Type.String({ pattern: "^(running|complete|unknown)$" }), result: Type.Optional(resultSchema), candidate: Type.Optional(candidateSchema), execution: Type.Optional(executionSchema) }, { additionalProperties: false }), { maxItems: MANAGED_LIMITS.maxEpisodes }),
}, { additionalProperties: false });

const safeHandle = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function privateDirectory(directory: string, create: boolean): Promise<void> {
	if (create) {
		try { await mkdir(directory, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || await realpath(directory) !== directory) throw new ManagedError("managed_storage_invalid");
}

async function readJson<T>(file: string): Promise<T> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > MANAGED_LIMITS.maxRegistryBytes) throw new ManagedError("managed_registry_invalid");
		return JSON.parse(await handle.readFile("utf8")) as T;
	} finally { await handle.close(); }
}

export function exceedsManagedStorageBudget(bytes: number, entries: number): boolean {
	return bytes > MANAGED_LIMITS.maxStoreBytes || entries > MANAGED_LIMITS.maxStoreEntries;
}

export class ManagedSessionStore {
	readonly root: string;
	constructor(agentDirectory: string) { this.root = join(agentDirectory, "subagent-managed-sessions"); }
	private async ensure(create: boolean): Promise<void> { await privateDirectory(this.root, create); }
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
			const directory = await open(dirname(file), "r");
			try { await directory.sync(); } finally { await directory.close(); }
		} finally { await handle.close(); await rm(temporary, { force: true }); }
	}
	private async lock<T>(directory: string, action: () => Promise<T>): Promise<T> {
		const marker = join(directory, ".writer-lock");
		let handle: FileHandle;
		try { handle = await open(marker, "wx", 0o600); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ManagedError("managed_writer_busy_or_unknown"); throw error; }
		try {
			await handle.writeFile(randomUUID()); await handle.sync();
			return await action();
		} finally { await handle.close(); await rm(marker); }
	}
	private matches(record: ManagedRecord, owner: CurrentOwner): boolean {
		return record.owner.repo === owner.repo && record.owner.parentSessionId === owner.parentSessionId &&
			(record.owner.anchor === null || owner.branch.includes(record.owner.anchor) || owner.anchor === record.owner.anchor);
	}
	async load(handle: string, owner: CurrentOwner): Promise<ManagedRecord> {
		await this.ensure(false);
		const directory = this.path(handle);
		await privateDirectory(directory, false);
		const record = await readJson<ManagedRecord>(join(directory, "registry.json"));
		if (!Check(recordSchema, record) || ![1, MANAGED_SESSION_VERSION].includes(record.version) || record.handle !== handle) throw new ManagedError("managed_registry_invalid");
		if (![record.task.writePaths, record.task.inputs, record.task.dependsOn, record.task.resourceLocks, record.task.externalReadRoots].every(Array.isArray) || !validateGraphStructure({ tasks: [{ ...record.task, dependsOn: [] }] }).ok) throw new ManagedError("managed_registry_invalid");
		if (new Set(record.requests.map((request) => request.id)).size !== record.requests.length || record.requests.some((request) => request.episode > record.episode)) throw new ManagedError("managed_registry_invalid");
		if (record.workspace && record.task.writePaths.some((file) => !Object.hasOwn(record.workspace!.parentBaseline, file))) throw new ManagedError("managed_registry_invalid");
		if (record.candidate && (record.candidate.episode !== record.episode || record.candidate.changedPaths.some((file) => !record.task.writePaths.includes(file)) || record.candidate.appliedPaths.some((file, index) => record.candidate!.changedPaths[index] !== file) || (record.candidate.status === "applied" && record.candidate.appliedPaths.length !== record.candidate.changedPaths.length))) throw new ManagedError("managed_registry_invalid");
		if (!this.matches(record, owner)) throw new ManagedError("managed_owner_mismatch");
		if (record.result) record.result = await this.withObservation(handle, record.episode, record.result);
		for (const request of record.requests) if (request.result) request.result = withoutObservation(request.result);
		return record;
	}
	async save(record: ManagedRecord): Promise<void> {
		await privateDirectory(this.path(record.handle), false);
		await this.write(join(this.path(record.handle), "registry.json"), { ...record, version: MANAGED_SESSION_VERSION,
			...(record.result ? { result: withoutObservation(record.result) } : {}),
			requests: record.requests.map((request) => ({ ...request, ...(request.result ? { result: withoutObservation(request.result) } : {}) })),
		});
	}
	async withSession<T>(handle: string, owner: CurrentOwner, action: (record: ManagedRecord) => Promise<T>): Promise<T> {
		await this.load(handle, owner);
		return this.lock(this.path(handle), async () => action(await this.load(handle, owner)));
	}
	async checkCapacity(extraBytes = 0, requiredExtraBytes = 0): Promise<void> {
		if ([extraBytes, requiredExtraBytes].some((value) => !Number.isSafeInteger(value) || value < 0)) throw new ManagedError("managed_storage_limit");
		let bytes = extraBytes + requiredExtraBytes; let entries = extraBytes ? 1 : 0;
		let requiredBytes = requiredExtraBytes; let requiredEntries = 0;
		const disposable: string[] = [];
		const visit = async (directory: string, sessionRoot = false): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const file = join(directory, entry.name);
				const match = sessionRoot && /^observation_([1-9][0-9]*)\.json(?:\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp)?$/.exec(entry.name);
				let info;
				try { info = await lstat(file); } catch (error) { if (match && missing(error)) continue; throw error; }
				bytes += info.size; entries++;
				if (match && Number(match[1]) <= MANAGED_LIMITS.maxEpisodes && info.isFile()) disposable.push(file);
				else { requiredBytes += info.size; requiredEntries++; }
				if (exceedsManagedStorageBudget(requiredBytes, requiredEntries)
					|| (extraBytes > 0 && exceedsManagedStorageBudget(bytes, entries))
					|| disposable.length > MANAGED_LIMITS.maxStoreEntries + MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_storage_limit");
				if (info.isDirectory()) await visit(file, directory === this.root && /^session_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(entry.name));
			}
		};
		await visit(this.root);
		if (exceedsManagedStorageBudget(bytes, entries)) {
			// Only disposable derived observations, including an in-flight optional
			// write, may be reclaimed. Never touch native history/core/candidates.
			for (const file of disposable) await rm(file, { force: true });
		}
	}
	/** Derived performance data is separate from the required registry/ACK commit. */
	async saveObservation(handle: string, episode: number, value: NativeObservation): Promise<NativeObservation> {
		try {
			if (!Number.isSafeInteger(episode) || episode < 1 || episode > MANAGED_LIMITS.maxEpisodes) return unavailableObservation();
			const bounded = boundNativeObservation(value);
			await this.checkCapacity(Buffer.byteLength(JSON.stringify(bounded)) + 1);
			await this.write(join(this.path(handle), `observation_${episode}.json`), bounded);
			// Concurrent required growth wins over optional evidence. A postflight
			// can evict this cache rather than poison another episode's admission.
			await this.checkCapacity();
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
	async list(owner: CurrentOwner): Promise<SessionView[]> {
		try { await this.ensure(false); } catch (error) { if (missing(error)) return []; throw error; }
		const views: SessionView[] = [];
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (!entry.name.startsWith("session_")) continue;
			try {
				const record = await this.load(entry.name, owner);
				if (record.state !== "closed") views.push(this.view(record));
			} catch (error) { if (!(error instanceof ManagedError) || error.code !== "managed_owner_mismatch") throw error; }
			if (views.length > MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_session_limit");
		}
		return views;
	}
	private batchPath(owner: CurrentOwner, requestId: string): string { return join(this.root, `request_${fingerprint([owner.repo, owner.parentSessionId, requestId])}.json`); }
	private async readBatch(owner: CurrentOwner, requestId: string): Promise<BatchRecord | undefined> {
		let batch: BatchRecord;
		try { await this.ensure(false); batch = await readJson<BatchRecord>(this.batchPath(owner, requestId)); }
		catch (error) { if (missing(error)) return undefined; throw error; }
		if (!Check(batchSchema, batch)) throw new ManagedError("managed_registry_invalid");
		if (!batch.complete) throw new ManagedError("request_outcome_unknown");
		const records = await Promise.all(batch.handles.map((handle) => this.load(handle, owner)));
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
			if (!batch || batch.response) throw new ManagedError("request_outcome_unknown");
			const terminal = { ...batch, version: MANAGED_SESSION_VERSION, response: { ...response,
				sessions: response.sessions.map((view) => ({ ...view, ...(view.result ? { result: withoutObservation(view.result) } : {}) })),
			} };
			const path = this.batchPath(owner, requestId);
			await this.checkCapacity(0, Math.max(0, Buffer.byteLength(JSON.stringify(terminal)) - (await lstat(path)).size));
			await this.write(path, terminal);
		});
	}
	async allocate(owner: CurrentOwner, requestId: string, tasks: readonly NormalizedTask[], requestFingerprint?: string): Promise<{ records: ManagedRecord[]; fresh: boolean }> {
		if (!safeHandle(requestId)) throw new ManagedError("invalid_request_id");
		if (tasks.length < 1 || tasks.length > MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_session_limit");
		await this.ensure(true);
		return this.lock(this.root, async () => {
			const key = fingerprint([owner.repo, owner.parentSessionId, requestId]);
			const requestPath = join(this.root, `request_${key}.json`);
			const digest = fingerprint(tasks);
			let prior: BatchRecord | undefined;
			try { prior = await readJson<BatchRecord>(requestPath); } catch (error) { if (!missing(error)) throw error; }
			if (prior !== undefined) {
				if (!prior || typeof prior !== "object" || ![1, MANAGED_SESSION_VERSION].includes(prior.version) || typeof prior.complete !== "boolean" || typeof prior.fingerprint !== "string" || !Array.isArray(prior.handles) || prior.handles.length !== tasks.length || new Set(prior.handles).size !== prior.handles.length || prior.handles.some((handle) => typeof handle !== "string" || !safeHandle(handle))) throw new ManagedError("managed_registry_invalid");
				if (prior.fingerprint !== digest) throw new ManagedError("request_id_conflict");
				if (!prior.complete) throw new ManagedError("request_outcome_unknown");
				const records = await Promise.all(prior.handles.map((handle) => this.load(handle, owner)));
				if (fingerprint(records.map((record) => record.task)) !== digest) throw new ManagedError("managed_registry_invalid");
				return { records, fresh: false };
			}
			await this.checkCapacity();
			let count = 0;
			for (const entry of await readdir(this.root)) {
				if (!entry.startsWith("session_")) continue;
				await privateDirectory(this.path(entry), false);
				const stored = await readJson<ManagedRecord>(join(this.path(entry), "registry.json"));
				if (!Check(recordSchema, stored)) throw new ManagedError("managed_registry_invalid");
				if (stored.state !== "closed" && stored.owner.repo === owner.repo && stored.owner.parentSessionId === owner.parentSessionId) count++;
			}
			if (count + tasks.length > MANAGED_LIMITS.maxSessions) throw new ManagedError("managed_session_limit");
			const handles = tasks.map(() => `session_${randomUUID()}`);
			await this.write(requestPath, { version: MANAGED_SESSION_VERSION, fingerprint: digest, handles, complete: false, ...(requestFingerprint ? { requestFingerprint } : {}) } satisfies BatchRecord);
			const records: ManagedRecord[] = [];
			for (const [index, task] of tasks.entries()) {
				const handle = handles[index]!;
				const directory = this.path(handle);
				await privateDirectory(directory, true);
				await privateDirectory(join(directory, "scratch"), true);
				const native = await open(join(directory, "native.jsonl"), "wx", 0o600); await native.close();
				const record: ManagedRecord = {
					version: MANAGED_SESSION_VERSION, handle, owner: { repo: owner.repo, parentSessionId: owner.parentSessionId, anchor: owner.anchor },
					task, state: "idle", episode: 0, nativeLeaf: null, requests: [],
				};
				await this.save(record); records.push(record);
			}
			await this.write(requestPath, { version: MANAGED_SESSION_VERSION, fingerprint: digest, handles, complete: true, ...(requestFingerprint ? { requestFingerprint } : {}) } satisfies BatchRecord);
			return { records, fresh: true };
		});
	}
	async nativeRevision(handle: string): Promise<{ sessionId: string | null; leaf: string | null }> {
		await this.ensure(false); await privateDirectory(this.path(handle), false);
		const file = await open(join(this.path(handle), "native.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > MANAGED_LIMITS.maxNativeBytes || (info.mode & 0o077) !== 0) throw new ManagedError("managed_native_invalid");
			const text = await file.readFile("utf8");
			if (!text) return { sessionId: null, leaf: null };
			if (!text.endsWith("\n")) throw new ManagedError("managed_native_incomplete");
			const lines = text.trimEnd().split("\n");
			if (lines.length > MANAGED_LIMITS.maxEntries) throw new ManagedError("managed_native_limit");
			let sessionId: string | null = null;
			let leaf: string | null = null;
			const identifiers = new Set<string>();
			const types = new Set(["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "label", "session_info", "custom_message"]);
			for (const [index, line] of lines.entries()) {
				if (Buffer.byteLength(line) > MANAGED_LIMITS.maxNativeLineBytes) throw new ManagedError("managed_native_limit");
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (!entry || typeof entry !== "object") throw new ManagedError("managed_native_invalid");
				if (index === 0) {
					if (entry.type !== "session" || entry.version !== 3 || typeof entry.id !== "string" || !safeHandle(entry.id)) throw new ManagedError("managed_native_invalid");
					sessionId = entry.id;
				} else {
					if (typeof entry.type !== "string" || !types.has(entry.type) || typeof entry.id !== "string" || !safeHandle(entry.id) || identifiers.has(entry.id) || (entry.parentId !== null && (typeof entry.parentId !== "string" || !identifiers.has(entry.parentId)))) throw new ManagedError("managed_native_invalid");
					if (entry.type === "message" && (!entry.message || typeof entry.message !== "object" || typeof (entry.message as Record<string, unknown>).role !== "string")) throw new ManagedError("managed_native_invalid");
					identifiers.add(entry.id); leaf = entry.id;
				}
			}
			return { sessionId, leaf };
		} finally { await file.close(); }
	}
	view(record: ManagedRecord): SessionView {
		return { handle: record.handle, role: record.task.role, episode: record.episode, state: record.state,
			reportComplete: record.result?.reportComplete === true,
			...(record.execution ? { execution: record.execution } : {}), ...(record.result?.route ?? record.route ? { route: record.result?.route ?? record.route } : {}),
			...(record.result ? { result: record.result } : {}), ...(record.candidate ? { candidate: record.candidate } : {}),
			...(record.retained === undefined ? {} : { retained: record.retained }),
		};
	}
}
