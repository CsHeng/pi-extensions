import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { destinationKey, withDestinationLocks } from "./destination-lock.ts";
import { captureGitInput, createGitTaskWorkspace, discardGitInput, discardGitWorkspace, freezeGitCandidate, planGitApply, reconcileGitAttempt, applyGitAttempt, refreshGitInputs, retainGitInput, inspectGitInput, validateGitCandidate, applicableGitAttempt } from "./git-workspace.ts";
import { mintProductId } from "./identity.ts";
import { managedWriteRoots, type ManagedRecord, type ManagedRootState, type ManagedSessionStore } from "./managed-sessions.ts";
import { validateRepositoryTarget } from "./repository-policy.ts";
import { ManagedError, type ApplyStatus, type CandidateRef, type CandidateRootStatus } from "./session-contracts.ts";
import { inspectWorkerInputs, prepareWorkerInputs, refreshWorkerInputs } from "./worker-inputs.ts";

const rootPath = (store: ManagedSessionStore, record: ManagedRecord, root: ManagedRootState) => join(store.path(record.handle), "roots", root.id);

function writable(record: ManagedRecord): void {
	if (record.version !== 4) throw new ManagedError("unsupported_contract");
}

function aggregate(statuses: readonly ApplyStatus[]): ApplyStatus {
	if (statuses.length === 0) return "not-applied";
	if (statuses.every((status) => status === "applied")) return "applied";
	if (statuses.some((status) => status === "unknown")) return statuses.some((status) => status === "applied") ? "partial" : "unknown";
	if (statuses.some((status) => status === "applied")) return "partial";
	if (statuses.some((status) => status === "conflict")) return "conflict";
	if (statuses.some((status) => status === "applying")) return "applying";
	return "not-applied";
}

function ownedPath(rootId: string, path: string): string {
	return `${rootId}/${path}`;
}
function bundle(record: ManagedRecord, roots: CandidateRootStatus[]): CandidateRef {
	return {
		id: record.candidate?.id ?? mintProductId(),
		episode: record.episode,
		status: aggregate(roots.map((root) => root.status)),
		changedPaths: roots.flatMap((root) => root.changedPaths.map((path) => ownedPath(root.rootId, path))),
		appliedPaths: roots.flatMap((root) => root.appliedPaths.map((path) => ownedPath(root.rootId, path))),
		roots,
	};
}
export function grantCovers(selected: readonly string[], changed: string): boolean {
	return selected.some((grant) => {
		if (grant === "." || grant === "") return true;
		const normalized = grant.replace(/\/$/, "");
		return changed === normalized || changed.startsWith(`${normalized}/`);
	});
}

export async function prepareManagedWorkspace(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	writable(record);
	for (const root of managedWriteRoots(record)) {
		if (root.released) throw new ManagedError("managed_workspace_missing");
		await validateRepositoryTarget(root.target);
		if (root.paths.some((file) => file === ".git" || file.startsWith(".git/"))) throw new ManagedError("managed_git_write_forbidden");
		if (root.inputs?.gitWorkspace) {
			if (root.inputs.gitWorkspace.path !== rootPath(store, record, root)) throw new ManagedError("managed_workspace_mismatch");
			await inspectWorkerInputs(root.inputs.gitWorkspace.path, root.inputs);
			continue;
		}
		if (!root.input) root.input = await captureGitInput(root.source);
		if (!root.inputRef) root.inputRef = await retainGitInput(root.source, root.id, root.input);
		else await inspectGitInput(root.source, root.inputRef, root.input);
		await store.save(record);
		const gitWorkspace = await createGitTaskWorkspace(root.source, rootPath(store, record, root), root.input);
		root.inputs = { version: 2, gitWorkspace };
		await store.save(record);
		try {
			root.inputs = await prepareWorkerInputs(root.source, gitWorkspace.path, gitWorkspace);
			await store.save(record);
		} catch (error) {
			record.state = "interrupted";
			await store.save(record);
			throw error;
		}
	}
}

export async function syncManagedInputs(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	writable(record);
	if (record.state !== "idle") throw new ManagedError("session_not_idle");
	if (record.candidate && ["applying", "partial", "unknown"].includes(record.candidate.status)) throw new ManagedError("candidate_recovery_required");
	for (const root of managedWriteRoots(record)) {
		await validateRepositoryTarget(root.target);
		const workspace = root.inputs?.gitWorkspace;
		if (!workspace) throw new ManagedError("managed_workspace_missing");
		const result = await refreshGitInputs(workspace);
		await store.save(record);
		if (result.status === "conflict") throw new ManagedError("convergence_conflict");
		root.inputs = await refreshWorkerInputs(root.source, workspace.path, root.inputs!);
	}
	delete record.candidate;
	await store.save(record);
}

export async function freezeCandidate(store: ManagedSessionStore, record: ManagedRecord): Promise<CandidateRef | undefined> {
	writable(record);
	if (!record.result?.reportComplete || record.result.status !== "succeeded") throw new ManagedError("candidate_report_incomplete");
	const roots: CandidateRootStatus[] = [];
	for (const root of managedWriteRoots(record)) {
		await validateRepositoryTarget(root.target);
		const workspace = root.inputs?.gitWorkspace;
		if (!workspace) throw new ManagedError("managed_workspace_missing");
		await inspectWorkerInputs(workspace.path, root.inputs!);
		const git = await freezeGitCandidate(workspace);
		const outside = git.changedPaths.filter((path) => !grantCovers(root.paths, path));
		if (outside.length) throw new ManagedError("candidate_outside_grant");
		if (git.changedPaths.length) roots.push({ rootId: root.id, destination: root.source, status: "not-applied", changedPaths: git.changedPaths, appliedPaths: [], git });
	}
	if (roots.length) record.candidate = bundle(record, roots);
	else delete record.candidate;
	return record.candidate;
}

export async function applyCandidate(store: ManagedSessionStore, record: ManagedRecord, candidateId: string): Promise<CandidateRef> {
	writable(record);
	const candidate = record.candidate;
	if (!candidate || candidate.id !== candidateId || candidate.episode !== record.episode) throw new ManagedError("candidate_mismatch");
	if (candidate.status === "applied") return candidate;
	const keys: string[] = [];
	for (const root of candidate.roots) {
		const binding = record.roots.find((item) => item.id === root.rootId);
		if (!binding?.target) throw new ManagedError("candidate_mismatch");
		await validateRepositoryTarget(binding.target);
		const identity = binding.target.identities[0];
		if (!identity) throw new ManagedError("candidate_mismatch");
		keys.push(destinationKey(identity.dev, identity.ino, binding.source));
	}
	const sync = () => {
		candidate.status = aggregate(candidate.roots.map((root) => root.status));
		candidate.appliedPaths = candidate.roots.flatMap((root) => root.appliedPaths.map((path) => ownedPath(root.rootId, path)));
	};
	await withDestinationLocks(keys, async () => {
		// Re-validate every pinned destination identity inside the locks before any mutation.
		for (const root of candidate.roots) {
			const binding = record.roots.find((item) => item.id === root.rootId);
			if (!binding?.target) throw new ManagedError("candidate_mismatch");
			await validateRepositoryTarget(binding.target);
		}
		// Whole-bundle non-destructive preflight: every pending candidate, workspace binding and
		// stored grant constraint is validated before the first destination mutation.
		for (const root of candidate.roots) {
			if (root.status === "applied") continue;
			const binding = record.roots.find((item) => item.id === root.rootId);
			const workspace = binding?.inputs?.gitWorkspace;
			if (!binding || !workspace || !root.git || workspace.path !== rootPath(store, record, binding)) throw new ManagedError("candidate_mismatch");
			try { await validateGitCandidate(workspace, root.git); }
			catch (error) { if (error instanceof ManagedError) throw error; throw new ManagedError("candidate_mismatch"); }
			const outside = (paths: readonly string[]) => paths.some((path) => !grantCovers(binding.paths, path));
			if (outside(root.git.changedPaths)) throw new ManagedError("candidate_outside_grant");
			if (root.attempt && outside(root.attempt.paths)) throw new ManagedError("candidate_outside_grant");
		}
		for (const root of candidate.roots) {
			if (root.status === "applied") continue;
			const binding = record.roots.find((item) => item.id === root.rootId);
			const workspace = binding?.inputs?.gitWorkspace;
			if (!binding || !workspace || !root.git || workspace.path !== rootPath(store, record, binding)) throw new ManagedError("candidate_mismatch");
			const outside = (paths: readonly string[]) => paths.some((path) => !grantCovers(binding.paths, path));
			if (root.attempt && applicableGitAttempt(root.attempt)) {
				// Only a clean plan is journaled; a stored attempt is always an applicable merge result.
				const observed = await reconcileGitAttempt(workspace.repo, root.attempt);
				if (observed === "unknown") { root.status = "unknown"; sync(); await store.save(record); throw new ManagedError("candidate_apply_unknown"); }
				if (observed === "applied") { root.status = "applied"; root.appliedPaths = [...root.attempt.paths]; sync(); await store.save(record); continue; }
			} else {
				// A missing or non-applicable attempt (for example a legacy conflict-marker tree) is
				// never reconciled or executed; recompute the plan from the current destination.
				delete root.attempt;
				// The checkpoint persists the integration ref before planning returns; a later
				// interruption can still release it and never treats a conflict as applicable.
				const plan = await planGitApply(workspace, root.git, async () => { await store.save(record); });
				if (plan.status === "conflict") {
					// Never journal or execute conflict-marker trees as an applicable patch.
					root.status = "conflict";
					sync();
					await store.save(record);
					continue;
				}
				root.attempt = plan.attempt;
				await store.save(record);
				if (outside(plan.attempt.paths)) throw new ManagedError("candidate_outside_grant");
			}
			root.status = "applying";
			sync();
			try {
				await store.save(record);
				await applyGitAttempt(workspace.repo, root.attempt!);
				root.status = "applied";
				root.appliedPaths = [...root.attempt!.paths];
				sync();
				await store.save(record);
			} catch (error) {
				if (error instanceof ManagedError && error.code === "candidate_outside_grant") throw error;
				root.status = "unknown";
				sync();
				try { await store.save(record); } catch { /* Keep the unknown fact even if the second save fails. */ }
				throw new ManagedError("candidate_apply_unknown");
			}
		}
	});
	return candidate;
}

/** Release owned worktrees, refs and scratch. Applied parent changes and other owners stay untouched. */
export async function releaseManagedResources(store: ManagedSessionStore, record: ManagedRecord): Promise<void> {
	writable(record);
	for (const root of record.roots) if (root.target) await validateRepositoryTarget(root.target);
	const remaining: string[] = [];
	for (const root of record.roots) {
		if (root.released) continue;
		try {
			if (root.inputs?.gitWorkspace && (Object.keys(root.inputs.gitWorkspace.ownedRefs).length || Object.keys(root.inputs.gitWorkspace.pendingRefs ?? {}).length || !root.workspaceReleased)) {
				await discardGitWorkspace(root.inputs.gitWorkspace);
				if (Object.keys(root.inputs.gitWorkspace.ownedRefs).length || Object.keys(root.inputs.gitWorkspace.pendingRefs ?? {}).length) throw new Error("owned refs remain");
				root.workspaceReleased = true;
				delete root.inputs;
				await store.save(record);
			}
			if (root.inputRef && root.input) {
				await discardGitInput(root.source, root.inputRef, root.input);
				delete root.inputRef;
				await store.save(record);
			}
			root.released = true;
			await store.save(record);
		} catch {
			remaining.push(root.id);
		}
	}
	const scratch = join(store.path(record.handle), "scratch");
	try {
		await lstat(scratch);
		const { rm } = await import("node:fs/promises");
		await rm(scratch, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") remaining.push("scratch");
	}
	record.release = { status: remaining.length ? "partial" : "complete", remaining };
	record.retained = remaining.length > 0;
	await store.save(record);
	if (remaining.length) throw new ManagedError("cleanup_partial", undefined, remaining.join(","));
}
