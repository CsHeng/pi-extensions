import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { nativeLines } from "./native-lines.ts";
import type { WriterMarker } from "./writer-recovery.ts";

export async function workerToolsSettled(path: string, start: number, crashRecovery = false, parentLeaf?: string | null): Promise<boolean> {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size < start) return false;
			let ready = false;
			let stopped = false;
			// The toolkit lifecycle only certifies operations it owns. A configured same-name
			// native override keeps its own implementation, so ready/stopped must declare the
			// exact owned set and never imply that an opaque implementation's processes settled.
			let owned: readonly string[] | undefined;
			for await (const entry of nativeLines(file, start)) {
				if (parentLeaf !== undefined) {
					if (entry.parentId !== parentLeaf || typeof entry.id !== "string") return false;
					parentLeaf = entry.id;
				}
				if (entry.type !== "custom" || entry.customType !== "agents.worker-lifecycle") continue;
				const data = entry.data as { ok?: unknown; phase?: unknown; owned?: unknown; recoverySafe?: unknown } | undefined;
				if (data?.ok !== true || (crashRecovery && data.recoverySafe !== true)) return false;
				if (!Array.isArray(data.owned) || data.owned.length > 64 || data.owned.some(name => typeof name !== "string" || name.length === 0 || name.length > 64)) return false;
				const declared = [...data.owned].sort();
				if (owned === undefined) owned = declared;
				else if (owned.length !== declared.length || owned.some((name, index) => name !== declared[index])) return false;
				if (data.phase === "ready" && (!crashRecovery || (!ready && !stopped))) ready = true;
				else if (data.phase === "stopped" && ready && (!crashRecovery || !stopped)) stopped = true;
				else return false;
			}
			const after = await file.stat();
			return ready && stopped && info.size === after.size && info.mtimeMs === after.mtimeMs;
		} finally { await file.close(); }
	} catch { return false; }
}


/** The caller owns this private per-episode path and holds the writer marker throughout launch. */
export interface ChildProofBinding { path: string; episode: number; marker: WriterMarker }
interface Receipt { version: 1; episode: number; token: string; machine: string; boot: string; namespace: string; nativePath: string; dev: number; ino: number; birthtimeMs: number; start: number; pgid: number }
interface Prepared { binding: ChildProofBinding; receipt: Omit<Receipt, "pgid"> }

async function namespace(): Promise<string> {
 const info = await stat("/proc/self/ns/pid");
 return `${info.dev}:${info.ino}`;
}
async function sameHost(marker: WriterMarker): Promise<boolean> {
 const [machine, boot] = await Promise.all([readFile("/etc/machine-id", "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
 return machine.trim() === marker.machine && boot.trim() === marker.boot;
}
export async function prepareChildReceipt(binding: ChildProofBinding, nativePath: string, start: number): Promise<Prepared> {
 if (process.platform !== "linux" || binding.marker.phase !== "launch-intent" || !Number.isSafeInteger(binding.episode) || binding.episode < 1 || !Number.isSafeInteger(start) || start < 0 || !await sameHost(binding.marker)) throw new Error("child_proof_unavailable");
 if (await realpath(nativePath) !== resolve(nativePath) || await realpath(dirname(binding.path)) !== resolve(dirname(binding.path))) throw new Error("child_proof_path_invalid");
 const info = await lstat(nativePath);
 if (!info.isFile() || info.size !== start || !Number.isFinite(info.birthtimeMs) || info.birthtimeMs <= 0) throw new Error("child_proof_native_invalid");
 return { binding, receipt: { version: 1, episode: binding.episode, token: binding.marker.token, machine: binding.marker.machine, boot: binding.marker.boot, namespace: await namespace(), nativePath: resolve(nativePath), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs, start } };
}
/** A crash before the exclusive, synced receipt completes deliberately leaves no usable proof. */
export async function saveChildReceipt(prepared: Prepared, pgid: number): Promise<void> {
 if (!Number.isSafeInteger(pgid) || pgid < 2) throw new Error("child_proof_pid_invalid");
 const file = await open(prepared.binding.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try { await file.writeFile(JSON.stringify({ ...prepared.receipt, pgid })); await file.sync(); } finally { await file.close(); }
 const dir = await open(dirname(prepared.binding.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
 try { await dir.sync(); } finally { await dir.close(); }
}
/** Caller must also validate the native revision/lineage and hold the recovery claim throughout. */
export async function childProofSettled(binding: ChildProofBinding, nativePath: string, lineage: () => Promise<boolean>, parentLeaf?: string | null): Promise<boolean> {
 try {
  if (process.platform !== "linux" || binding.marker.phase !== "launch-intent" || !await sameHost(binding.marker)) return false;
  if (await realpath(dirname(binding.path)) !== resolve(dirname(binding.path)) || await realpath(nativePath) !== resolve(nativePath)) return false;
  const file = await open(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > 4096) return false; raw = await file.readFile("utf8"); } finally { await file.close(); }
  const r = JSON.parse(raw) as Receipt;
  if (r.version !== 1 || r.episode !== binding.episode || r.token !== binding.marker.token || r.machine !== binding.marker.machine || r.boot !== binding.marker.boot || r.namespace !== await namespace() || r.nativePath !== resolve(nativePath) || !Number.isSafeInteger(r.pgid) || r.pgid < 2 || !Number.isSafeInteger(r.start) || r.start < 0 || !Number.isSafeInteger(r.dev) || !Number.isSafeInteger(r.ino) || !Number.isFinite(r.birthtimeMs) || r.birthtimeMs <= 0) return false;
  try { process.kill(-r.pgid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  const before = await lstat(nativePath);
  if (!before.isFile() || before.dev !== r.dev || before.ino !== r.ino || before.birthtimeMs !== r.birthtimeMs || before.size < r.start) return false;
  if (!await workerToolsSettled(nativePath, r.start, true, parentLeaf) || !await lineage()) return false;
  const after = await lstat(nativePath);
  return after.isFile() && after.dev === r.dev && after.ino === r.ino && after.birthtimeMs === r.birthtimeMs && before.size === after.size && before.mtimeMs === after.mtimeMs && await realpath(nativePath) === resolve(nativePath);
 } catch { return false; }
}
