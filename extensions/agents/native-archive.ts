import { dirname, join } from "node:path";
import { privateDirectory } from "./private-directory.ts";
import { ManagedError } from "./session-contracts.ts";

export const archiveBucket = /^--[^/\\:\0]*--$/u;
export const archiveFilename = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.jsonl$/u;

/** Pi's default project encoding, without its implicit mkdir. The caller supplies a trusted absolute cwd. */
export function projectBucket(cwd: string): string {
	const bucket = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	if (!archiveBucket.test(bucket) || Buffer.byteLength(bucket) > 255) throw new ManagedError("managed_native_invalid", undefined, "binding");
	return bucket;
}

export async function nativeArchiveDirectory(sessions: string, bucket: string, create: boolean): Promise<string> {
	if (!archiveBucket.test(bucket) || Buffer.byteLength(bucket) > 255) throw new ManagedError("managed_native_invalid", undefined, "binding");
	const project = join(sessions, bucket);
	const archive = join(project, "agents");
	// Pi may create group-writable native directories below a 0700 agent home. Only exposed ancestors must reject other writers.
	const homeMode = await privateDirectory(dirname(sessions), false, 0o022);
	const exposedHome = (homeMode & 0o077) !== 0;
	const sessionsMode = await privateDirectory(sessions, create, exposedHome ? 0o022 : 0);
	await privateDirectory(project, create, exposedHome && (sessionsMode & 0o077) !== 0 ? 0o022 : 0);
	await privateDirectory(archive, create);
	return archive;
}
