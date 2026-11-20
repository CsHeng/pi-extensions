#!/usr/bin/env bun
/** Operator-only, offline recovery of one interrupted episode under operator-established writer quiescence. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { uncertainApply } from "../extensions/agents/session-contracts.ts";
import { parseWriterMarker, writerRecoveryEvidence } from "../extensions/agents/writer-recovery.ts";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { privateDirectory, syncDirectory } from "../extensions/agents/private-directory.ts";

export interface RepairInput { agentDirectory: string; repo: string; session: string; anchor: string | null; handle: string; episode: number; quiescent: boolean }

async function readPrivate(path: string, maximum: number): Promise<Buffer> {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > maximum) throw new Error("unsafe private file");
  return await file.readFile();
 } finally { await file.close(); }
}
async function absent(path: string): Promise<boolean> {
 try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
async function backup(path: string, bytes: Buffer): Promise<void> {
 const file = await open(path, "wx", 0o600);
 try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function remediate(input: RepairInput): Promise<string> {
 if (!input.quiescent) throw new Error("explicit quiescence of all users and writers is required");
 if (!isAbsolute(input.agentDirectory) || resolve(input.agentDirectory) !== input.agentDirectory || !isAbsolute(input.repo) || resolve(input.repo) !== input.repo || !Number.isSafeInteger(input.episode) || input.episode < 0) throw new Error("invalid exact target");
 const store = new ManagedSessionStore(input.agentDirectory);
 await privateDirectory(input.agentDirectory, false, 0o022);
 await privateDirectory(store.root, false);
 const directory = store.path(input.handle);
 await privateDirectory(directory, false);
 if (!await absent(join(store.root, ".writer-lock"))) throw new Error("root writer marker present");
 const claim = join(directory, ".recovery-claim");
 const hasClaim = !await absent(claim);
 if (hasClaim) await readPrivate(claim, 0); // Only the store's empty, private recovery fence.
 const marker = join(directory, ".writer-lock");
 const markerBytes = await absent(marker) ? undefined : await readPrivate(marker, 4096);
 const markerText = markerBytes?.toString("utf8");
 const structured = markerText === undefined ? undefined : parseWriterMarker(markerText);
 if (structured && await writerRecoveryEvidence(structured) === "active") throw new Error("identified writer is still active");
 // A legacy token has no process identity. Only a quiescent operator may retire it.
 if (markerText && !structured && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(markerText)) throw new Error("unrecognized writer marker; inspect offline evidence");
 if ((await readdir(directory)).some(name => /^finalization_.*\.pending$/.test(name))) throw new Error("pending finalization");
 const registry = join(directory, "registry.json");
 const registryBytes = await readPrivate(registry, 2 * 1024 * 1024);
 const owner = { repo: input.repo, parentSessionId: input.session, anchor: input.anchor, branch: input.anchor === null ? [] : [input.anchor] };
 const record = await store.load(input.handle, owner);
 const terminalClaim = hasClaim && markerBytes === undefined && (record.state === "idle" || record.state === "closed");
 const committed = terminalClaim || (record.state === "interrupted" && record.reconciledEpisode === input.episode);
 if (committed && !hasClaim && !markerBytes) throw new Error("already reconciled; inspect the retained work");
 if (record.owner.anchor !== input.anchor || record.episode !== input.episode || (!terminalClaim && !["running", "queued", "interrupted"].includes(record.state))) throw new Error("target identity or state mismatch");
 if (uncertainApply(record.candidate) || record.requests.some(request => uncertainApply(request.candidate)) ||
  (!terminalClaim && (record.candidate || (record.state !== "interrupted" && (record.result || record.requests.some(request => request.episode === record.episode && request.state === "complete")))))) throw new Error("completed execution, candidate or uncertain apply requires separate recovery");
 const quarantine = join(directory, `.offline-recovery-${randomUUID()}`);
 await mkdir(quarantine, { mode: 0o700 });
 let phase = "backup";
 try {
  await backup(join(quarantine, "registry.json"), registryBytes);
  if (hasClaim) await backup(join(quarantine, "recovery-claim"), Buffer.alloc(0));
  if (markerBytes) await backup(join(quarantine, "writer-lock"), markerBytes);
  await syncDirectory(quarantine); await syncDirectory(directory);
  if (!(await readPrivate(registry, 2 * 1024 * 1024)).equals(registryBytes) || (markerBytes ? !(await readPrivate(marker, 4096)).equals(markerBytes) : !await absent(marker)) || !await absent(join(store.root, ".writer-lock")) || (await readdir(directory)).some(name => /^finalization_.*\.pending$/.test(name))) throw new Error("target changed during backup");
  if (hasClaim !== !await absent(claim)) throw new Error("recovery claim changed during backup");
  if (hasClaim) await readPrivate(claim, 0);
  if (!committed) {
   record.state = "interrupted"; record.reconciledEpisode = input.episode;
   for (const request of record.requests) if (request.episode === input.episode && request.state === "running") request.state = "unknown";
   phase = "registry mutation may be partial";
   await store.save(record);
  }
  phase = "registry saved; marker removal may be partial";
  if (markerBytes) await unlink(marker);
  if (hasClaim) await unlink(claim);
  await syncDirectory(directory);
  return quarantine;
 } catch (error) { throw new Error(`${phase}; quarantine ${quarantine}; stop and inspect: ${error instanceof Error ? error.message : "unknown error"}`); }
}

if (import.meta.main) {
 const args = process.argv.slice(2);
 const usage = "usage: bun scripts/recover-agent-offline.ts --quiescent-all --agent-directory ABS --repo ABS --session ID --anchor ID|--null-anchor --handle ID --episode N";
 try {
  const values = new Map<string, string>(); let quiescent = false; let nullAnchor = false;
  for (let i = 0; i < args.length; i++) {
   const key = args[i]!;
   if (key === "--quiescent-all" && !quiescent) { quiescent = true; continue; }
   if (key === "--null-anchor" && !nullAnchor) { nullAnchor = true; continue; }
   if (!["--agent-directory", "--repo", "--session", "--anchor", "--handle", "--episode"].includes(key) || values.has(key) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(usage);
   values.set(key, args[++i]!);
  }
  if (!quiescent || nullAnchor === values.has("--anchor") || !["--agent-directory", "--repo", "--session", "--handle", "--episode"].every(key => values.has(key)) || !/^(0|[1-9][0-9]*)$/.test(values.get("--episode")!)) throw new Error(usage);
  const quarantine = await remediate({ agentDirectory: values.get("--agent-directory")!, repo: values.get("--repo")!, session: values.get("--session")!, anchor: nullAnchor ? null : values.get("--anchor")!, handle: values.get("--handle")!, episode: Number(values.get("--episode")), quiescent });
  console.log(`Scoped recovery complete; inspect the episode. Backups retained at ${quarantine}`);
 } catch (error) { console.error(error instanceof Error ? error.message : "repair failed"); process.exitCode = 1; }
}
