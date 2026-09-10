import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertNoSymlinkComponent, changedEntries, createSafeParentDirectories, createWorkerWorkspace, sameState, state, WorkspaceError, type FileState } from "./workspace.ts";
import { fingerprint, type ManagedRecord, type ManagedSessionStore } from "./managed-sessions.ts";
import { MANAGED_LIMITS, ManagedError, type CandidateRef } from "./session-contracts.ts";
import { inspectWorkerInputs, prepareWorkerInputs, refreshWorkerInputs, scanSourceSnapshot, scanWorkerSource, type WorkerInputState } from "./worker-inputs.ts";

export interface SavedWorkspace {
	baseline: Record<string, FileState>;
	parentBaseline: Record<string, FileState>;
	inputs: WorkerInputState;
}
interface FrozenCandidate { version: 1; episode: number; fingerprint: string; environmentKey: string; files: Array<{ path: string; state: FileState }> }
const asMap = (record: Record<string, FileState>) => new Map(Object.entries(record));
const absent: FileState = { kind: "absent" };
const sourcePath = (store: ManagedSessionStore, record: ManagedRecord) => join(store.path(record.handle), "source");
const scanFingerprint = (entries: ReadonlyMap<string, FileState>) => fingerprint([...entries].sort(([a], [b]) => a.localeCompare(b)));
async function scanManaged(source: string, workspace: SavedWorkspace) {
	await assertNoSymlinkComponent(source, source);
	try { return await scanWorkerSource(source, workspace.inputs); }
	catch (error) { if (error instanceof ManagedError && error.code === "worker_input_special_entry") throw new WorkspaceError("unexpected_worker_change", "Managed source contains an unsupported filesystem entry."); throw error; }
}
function allowedNewDirectory(record: ManagedRecord, path: string, before: FileState | undefined, after: FileState | undefined): boolean {
	return !before && after?.kind === "directory" && record.task.writePaths.some((file) => file.startsWith(`${path}/`));
}

export async function prepareManagedWorkspace(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	if (record.task.role !== "worker") return;
	if (record.task.writePaths.some((file) => file === ".git" || file.startsWith(".git/"))) throw new ManagedError("managed_git_write_forbidden");
	if (record.workspace) return;
	const snapshot = await createWorkerWorkspace(record.owner.repo, record.task, { maxBytes: MANAGED_LIMITS.maxWorkspaceBytes, maxEntries: MANAGED_LIMITS.maxEntries });
	const source = sourcePath(store, record); let created = false;
	try {
		await mkdir(source, { mode: 0o700 }); created = true;
		await cp(snapshot.root, source, { recursive: true, verbatimSymlinks: true });
		const inputs = await prepareWorkerInputs(record.owner.repo, source);
		if (record.task.writePaths.some((file) => inputs.dependencyRoots.some((root) => file === root || file.startsWith(`${root}/`)))) throw new ManagedError("managed_runtime_write_forbidden");
		record.workspace = { baseline: Object.fromEntries(await scanWorkerSource(source, inputs)), parentBaseline: Object.fromEntries(snapshot.parentBaselines), inputs };
		await store.save(record);
	} catch (error) {
		delete record.workspace; if (created) await rm(source, { recursive: true, force: true });
		throw error;
	} finally { await snapshot.cleanup(); }
}

/** Synchronize non-owned inputs without replacing the worker's unapplied edits. */
export async function syncManagedInputs(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	if (!record.workspace) throw new ManagedError("managed_workspace_missing");
	if (record.candidate && ["applying", "partial", "unknown"].includes(record.candidate.status)) throw new ManagedError("candidate_recovery_required");
	const source = sourcePath(store, record);
	for (const file of record.task.writePaths) {
		await assertNoSymlinkComponent(record.owner.repo, join(record.owner.repo, file));
		if (!sameState(await state(join(record.owner.repo, file)), record.workspace.parentBaseline[file] ?? absent)) throw new ManagedError("convergence_conflict");
	}
	const snapshot = await createWorkerWorkspace(record.owner.repo, record.task, { maxBytes: MANAGED_LIMITS.maxWorkspaceBytes, maxEntries: MANAGED_LIMITS.maxEntries });
	try {
		const current = await scanManaged(source, record.workspace);
		const baseline = asMap(record.workspace.baseline);
		const nextInputs = await scanSourceSnapshot(snapshot.root);
		const owned = new Set(record.task.writePaths);
		for (const file of changedEntries(baseline, current)) {
			if (!owned.has(file) && !allowedNewDirectory(record, file, baseline.get(file), current.get(file))) throw new ManagedError("unexpected_worker_change");
		}
		const changes = changedEntries(baseline, nextInputs).filter((file) => !owned.has(file));
		try {
			for (const file of [...changes].sort((a, b) => b.length - a.length)) {
				const before = baseline.get(file); const next = nextInputs.get(file); if (!before || (before.kind === "directory" && next?.kind === "directory")) continue;
				const destination = join(source, file); await assertNoSymlinkComponent(source, dirname(destination));
				if (before.kind === "directory") {
					if (!record.task.writePaths.some((owned) => owned.startsWith(`${file}/`))) await rmdir(destination);
				} else await rm(destination, { force: true });
			}
			for (const file of [...changes].sort((a, b) => a.length - b.length)) {
				const next = nextInputs.get(file); if (!next) continue;
				const destination = join(source, file); await assertNoSymlinkComponent(source, dirname(destination));
				if (next.kind === "directory") { await mkdir(destination, { recursive: true, mode: 0o700 }); await chmod(destination, next.mode!); }
				else { await createSafeParentDirectories(source, destination, []); await cp(join(snapshot.root, file), destination, { force: true, verbatimSymlinks: true }); }
			}
			record.workspace.inputs = await refreshWorkerInputs(record.owner.repo, source, record.workspace.inputs);
			for (const file of changes) { const next = nextInputs.get(file); if (next) record.workspace.baseline[file] = next; else delete record.workspace.baseline[file]; }
			await store.save(record);
		} catch (error) {
			// No multi-file transaction or automatic rollback: preserve the source
			// and prior candidate, and never launch on a partially synchronized view.
			record.state = "interrupted"; await store.save(record); throw error;
		}
	} finally { await snapshot.cleanup(); }
}

export async function freezeCandidate(store: ManagedSessionStore, record: ManagedRecord): Promise<CandidateRef | undefined> {
	if (!record.workspace || !record.result?.reportComplete || record.result.status !== "succeeded") throw new ManagedError("candidate_report_incomplete");
	const source = sourcePath(store, record);
	const current = await scanManaged(source, record.workspace);
	const changed = changedEntries(asMap(record.workspace.baseline), current).filter((file) => !allowedNewDirectory(record, file, record.workspace!.baseline[file], current.get(file)));
	for (const file of changed) {
		const before = record.workspace.baseline[file] ?? absent;
		const after = current.get(file) ?? absent;
		if (!record.task.writePaths.includes(file) || after.kind !== "file" || (before.kind === "file" && before.mode !== after.mode)) throw new ManagedError("unexpected_worker_change");
		await assertNoSymlinkComponent(source, join(source, file));
	}
	if (!changed.length) { delete record.candidate; await store.save(record); return undefined; }
	let candidateBytes = 0;
	for (const file of changed) { candidateBytes += (await lstat(join(source, file))).size; if (candidateBytes > MANAGED_LIMITS.maxCandidateBytes) throw new ManagedError("candidate_limit"); }
	const id = `candidate_${randomUUID()}`;
	const directory = join(store.path(record.handle), id);
	await mkdir(directory, { mode: 0o700 });
	const files: FrozenCandidate["files"] = []; candidateBytes = 0;
	for (const [index, file] of changed.entries()) {
		const bytes = await readFile(join(source, file)); candidateBytes += bytes.length;
		if (candidateBytes > MANAGED_LIMITS.maxCandidateBytes) throw new ManagedError("candidate_limit");
		await writeFile(join(directory, String(index)), bytes, { flag: "wx", mode: 0o600 });
		files.push({ path: file, state: current.get(file)! });
	}
	const manifest: FrozenCandidate = { version: 1, episode: record.episode, fingerprint: scanFingerprint(current), environmentKey: (await inspectWorkerInputs(source, record.workspace.inputs)).environmentKey, files };
	await store.write(join(directory, "manifest.json"), manifest);
	record.candidate = { id, episode: record.episode, status: "not-applied", changedPaths: changed, appliedPaths: [] };
	await store.save(record);
	return record.candidate;
}

export async function applyCandidate(store: ManagedSessionStore, record: ManagedRecord, candidateId: string): Promise<CandidateRef> {
	const candidate = record.candidate;
	if (!record.workspace || !candidate || candidate.id !== candidateId || candidate.episode !== record.episode) throw new ManagedError("candidate_mismatch");
	if (candidate.status === "applied") return candidate;
	if (["applying", "partial", "unknown"].includes(candidate.status)) throw new ManagedError("candidate_recovery_required");
	if (!/^candidate_[a-zA-Z0-9_-]+$/.test(candidate.id)) throw new ManagedError("candidate_mismatch");
	const directory = join(store.path(record.handle), candidate.id);
	await assertNoSymlinkComponent(store.path(record.handle), join(directory, "manifest.json"));
	const info = await lstat(join(directory, "manifest.json"));
	if (!info.isFile() || info.size > 1024 * 1024) throw new ManagedError("candidate_invalid");
	const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as FrozenCandidate;
	if (manifest.version !== 1 || manifest.episode !== record.episode || !Array.isArray(manifest.files) || manifest.files.length !== candidate.changedPaths.length) throw new ManagedError("candidate_invalid");
	const current = await scanManaged(sourcePath(store, record), record.workspace);
	if (manifest.environmentKey !== (await inspectWorkerInputs(sourcePath(store, record), record.workspace.inputs)).environmentKey || manifest.fingerprint !== scanFingerprint(current)) throw new ManagedError("candidate_changed");
	const buffers: Buffer[] = [];
	let bytes = 0;
	for (const [index, file] of manifest.files.entries()) {
		if (!file || file.path !== candidate.changedPaths[index] || !record.task.writePaths.includes(file.path) || !file.state || !sameState(file.state, current.get(file.path) ?? absent)) throw new ManagedError("candidate_invalid");
		const blob = join(directory, String(index));
		await assertNoSymlinkComponent(directory, blob);
		const info = await lstat(blob);
		bytes += info.size;
		if (!info.isFile() || bytes > MANAGED_LIMITS.maxCandidateBytes) throw new ManagedError("candidate_invalid");
		const content = await readFile(blob);
		if (content.length !== info.size || createHash("sha256").update(content).digest("hex") !== file.state.digest) throw new ManagedError("candidate_changed");
		buffers.push(content);
	}
	for (const file of record.task.writePaths) {
		await assertNoSymlinkComponent(record.owner.repo, join(record.owner.repo, file));
		if (!sameState(await state(join(record.owner.repo, file)), record.workspace.parentBaseline[file] ?? absent)) {
			candidate.status = "conflict"; await store.save(record); return candidate;
		}
	}
	candidate.status = "applying";
	await store.save(record);
	const created: string[] = [];
	try {
		for (const [index, file] of manifest.files.entries()) {
			const destination = join(record.owner.repo, file.path);
			await createSafeParentDirectories(record.owner.repo, destination, created);
			const temporary = join(dirname(destination), `.csheng-candidate-${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, buffers[index]!, { flag: "wx", mode: file.state.mode ?? 0o644 });
				await chmod(temporary, file.state.mode ?? 0o644);
				await assertNoSymlinkComponent(record.owner.repo, destination);
				if (!sameState(await state(destination), record.workspace.parentBaseline[file.path] ?? absent)) throw new ManagedError("convergence_conflict");
				await rename(temporary, destination);
				candidate.appliedPaths.push(file.path);
				await store.save(record);
			} finally { await assertNoSymlinkComponent(record.owner.repo, temporary); await rm(temporary, { force: true }); }
		}
		record.workspace.baseline = Object.fromEntries(current);
		for (const file of record.task.writePaths) record.workspace.parentBaseline[file] = current.get(file) ?? absent;
		candidate.status = "applied";
		await store.save(record);
		return candidate;
	} catch (error) {
		candidate.status = candidate.appliedPaths.length ? "partial" : "unknown";
		await store.save(record);
		throw error;
	} finally {
		for (const directory of created.reverse()) {
			try { await assertNoSymlinkComponent(record.owner.repo, directory); await rmdir(directory); }
			catch (error) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
		}
	}
}
