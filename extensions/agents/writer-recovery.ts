import { readFile, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Unknown evidence is deliberately not recoverable online. */
export interface WriterMarker {
 version: 1; token: string; machine: string; boot: string; pidNamespace: string; pid: number; start: string;
 phase: "unknown" | "not-started" | "launch-intent" | "settled";
}

async function identity(): Promise<{ machine: string; boot: string; pidNamespace: string }> {
 if (process.platform !== "linux") throw new Error("unsupported_platform");
 const [machine, boot, pidNamespace, self, status] = await Promise.all([readFile("/etc/machine-id", "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"), readlink("/proc/self"), readFile("/proc/self/status", "utf8")]);
 if (self !== String(process.pid) || status.match(/^NSpid:[ \t]*([^\n]+)$/m)?.[1]?.trim() !== self) throw new Error("procfs_pid_namespace_mismatch");
 if (!/^[a-f0-9]{32}\s*$/i.test(machine) || !/^[a-f0-9-]{36}\s*$/i.test(boot)) throw new Error("identity_unavailable");
 return { machine: machine.trim(), boot: boot.trim(), pidNamespace };
}
async function processStart(pid: number): Promise<string | undefined> {
 let stat: string;
 try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
 const end = stat.lastIndexOf(")");
 const fields = stat.slice(end + 2).trim().split(/\s+/);
 if (end < 0 || !/^\d+$/.test(fields[19] ?? "")) throw new Error("process_identity_unavailable");
 return fields[19];
}
export async function newWriterMarker(): Promise<WriterMarker | undefined> {
 try {
  const host = await identity(); const start = await processStart(process.pid);
  if (!start) return undefined;
  return { version: 1, token: randomUUID(), ...host, pid: process.pid, start, phase: "unknown" };
 } catch { return undefined; }
}
export function parseWriterMarker(raw: string): WriterMarker | undefined {
 try {
  const v = JSON.parse(raw) as WriterMarker;
  if (v.version !== 1 || typeof v.machine !== "string" || typeof v.boot !== "string" || typeof v.start !== "string" || typeof v.pidNamespace !== "string" || !/^pid:\[\d+\]$/.test(v.pidNamespace) || typeof v.token !== "string" || !/^[a-f0-9-]{36}$/i.test(v.token) || !/^[a-f0-9]{32}$/i.test(v.machine) || !/^[a-f0-9-]{36}$/i.test(v.boot) || !Number.isSafeInteger(v.pid) || v.pid < 1 || !/^\d+$/.test(v.start) || !["unknown", "not-started", "launch-intent", "settled"].includes(v.phase)) return undefined;
  return v;
 } catch { return undefined; }
}
export async function writerRecoveryEvidence(marker: WriterMarker, childSettled?: () => Promise<boolean>): Promise<"gone" | "active" | "unknown"> {
 try {
  const host = await identity();
  if (host.machine !== marker.machine) return "unknown";
  if (host.boot !== marker.boot) return "gone";
  if (host.pidNamespace !== marker.pidNamespace) return "unknown";
  const start = await processStart(marker.pid);
  if (start === marker.start) return "active";
  return marker.phase === "not-started" || marker.phase === "settled" || (marker.phase === "launch-intent" && await childSettled?.()) ? "gone" : "unknown";
 } catch { return "unknown"; }
}
