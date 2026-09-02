import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HandoffErrorCode, HandoffMode, WorkspaceStatus } from "./contracts.ts";

export class WorkspaceError extends Error {
	readonly code: HandoffErrorCode;

	constructor(code: HandoffErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceError";
		this.code = code;
	}
}

export interface GitIdentity {
	worktreeRoot: string;
	commonDir: string;
	head?: string;
	unborn: boolean;
	indexDigest: string;
}

export interface FileState {
	kind: "file" | "symlink" | "directory" | "other" | "absent";
	mode?: number;
	digest?: string;
}

export interface StatusEntry {
	path: string;
	rename?: boolean;
}

export interface WorkspaceBaseline {
	identity: GitIdentity;
	status: StatusEntry[];
	files: Map<string, FileState>;
	allowedWrites: string[];
}

export interface PostflightResult {
	status: WorkspaceStatus;
	changedPaths: string[];
	violations: string[];
	error?: { code: HandoffErrorCode; message: string };
}

const WRITE_INVALID = "Write path is invalid.";
const NOT_GIT = "Workspace is not a Git checkout.";
const MISMATCH = "Workspace does not match the trusted repository.";
const DIRTY = "Workspace is dirty.";
const ISOLATION = "Transfer requires an isolated linked worktree.";
const BASELINE = "Workspace baseline is unavailable.";
const SCOPE = "Workspace changes exceeded declared writes.";
const HISTORY = "Git history changed.";
const INDEX = "Git index changed.";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function contains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function digest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function gitEnv(cwd: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	delete env.GIT_COMMON_DIR;
	env.PWD = cwd;
	return env;
}

async function runGit(cwd: string, args: string[]): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", args, { cwd, env: gitEnv(cwd), shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let size = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= 32 * 1024 * 1024) output.push(chunk);
			else child.kill("SIGTERM");
		});
		child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0 && size <= 32 * 1024 * 1024) resolvePromise(Buffer.concat(output));
			else reject(new WorkspaceError("baseline_unavailable", BASELINE));
		});
	});
}

async function fileState(path: string): Promise<FileState> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) return { kind: "symlink", mode: info.mode & 0o777 };
		if (info.isDirectory()) return { kind: "directory", mode: info.mode & 0o777 };
		if (!info.isFile()) return { kind: "other", mode: info.mode & 0o777 };
		return { kind: "file", mode: info.mode & 0o777, digest: digest(await readFile(path)) };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "absent" };
		throw error;
	}
}

function sameState(left: FileState, right: FileState): boolean {
	return left.kind === right.kind && left.mode === right.mode && left.digest === right.digest;
}

export function normalizeWritePath(path: string): string {
	if (path.includes("\0") || isAbsolute(path) || path.length < 1) {
		throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
	}
	const parts = path.split(/[\\/]/);
	if (parts.some((part) => part === "" || part === "." || part === "..")) {
		throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
	}
	return parts.join("/");
}

async function assertNoSymlinkComponent(root: string, target: string): Promise<void> {
	const relation = relative(root, target);
	if (relation.startsWith("..") || isAbsolute(relation)) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
	let current = root;
	for (const component of relation.split(sep)) {
		if (!component) continue;
		current = join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}
	}
}

export async function resolveGitIdentity(cwd: string): Promise<GitIdentity> {
	try {
		const toplevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
		const commonRaw = (await runGit(cwd, ["rev-parse", "--git-common-dir"])).toString("utf8").trim();
		const worktreeRoot = await realpath(toplevel);
		const commonDir = await realpath(resolve(cwd, commonRaw));
		let head: string | undefined;
		let unborn = false;
		try {
			head = (await runGit(cwd, ["rev-parse", "HEAD"])).toString("utf8").trim();
		} catch {
			unborn = true;
		}
		const indexDigest = digest(await runGit(cwd, ["ls-files", "-s", "-z"]));
		return { worktreeRoot, commonDir, ...(head === undefined ? {} : { head }), unborn, indexDigest };
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError("workspace_not_git", NOT_GIT, { cause: error });
	}
}

export async function porcelainStatus(cwd: string): Promise<StatusEntry[]> {
	const raw = await runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
	const records = raw.toString("utf8").split("\0").filter(Boolean);
	const entries: StatusEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] as string;
		if (record.startsWith("1 ")) {
			const path = record.split(" ").slice(8).join(" ");
			if (path) entries.push({ path });
			continue;
		}
		if (record.startsWith("2 ")) {
			const path = record.split(" ").slice(9).join(" ");
			const original = records[index + 1];
			index += 1;
			entries.push({ path, rename: true });
			if (original) entries.push({ path: original, rename: true });
			continue;
		}
		if (record.startsWith("? ") || record.startsWith("! ") || record.startsWith("u ")) {
			entries.push({ path: record.slice(2) });
		}
	}
	return entries;
}

export async function isClean(cwd: string): Promise<boolean> {
	return (await porcelainStatus(cwd)).length === 0;
}

export async function validateAllowedWrites(worktreeRoot: string, allowedWrites: readonly string[]): Promise<string[]> {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const entry of allowedWrites) {
		const path = normalizeWritePath(entry);
		if (seen.has(path)) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
		seen.add(path);
		const absolute = resolve(worktreeRoot, path);
		if (!contains(worktreeRoot, absolute)) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
		await assertNoSymlinkComponent(worktreeRoot, absolute);
		const state = await fileState(absolute);
		if (state.kind === "directory" || state.kind === "symlink" || state.kind === "other") {
			throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
		}
		if (state.kind === "absent") {
			const parent = dirname(absolute);
			try {
				const parentInfo = await lstat(parent);
				if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
				const physicalParent = await realpath(parent);
				if (!contains(await realpath(worktreeRoot), physicalParent)) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
			} catch (error) {
				if (error instanceof WorkspaceError) throw error;
				throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
			}
		} else {
			const physical = await realpath(absolute);
			if (!contains(await realpath(worktreeRoot), physical)) throw new WorkspaceError("invalid_write_path", WRITE_INVALID);
		}
		normalized.push(path);
	}
	return normalized;
}

export async function validateRecipientWorktree(parentCwd: string, recipientCwd: string, mode: HandoffMode): Promise<{ parent: GitIdentity; recipient: GitIdentity }> {
	const parent = await resolveGitIdentity(parentCwd);
	const recipient = await resolveGitIdentity(recipientCwd);
	if (parent.commonDir !== recipient.commonDir) throw new WorkspaceError("workspace_mismatch", MISMATCH);
	if (parent.worktreeRoot === recipient.worktreeRoot) throw new WorkspaceError("workspace_mismatch", MISMATCH);
	if (mode === "transfer") {
		if (!(await isClean(recipientCwd))) throw new WorkspaceError("workspace_dirty", DIRTY);
		if (parent.worktreeRoot === recipient.worktreeRoot) throw new WorkspaceError("transfer_requires_isolation", ISOLATION);
	}
	return { parent, recipient };
}

export async function assertManagedParent(parentCwd: string): Promise<GitIdentity> {
	const identity = await resolveGitIdentity(parentCwd);
	if (identity.unborn) throw new WorkspaceError("workspace_not_git", NOT_GIT);
	if (!(await isClean(parentCwd))) throw new WorkspaceError("workspace_dirty", DIRTY);
	return identity;
}

export async function validateCreatedWorktree(parent: GitIdentity, checkoutPath: string, isLinkedWorktree: boolean): Promise<GitIdentity> {
	if (!isLinkedWorktree) throw new WorkspaceError("transfer_requires_isolation", ISOLATION);
	const recipient = await resolveGitIdentity(checkoutPath);
	if (recipient.commonDir !== parent.commonDir || recipient.worktreeRoot === parent.worktreeRoot) {
		throw new WorkspaceError("workspace_mismatch", MISMATCH);
	}
	return recipient;
}

export async function captureBaseline(cwd: string, allowedWrites: readonly string[]): Promise<WorkspaceBaseline> {
	const identity = await resolveGitIdentity(cwd);
	const normalized = await validateAllowedWrites(identity.worktreeRoot, allowedWrites);
	let status: StatusEntry[];
	try {
		status = await porcelainStatus(cwd);
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError("baseline_unavailable", BASELINE);
	}
	const files = new Map<string, FileState>();
	const paths = new Set([...normalized, ...status.map((entry) => entry.path)]);
	for (const path of paths) {
		files.set(path, await fileState(resolve(identity.worktreeRoot, path)));
	}
	return { identity, status, files, allowedWrites: normalized };
}

function classifyDelta(before: FileState, after: FileState, allowed: boolean, preexistingDirty: boolean): HandoffErrorCode | undefined {
	if (sameState(before, after)) return undefined;
	if (!allowed) return preexistingDirty ? "scope_violation" : "scope_violation";
	if (after.kind === "absent") return "scope_violation";
	if (after.kind !== "file") return "scope_violation";
	if (before.kind === "file" && before.mode !== after.mode) return "scope_violation";
	if (before.kind !== "file" && before.kind !== "absent") return "scope_violation";
	return undefined;
}

export async function inspectPostflight(baseline: WorkspaceBaseline, cwd: string): Promise<PostflightResult> {
	let current: GitIdentity;
	let status: StatusEntry[];
	try {
		current = await resolveGitIdentity(cwd);
		status = await porcelainStatus(cwd);
	} catch {
		return { status: "unavailable", changedPaths: [], violations: ["unavailable"], error: { code: "baseline_unavailable", message: BASELINE } };
	}
	if (current.commonDir !== baseline.identity.commonDir || current.worktreeRoot !== baseline.identity.worktreeRoot) {
		return { status: "unavailable", changedPaths: [], violations: ["workspace"], error: { code: "workspace_mismatch", message: MISMATCH } };
	}
	if (current.unborn !== baseline.identity.unborn || current.head !== baseline.identity.head) {
		return { status: "history_changed", changedPaths: [], violations: ["HEAD"], error: { code: "history_changed", message: HISTORY } };
	}
	if (current.indexDigest !== baseline.identity.indexDigest) {
		return { status: "history_changed", changedPaths: [], violations: ["index"], error: { code: "index_changed", message: INDEX } };
	}
	if (status.some((entry) => entry.rename)) {
		return { status: "scope_violation", changedPaths: status.map((entry) => entry.path), violations: ["rename"], error: { code: "scope_violation", message: SCOPE } };
	}

	const allowed = new Set(baseline.allowedWrites);
	const dirtyBefore = new Set(baseline.status.map((entry) => entry.path));
	const paths = new Set([...baseline.files.keys(), ...status.map((entry) => entry.path), ...allowed]);
	const changedPaths: string[] = [];
	const violations: string[] = [];
	let violationCode: HandoffErrorCode | undefined;
	for (const path of [...paths].sort()) {
		const before = baseline.files.get(path) ?? { kind: "absent" };
		const after = await fileState(resolve(current.worktreeRoot, path));
		if (sameState(before, after)) continue;
		changedPaths.push(path);
		const code = classifyDelta(before, after, allowed.has(path), dirtyBefore.has(path) && !allowed.has(path));
		if (code) {
			violations.push(path);
			violationCode = code;
		}
	}
	if (violationCode) {
		return {
			status: "scope_violation",
			changedPaths,
			violations,
			error: { code: violationCode, message: SCOPE },
		};
	}
	return { status: "within_declared_writes", changedPaths, violations: [] };
}
