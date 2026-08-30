import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NormalizedTask } from "./graph.ts";

interface FileState {
	kind: "file" | "symlink" | "absent";
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

export interface ConvergenceResult {
	ok: boolean;
	changedPaths: string[];
	error?: { code: string; message: string };
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
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function digest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

async function state(path: string): Promise<FileState> {
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

function sameState(left: FileState, right: FileState): boolean {
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
		const output = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
		return await realpath(output.toString("utf8").trim());
	} catch (error) {
		throw new WorkspaceError("writable_isolation_unavailable", error instanceof Error ? error.message : String(error));
	}
}

async function assertNoSymlinkComponent(root: string, target: string): Promise<void> {
	const relation = relative(root, target);
	if (relation.startsWith("..") || isAbsolute(relation)) throw new WorkspaceError("write_path_escape", "Write path escapes the repository root.");
	let current = root;
	for (const component of relation.split(sep)) {
		if (!component) continue;
		current = join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new WorkspaceError("write_symlink", "Write path contains a symlink.");
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

async function scan(root: string): Promise<Map<string, FileState>> {
	const entries = new Map<string, FileState>();
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			const key = relative(root, absolute);
			if (entry.isDirectory()) await visit(absolute);
			else if (entry.isFile() || entry.isSymbolicLink()) entries.set(key, await state(absolute));
			else entries.set(key, { kind: "absent" });
		}
	}
	await visit(root);
	return entries;
}

export async function createWorkerWorkspace(cwd: string, task: NormalizedTask): Promise<WorkerWorkspace> {
	if (task.role !== "worker" || task.writePaths.length < 1) {
		throw new WorkspaceError("worker_write_paths_required", "Writable workspace requires a worker with exact repository-relative writePaths; write paths are not inferred.");
	}
	const sourceRoot = await findGitRoot(cwd);
	const root = await mkdtemp(join(tmpdir(), "csheng-worker-"));
	await chmod(root, 0o700);
	try {
		const inventory = await runGit(sourceRoot, ["ls-files", "-co", "--exclude-standard", "-z"]);
		const relativePaths = [...new Set(inventory.toString("utf8").split("\0").filter(Boolean))].sort();
		for (const relativePath of relativePaths) await copyInventoryEntry(sourceRoot, root, relativePath);

		const parentBaselines = new Map<string, FileState>();
		for (const relativePath of task.writePaths) {
			const parentPath = resolve(sourceRoot, relativePath);
			if (!contains(sourceRoot, parentPath)) throw new WorkspaceError("write_path_escape", `Write path ${relativePath} escapes the repository.`);
			await assertNoSymlinkComponent(sourceRoot, parentPath);
			const baseline = await state(parentPath);
			if (baseline.kind === "symlink") throw new WorkspaceError("write_symlink", `Write path ${relativePath} is a symlink.`);
			if (baseline.kind === "absent") {
				const parent = await lstat(dirname(parentPath));
				if (!parent.isDirectory()) throw new WorkspaceError("new_file_parent_missing", `Parent directory for ${relativePath} is unavailable.`);
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

function changedEntries(before: ReadonlyMap<string, FileState>, after: ReadonlyMap<string, FileState>): string[] {
	const keys = new Set([...before.keys(), ...after.keys()]);
	return [...keys].filter((key) => !sameState(before.get(key) ?? { kind: "absent" }, after.get(key) ?? { kind: "absent" })).sort();
}

export async function convergeWorkerWorkspace(workspace: WorkerWorkspace): Promise<ConvergenceResult> {
	const currentWorkspace = await scan(workspace.root);
	const changed = changedEntries(workspace.workspaceBaseline, currentWorkspace);
	const allowed = new Set(workspace.task.writePaths);
	const unexpected = changed.find((entry) => !allowed.has(entry));
	if (unexpected) return { ok: false, changedPaths: changed, error: { code: "unexpected_worker_change", message: `Worker changed undeclared path ${unexpected}.` } };

	for (const relativePath of changed) {
		const before = workspace.workspaceBaseline.get(relativePath) ?? { kind: "absent" };
		const after = currentWorkspace.get(relativePath) ?? { kind: "absent" };
		if (after.kind !== "file" || (before.kind === "file" && before.mode !== after.mode)) {
			return { ok: false, changedPaths: changed, error: { code: "unexpected_worker_change", message: `Worker used an unsupported operation for ${relativePath}.` } };
		}
	}

	for (const relativePath of workspace.task.writePaths) {
		const parentPath = resolve(workspace.sourceRoot, relativePath);
		const baseline = workspace.parentBaselines.get(relativePath) as FileState;
		if (!sameState(baseline, await state(parentPath))) {
			return { ok: false, changedPaths: changed, error: { code: "convergence_conflict", message: `Parent path ${relativePath} changed after worker launch.` } };
		}
	}

	if (changed.length === 0) {
		return {
			ok: false,
			changedPaths: [],
			error: { code: "worker_no_changes", message: "Worker completed without changing any repository file." },
		};
	}

	const staged: Array<{ temporary: string; target: string }> = [];
	try {
		for (const relativePath of changed) {
			const source = resolve(workspace.root, relativePath);
			const target = resolve(workspace.sourceRoot, relativePath);
			const after = currentWorkspace.get(relativePath) as FileState;
			const baseline = workspace.parentBaselines.get(relativePath) as FileState;
			const temporary = join(dirname(target), `.csheng-subagent-${randomUUID()}.tmp`);
			await writeFile(temporary, await readFile(source), { mode: baseline.kind === "file" ? baseline.mode : after.mode ?? 0o644 });
			await chmod(temporary, baseline.kind === "file" ? baseline.mode ?? 0o644 : after.mode ?? 0o644);
			staged.push({ temporary, target });
		}
		for (const relativePath of changed) {
			const target = resolve(workspace.sourceRoot, relativePath);
			const baseline = workspace.parentBaselines.get(relativePath) as FileState;
			if (!sameState(baseline, await state(target))) {
				return { ok: false, changedPaths: changed, error: { code: "convergence_conflict", message: `Parent path ${relativePath} changed during convergence.` } };
			}
		}
		for (const item of staged) await rename(item.temporary, item.target);
		staged.length = 0;
		return { ok: true, changedPaths: changed };
	} finally {
		await Promise.all(staged.map((item) => rm(item.temporary, { force: true })));
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
