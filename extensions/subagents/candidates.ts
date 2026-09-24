import { join } from "node:path";
import { captureGitInput, createGitTaskWorkspace, freezeGitCandidate, applyGitCandidate, refreshGitInputs, retainGitInput } from "./git-workspace.ts";
import type { ManagedRecord, ManagedSessionStore } from "./managed-sessions.ts";
import { ManagedError, type CandidateRef } from "./session-contracts.ts";
import { inspectWorkerInputs, initialWorkerInputs, prepareWorkerInputs, refreshWorkerInputs, type WorkerInputState } from "./worker-inputs.ts";
import type { FileState } from "./workspace.ts";

/** Empty maps on v3; retained solely for validating legacy registry records. */
export interface SavedWorkspace { baseline: Record<string, FileState>; parentBaseline: Record<string, FileState>; inputs: WorkerInputState }
const sourcePath = (store: ManagedSessionStore, record: ManagedRecord) => join(store.path(record.handle), "source");
function writable(record: ManagedRecord): void { if (record.version !== 3) throw new ManagedError("legacy_session_read_only"); }
function workspaceOf(record: ManagedRecord) {
	writable(record);
	const workspace = record.workspace?.inputs.gitWorkspace;
	if (!workspace || workspace.repo !== record.owner.repo) throw new ManagedError("managed_workspace_missing");
	return workspace;
}

/** Admission normally pins input before receipt; direct callers receive the same fixed input. */
export async function prepareManagedWorkspace(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	writable(record);
	if (record.workspace) {
		if (workspaceOf(record).path !== sourcePath(store, record)) throw new ManagedError("managed_workspace_mismatch");
		await inspectWorkerInputs(sourcePath(store, record), record.workspace.inputs);
		return;
	}
	if (record.task.writePaths.some(file => file === ".git" || file.startsWith(".git/"))) throw new ManagedError("managed_git_write_forbidden");
	if (!record.input) record.input = await captureGitInput(record.owner.repo);
	if (!record.inputRef) record.inputRef = await retainGitInput(record.owner.repo, record.handle, record.input);
	await store.save(record);
	const gitWorkspace = await createGitTaskWorkspace(record.owner.repo, sourcePath(store, record), record.input);
	try {
		record.workspace = { baseline: {}, parentBaseline: {}, inputs: initialWorkerInputs(gitWorkspace) };
		await store.save(record); // Keep exact Git ownership before expensive dependency preparation.
		const inputs = await prepareWorkerInputs(record.owner.repo, gitWorkspace.path, gitWorkspace, record.task.role === "worker");
		record.workspace = { baseline: {}, parentBaseline: {}, inputs };
		await store.save(record);
	} catch (error) {
		// Retain a registered workspace on preparation failure for explicit inspect/close.
		record.state = "interrupted"; await store.save(record); throw error;
	}
}

/** Explicit refresh, never a side effect of continue or apply. Conflicts retain all bases. */
export async function syncManagedInputs(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	const workspace = workspaceOf(record);
	if (record.state !== "idle") throw new ManagedError("session_not_idle");
	if (record.candidate && ["applying", "partial", "unknown"].includes(record.candidate.status)) throw new ManagedError("candidate_recovery_required");
	const result = await refreshGitInputs(workspace);
	await store.save(record);
	if (result.status === "conflict") throw new ManagedError("convergence_conflict");
	try {
		record.workspace!.inputs = await refreshWorkerInputs(record.owner.repo, workspace.path, record.workspace!.inputs);
		delete record.candidate;
		await store.save(record);
	} catch (error) { record.state = "interrupted"; await store.save(record); throw error; }
}

export async function freezeCandidate(store: ManagedSessionStore, record: ManagedRecord): Promise<CandidateRef | undefined> {
	const workspace = workspaceOf(record);
	if (!record.result?.reportComplete || record.result.status !== "succeeded") throw new ManagedError("candidate_report_incomplete");
	await inspectWorkerInputs(workspace.path, record.workspace!.inputs);
	const git = await freezeGitCandidate(workspace);
	if (git.changedPaths.length) record.candidate = { id: `candidate_${git.id}`, episode: record.episode, status: "not-applied", changedPaths: git.changedPaths, appliedPaths: [], git };
	else delete record.candidate;
	// Finalization commits candidate and execution outcome together; never expose an interim applicable candidate.
	return record.candidate;
}

export async function applyCandidate(store: ManagedSessionStore, record: ManagedRecord, candidateId: string): Promise<CandidateRef> {
	const workspace = workspaceOf(record); const candidate = record.candidate;
	if (workspace.path !== sourcePath(store, record) || !candidate?.git || candidate.id !== candidateId || candidate.id !== `candidate_${candidate.git.id}` || candidate.episode !== record.episode) throw new ManagedError("candidate_mismatch");
	if (candidate.status === "applied") return candidate;
	if (["applying", "partial", "unknown"].includes(candidate.status)) throw new ManagedError("candidate_recovery_required");
	candidate.status = "applying"; await store.save(record);
	try {
		const result = await applyGitCandidate(workspace, candidate.git);
		candidate.status = result.status === "applied" ? "applied" : "conflict";
		if (result.status === "applied") candidate.appliedPaths = [...result.changedPaths];
		await store.save(record);
		return candidate;
	} catch (error) { candidate.status = "unknown"; await store.save(record); throw error; }
}
