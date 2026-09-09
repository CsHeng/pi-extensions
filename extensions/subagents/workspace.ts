import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	realpath,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NormalizedTask } from "./graph.ts";
import { findCanonicalGitRoot, RepositoryPolicyError } from "./repository-policy.ts";

export interface FileState {
	kind: "file" | "symlink" | "directory" | "absent";
	mode?: number;
	digest?: string;
	link?: string;
}

export interface WorkerWorkspace {
	sourceRoot: string;
	root: string;
	task: NormalizedTask;
	parentBaselines: ReadonlyMap<string, FileState>;
	workspaceBaseline: ReadonlyMap<string, FileState>;
	cleanup(): Promise<void>;
}

export class WorkspaceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WorkspaceError";
		this.code = code;
	}
}

function contains(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function digest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function state(path: string): Promise<FileState> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) return { kind: "symlink", mode: info.mode & 0o777, link: await readlink(path) };
		if (!info.isFile()) throw new WorkspaceError("unsupported_file_type", `Unsupported file type at ${path}.`);
		return { kind: "file", mode: info.mode & 0o777, digest: digest(await readFile(path)) };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "absent" };
		throw error;
	}
}

export function sameState(left: FileState, right: FileState): boolean {
	return left.kind === right.kind && left.mode === right.mode && left.digest === right.digest && left.link === right.link;
}

async function runGit(cwd: string, args: string[]): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
			else reject(new WorkspaceError("git_inventory_failed", Buffer.concat(errors).toString("utf8").trim() || "Git inventory failed."));
		});
	});
}

export async function findGitRoot(cwd: string): Promise<string> {
	try {
		return await findCanonicalGitRoot(cwd);
	} catch (error) {
		const message = error instanceof RepositoryPolicyError
			? error.message
			: error instanceof Error ? error.message : String(error);
		throw new WorkspaceError("writable_isolation_unavailable", message);
	}
}

export async function assertNoSymlinkComponent(root: string, target: string): Promise<void> {
	if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new WorkspaceError("write_symlink", "Repository root is no longer a canonical regular directory.");
	const relation = relative(root, target);
	if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new WorkspaceError("write_path_escape", "Write path escapes the repository root.");
	let current = root;
	for (const component of relation.split(sep)) {
		if (!component) continue;
		current = join(current, component);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new WorkspaceError("write_symlink", "Write path contains a symlink.");
			if (current !== target && !info.isDirectory()) throw new WorkspaceError("write_parent_not_directory", "Write path ancestor is not a directory.");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}
	}
}

async function copyInventoryEntry(sourceRoot: string, workspaceRoot: string, relativePath: string): Promise<void> {
	const source = resolve(sourceRoot, relativePath);
	const destination = resolve(workspaceRoot, relativePath);
	if (!contains(sourceRoot, source) || !contains(workspaceRoot, destination)) throw new WorkspaceError("inventory_escape", "Git inventory escaped its root.");
	let info;
	try {
		info = await lstat(source);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return;
		throw error;
	}
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	if (info.isFile()) {
		await copyFile(source, destination);
		await chmod(destination, info.mode & 0o777);
		return;
	}
	if (info.isSymbolicLink()) {
		const link = await readlink(source);
		const resolvedTarget = resolve(dirname(source), link);
		if (!contains(sourceRoot, resolvedTarget)) return;
		await symlink(link, destination);
	}
}

export async function scan(root: string, options: { rejectSpecial?: boolean } = {}): Promise<Map<string, FileState>> {
	const entries = new Map<string, FileState>();
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			const key = relative(root, absolute);
			if (entry.isDirectory()) await visit(absolute);
			else if (entry.isFile() || entry.isSymbolicLink()) entries.set(key, await state(absolute));
			else {
				if (options.rejectSpecial) throw new WorkspaceError("unexpected_worker_change", "Managed source contains an unsupported filesystem entry.");
				entries.set(key, { kind: "absent" });
			}
		}
	}
	await visit(root);
	return entries;
}

export async function createWorkerWorkspace(cwd: string, task: NormalizedTask, limits?: { maxBytes: number; maxEntries: number }): Promise<WorkerWorkspace> {
	if (task.role !== "worker" || task.writePaths.length < 1) {
		throw new WorkspaceError("worker_write_paths_required", "Writable workspace requires a worker with exact repository-relative writePaths; write paths are not inferred.");
	}
	const sourceRoot = await findGitRoot(cwd);
	const root = await mkdtemp(join(tmpdir(), "csheng-worker-"));
	await chmod(root, 0o700);
	try {
		const inventory = await runGit(sourceRoot, ["ls-files", "-co", "--exclude-standard", "-z"]);
		const relativePaths = [...new Set(inventory.toString("utf8").split("\0").filter(Boolean))].sort();
		if (limits) {
			if (relativePaths.length > limits.maxEntries) throw new WorkspaceError("workspace_input_limit", "Source inventory exceeds its entry admission limit.");
			let bytes = 0;
			for (const path of relativePaths) {
				const file = join(sourceRoot, path); await assertNoSymlinkComponent(sourceRoot, dirname(file));
				let info;
				try { info = await lstat(file); } catch (error) { if (isNodeError(error) && error.code === "ENOENT") continue; throw error; }
				if (info.isSymbolicLink()) {
					const link = await readlink(file);
					if (isAbsolute(link) || !contains(sourceRoot, resolve(dirname(file), link))) throw new WorkspaceError("unsupported_source_link", "Managed source inventory contains an external link.");
				}
				if (!info.isFile() && !info.isSymbolicLink()) throw new WorkspaceError("unsupported_source_input", "Managed source inventory contains an unsupported filesystem input.");
				bytes += info.size;
				if (bytes > limits.maxBytes) throw new WorkspaceError("workspace_input_limit", "Source inventory exceeds its byte admission limit.");
			}
		}
		for (const relativePath of relativePaths) await copyInventoryEntry(sourceRoot, root, relativePath);

		const parentBaselines = new Map<string, FileState>();
		for (const relativePath of task.writePaths) {
			const parentPath = resolve(sourceRoot, relativePath);
			if (!contains(sourceRoot, parentPath)) throw new WorkspaceError("write_path_escape", `Write path ${relativePath} escapes the repository.`);
			await assertNoSymlinkComponent(sourceRoot, parentPath);
			const baseline = await state(parentPath);
			if (baseline.kind === "symlink") throw new WorkspaceError("write_symlink", `Write path ${relativePath} is a symlink.`);
			if (baseline.kind === "absent") {
				const workerPath = resolve(root, relativePath);
				await assertNoSymlinkComponent(root, workerPath);
				await mkdir(dirname(workerPath), { recursive: true, mode: 0o700 });
			}
			parentBaselines.set(relativePath, baseline);
		}
		const workspaceBaseline = await scan(root);
		return {
			sourceRoot,
			root,
			task,
			parentBaselines,
			workspaceBaseline,
			async cleanup() { await rm(root, { recursive: true, force: true }); },
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

export function changedEntries(before: ReadonlyMap<string, FileState>, after: ReadonlyMap<string, FileState>): string[] {
	const keys = new Set([...before.keys(), ...after.keys()]);
	return [...keys].filter((key) => !sameState(before.get(key) ?? { kind: "absent" }, after.get(key) ?? { kind: "absent" })).sort();
}

export async function createSafeParentDirectories(root: string, target: string, created: string[]): Promise<void> {
	await assertNoSymlinkComponent(root, target);
	let current = root;
	for (const component of relative(root, dirname(target)).split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			await mkdir(current, { mode: 0o700 });
			created.push(current);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		}
		const info = await lstat(current);
		if (info.isSymbolicLink()) throw new WorkspaceError("write_symlink", "Write path contains a symlink.");
		if (!info.isDirectory()) throw new WorkspaceError("write_parent_not_directory", "Write path ancestor is not a directory.");
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
