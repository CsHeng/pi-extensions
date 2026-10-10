import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import { pathContains, type TaskRoot } from "./access.ts";
import {
	isSafePathGrammar,
	type TaskError,
} from "./contracts.ts";
import { mintProductId } from "./identity.ts";
import type { NormalizedTask } from "./graph.ts";
import { runReadGit } from "./git-workspace.ts";

export interface RepositoryTarget {
	declared: string;
	root: string;
	identities: Array<{ path: string; dev: number; ino: number }>;
}

/** Explicit target selection is not authority; pin the worktree and Git administration identities. */
export async function captureRepositoryTarget(declared: string): Promise<RepositoryTarget> {
	if (!isAbsolute(declared) || !isSafePathGrammar(declared)) throw new RepositoryPolicyError("invalid_task_repository", "Worker repository must name an authorized absolute Git worktree root.");
	try {
		const root = await findCanonicalGitRoot(declared);
		if (await realpath(declared) !== root && declared !== root) throw new Error("not the repository root");
		const gitDir = await realpath((await runReadGit(root, ["rev-parse", "--absolute-git-dir"])).stdout.toString().trim());
		const commonDir = await realpath(resolve(root, (await runReadGit(root, ["rev-parse", "--git-common-dir"])).stdout.toString().trim()));
		const identities = await Promise.all([root, gitDir, commonDir].map(async path => {
			const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a physical directory");
			return { path, dev: info.dev, ino: info.ino };
		}));
		return { declared, root, identities };
	} catch { throw new RepositoryPolicyError("task_repository_unavailable", "The selected worker repository is not an accessible Git worktree root."); }
}

export async function validateRepositoryTarget(target: RepositoryTarget | undefined): Promise<void> {
	if (!target) return; // Existing v3 records retain their original parent-root binding.
	try {
		const current = await captureRepositoryTarget(target.declared);
		if (current.root !== target.root || current.identities.length !== target.identities.length || current.identities.some((pin, index) => {
			const before = target.identities[index]; return !before || pin.path !== before.path || pin.dev !== before.dev || pin.ino !== before.ino;
		})) throw new Error("changed identity");
	} catch { throw new RepositoryPolicyError("task_repository_changed", "The pinned worker repository identity changed; do not redirect this session to another checkout."); }
}

export class RepositoryPolicyError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RepositoryPolicyError";
		this.code = code;
	}
}

export interface RepositoryHost {
	findGitToplevel(cwd: string): Promise<string>;
	realpath(path: string): Promise<string>;
	lstat(path: string): Promise<Stats>;
}

export type RepositoryAdmission =
	| { ok: true; gitRoot: string; tasks: NormalizedTask[] }
	| { ok: false; error: TaskError };

const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

async function runGitShowToplevel(cwd: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output: Buffer[] = [];
		let size = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= GIT_OUTPUT_LIMIT) output.push(chunk);
			else child.kill("SIGTERM");
		});
		child.stderr.resume();
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0 && size <= GIT_OUTPUT_LIMIT) {
				resolvePromise(Buffer.concat(output).toString("utf8").trim());
				return;
			}
			reject(new Error("git toplevel unavailable"));
		});
	});
}

export const defaultRepositoryHost: RepositoryHost = {
	findGitToplevel: runGitShowToplevel,
	realpath,
	lstat,
};

export function physicallyContains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function toRepositoryRelative(gitRoot: string, absolute: string): string {
	const relation = relative(gitRoot, absolute);
	return relation === "" ? "." : relation;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isSpecialFile(info: Stats): boolean {
	return info.isSocket() || info.isFIFO() || info.isCharacterDevice() || info.isBlockDevice();
}

async function nearestExisting(target: string, host: RepositoryHost): Promise<string> {
	let current = target;
	while (true) {
		try {
			await host.lstat(current);
			return current;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			const parent = resolve(current, "..");
			if (parent === current) throw error;
			current = parent;
		}
	}
}

export async function findCanonicalGitRoot(
	cwd: string,
	host: RepositoryHost = defaultRepositoryHost,
): Promise<string> {
	try {
		const toplevel = await host.findGitToplevel(cwd);
		if (!toplevel) throw new Error("git toplevel unavailable");
		return await host.realpath(toplevel);
	} catch {
		throw new RepositoryPolicyError(
			"repository_root_unavailable",
			"The current working directory is not an accessible Git worktree.",
		);
	}
}

export async function canonicalizeInternalScope(
	gitRoot: string,
	entry: string,
	host: RepositoryHost = defaultRepositoryHost,
): Promise<string> {
	if (!isSafePathGrammar(entry)) {
		throw new RepositoryPolicyError("invalid_scope", "A scope entry is empty, overlong, or contains a disallowed control character.");
	}
	const resolved = isAbsolute(entry) ? resolve(entry) : resolve(gitRoot, entry);
	if (!physicallyContains(gitRoot, resolved)) {
		throw new RepositoryPolicyError("scope_outside_repository", "A scope entry resolves outside the current Git repository.");
	}
	const existing = await nearestExisting(resolved, host);
	const physicalExisting = await host.realpath(existing);
	if (!physicallyContains(gitRoot, physicalExisting)) {
		throw new RepositoryPolicyError("scope_outside_repository", "A scope entry resolves outside the current Git repository.");
	}
	try {
		await host.lstat(resolved);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		const missing = toRepositoryRelative(gitRoot, resolved);
		if (!isSafePathGrammar(missing)) {
			throw new RepositoryPolicyError("invalid_scope", "A scope entry cannot be normalized to a safe repository-relative path.");
		}
		return missing;
	}
	const physicalTarget = await host.realpath(resolved);
	if (!physicallyContains(gitRoot, physicalTarget)) {
		throw new RepositoryPolicyError("scope_outside_repository", "A scope entry resolves outside the current Git repository.");
	}
	const relativePath = toRepositoryRelative(gitRoot, physicalTarget);
	if (!isSafePathGrammar(relativePath)) {
		throw new RepositoryPolicyError("invalid_scope", "A scope entry cannot be normalized to a safe repository-relative path.");
	}
	return relativePath;
}

export async function canonicalizeExternalReadRoot(
	gitRoot: string,
	entry: string,
	host: RepositoryHost = defaultRepositoryHost,
): Promise<string> {
	if (!isSafePathGrammar(entry) || !isAbsolute(entry)) {
		throw new RepositoryPolicyError("invalid_external_read_root", "An external read root must be an absolute safe path.");
	}
	let physical: string;
	try {
		const info = await host.lstat(entry);
		if (isSpecialFile(info)) {
			throw new RepositoryPolicyError("external_read_root_unavailable", "An external read root is missing, inaccessible, special, or not inside a Git worktree.");
		}
		physical = await host.realpath(entry);
		if (!isSafePathGrammar(physical)) {
			throw new RepositoryPolicyError("invalid_external_read_root", "An external read root must canonicalize to an absolute safe path.");
		}
		const physicalInfo = await host.lstat(physical);
		if (!physicalInfo.isFile() && !physicalInfo.isDirectory()) {
			throw new RepositoryPolicyError("external_read_root_unavailable", "An external read root is missing, inaccessible, special, or not inside a Git worktree.");
		}
	} catch (error) {
		if (error instanceof RepositoryPolicyError) throw error;
		throw new RepositoryPolicyError("external_read_root_unavailable", "An external read root is missing, inaccessible, or special.");
	}
	if (physicallyContains(gitRoot, physical)) {
		throw new RepositoryPolicyError("external_read_root_not_external", "An external read root is inside the current repository; use scope instead.");
	}
	return physical;
}

function retarget(code: string, taskId: string): string {
	if (code === "invalid_access") return `Task ${taskId} access must use absolute paths or a bounded all-selector.`;
	if (code === "unbounded_scope") return `Task ${taskId} used * without an explicit finite enclosing scope.`;
	if (code === "non_git_write_unsupported") return `Task ${taskId} write grant is not inside a Git repository. This host applies Git candidates only; name a Git path or keep that range read-only.`;
	if (code === "repository_root_unavailable") return `Task ${taskId} access path is not in an accessible Git worktree.`;
	if (code === "access_unavailable") return `Task ${taskId} access path is missing, inaccessible, or special.`;
	if (code === "invalid_task_repository" || code === "task_repository_unavailable") return `Task ${taskId} write root is not an accessible Git worktree root.`;
	return "The current working directory is not an accessible Git worktree.";
}

function failAdmission(code: string, taskId?: string): RepositoryAdmission {
	return {
		ok: false,
		error: {
			code,
			message: taskId === undefined ? retarget(code, "") : retarget(code, taskId),
		},
	};
}

async function pinPath(path: string, host: RepositoryHost): Promise<{ path: string; dev: number; ino: number }> {
	const info = await host.lstat(path);
	if (isSpecialFile(info)) throw new RepositoryPolicyError("access_unavailable", "An access path is missing, inaccessible, or special.");
	// A symlink grant is pinned by its own identity so a later retarget is visible.
	if (info.isSymbolicLink()) return { path, dev: info.dev, ino: info.ino };
	if (!info.isFile() && !info.isDirectory()) throw new RepositoryPolicyError("access_unavailable", "An access path is missing, inaccessible, or special.");
	const physical = await host.realpath(path);
	if (physical !== path) throw new RepositoryPolicyError("invalid_access", "An access path must already be canonical.");
	return { path, dev: info.dev, ino: info.ino };
}

async function locateGrant(path: string, host: RepositoryHost): Promise<{ declared: string; existing: string; info: Awaited<ReturnType<RepositoryHost["lstat"]>>; missing: boolean }> {
	let current = path;
	for (;;) {
		try {
			return { declared: path, existing: current, info: await host.lstat(current), missing: current !== path };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw new RepositoryPolicyError("access_unavailable", "An access path is missing, inaccessible, or special.");
			current = parent;
		}
	}
}

/** Resolve one task's access grants into Git write roots and read evidence. Does not copy or mutate. */
export async function resolveTaskRoots(task: NormalizedTask, host: RepositoryHost = defaultRepositoryHost): Promise<TaskRoot[]> {
	const writeRoots = new Map<string, TaskRoot>();
	const reads: TaskRoot[] = [];
	for (const grant of task.grants) {
		let located: Awaited<ReturnType<typeof locateGrant>>;
		try { located = await locateGrant(grant.path, host); }
		catch (error) {
			if (error instanceof RepositoryPolicyError) throw error;
			throw new RepositoryPolicyError("access_unavailable", "An access path is missing, inaccessible, or special.");
		}
		const info = located.info;
		if (!located.missing && !info.isSymbolicLink() && info.isFile() === false && info.isDirectory() === false) throw new RepositoryPolicyError("access_unavailable", "An access path is missing, inaccessible, or special.");
		const pin = located.missing ? { path: located.existing, dev: info.dev, ino: info.ino } : await pinPath(grant.path, host);
		const probe = info.isSymbolicLink() || info.isDirectory() ? located.existing : dirname(located.existing);
		let gitRoot: string | undefined;
		try { gitRoot = await findCanonicalGitRoot(probe, host); }
		catch { gitRoot = undefined; }
		const physicalGrant = info.isSymbolicLink() ? await host.realpath(grant.path) : grant.path;
		if (grant.permission === "write") {
			if (!gitRoot || !(pathContains(gitRoot, grant.path) || pathContains(gitRoot, physicalGrant))) throw new RepositoryPolicyError("non_git_write_unsupported", "A write grant must be inside a Git repository.");
			const existing = writeRoots.get(gitRoot);
			const relativePath = toRepositoryRelative(gitRoot, pathContains(gitRoot, grant.path) ? grant.path : physicalGrant);
			if (!isSafePathGrammar(relativePath)) throw new RepositoryPolicyError("invalid_access", "A write path cannot be normalized inside its Git root.");
			if (existing) existing.paths.push(relativePath);
			else {
				const target = await captureRepositoryTarget(info.isSymbolicLink() ? grant.path : gitRoot);
				writeRoots.set(gitRoot, { id: mintProductId(), source: gitRoot, permission: "write", git: true, paths: [relativePath], target });
			}
			continue;
		}
		if (gitRoot && pathContains(gitRoot, grant.path)) {
			const relativePath = toRepositoryRelative(gitRoot, grant.path);
			const existing = reads.find((item) => item.source === gitRoot);
			if (existing) { existing.paths.push(relativePath); existing.pins?.push(pin); }
			else reads.push({ id: mintProductId(), source: gitRoot, permission: "read", git: true, paths: [relativePath], pins: [pin] });
		} else reads.push({ id: mintProductId(), source: grant.path, permission: "read", git: false, paths: [grant.path], pins: [pin] });
	}
	return [...writeRoots.values(), ...reads];
}

export async function admitRepositoryTasks(
	cwd: string,
	tasks: readonly NormalizedTask[],
	host: RepositoryHost = defaultRepositoryHost,
): Promise<RepositoryAdmission> {
	let gitRoot = cwd;
	try { gitRoot = await findCanonicalGitRoot(cwd, host); } catch { /* Access paths name their own roots; cwd is only a fallback label. */ }
	const admitted: NormalizedTask[] = [];
	for (const task of tasks) {
		try {
			admitted.push({ ...task, roots: await resolveTaskRoots(task, host) });
		} catch (error) {
			return failAdmission(error instanceof RepositoryPolicyError ? error.code : "invalid_access", task.id);
		}
	}
	return { ok: true, gitRoot, tasks: admitted };
}


