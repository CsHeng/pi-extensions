import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Retained for dependency inventories and legacy managed-record validation. */
export interface FileState {
	kind: "file" | "symlink" | "directory" | "absent";
	mode?: number;
	digest?: string;
	link?: string;
}

export class WorkspaceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WorkspaceError";
		this.code = code;
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
