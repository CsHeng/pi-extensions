import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { ManagedError } from "./session-contracts.ts";

export async function syncDirectory(path: string): Promise<void> {
	const dir = await open(path, "r");
	try { await dir.sync(); } finally { await dir.close(); }
}

export async function privateDirectory(directory: string, create: boolean, forbiddenMode: 0o077 | 0o022 | 0 = 0o077): Promise<number> {
	let created = false;
	if (create) {
		try { await mkdir(directory, { mode: 0o700 }); created = true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & forbiddenMode) !== 0 || (process.getuid && info.uid !== process.getuid()) || await realpath(directory) !== directory) throw new ManagedError("managed_storage_invalid");
	if (created) await syncDirectory(dirname(directory));
	return info.mode;
}
