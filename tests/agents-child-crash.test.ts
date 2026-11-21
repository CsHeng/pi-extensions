import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { validateGraphStructure } from "../extensions/agents/graph.ts";

const waitExit = (child: ReturnType<typeof spawn>) => new Promise<void>((resolveExit, reject) => {
 child.once("error", reject);
 child.once("close", () => resolveExit());
});

// The simulated child belongs to the test, not the killed writer, so it can be reaped
// before asserting group absence (an orphan zombie is not evidence of settlement).
test("crashed launch-intent writer is reconciled only after its receipted child group settles", { skip: process.platform !== "linux", timeout: 15000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "agents-child-crash-"));
 const owner = { repo: base, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
 const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", access: [{ permission: "read", scope: base }] }] });
 if (!graph.ok) throw new Error("fixture graph invalid");
 const store = new ManagedSessionStore(base);
 const record = (await store.allocate(owner, "request", graph.tasks)).records[0]!;
 record.state = "running"; record.episode = 1;
 record.requests = [{ id: "req", fingerprint: "a".repeat(64), episode: 1, state: "running" }];
 await store.save(record);
 const native = store.nativePath(record), start = (await readFile(native)).length;
 const edit = join(base, "useful-edit.txt");
 await writeFile(edit, "useful work survives\n");
 const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
 const childExit = waitExit(child);
 assert.ok(child.pid);
 const signal = join(base, "receipt-ready");
 const module = new URL("../extensions/agents/managed-sessions.ts", import.meta.url).href;
 const proofModule = new URL("../extensions/agents/child-proof.ts", import.meta.url).href;
 const script = `
  import { ManagedSessionStore } from ${JSON.stringify(module)};
  import { prepareChildReceipt, saveChildReceipt } from ${JSON.stringify(proofModule)};
  import { writeFile } from "node:fs/promises";
  const store = new ManagedSessionStore(${JSON.stringify(base)});
  await store.withSession(${JSON.stringify(record.handle)}, ${JSON.stringify(owner)}, async () => {
   await store.writerPhase(${JSON.stringify(record.handle)}, "not-started");
   await store.writerPhase(${JSON.stringify(record.handle)}, "launch-intent");
   const binding = store.childProofBinding(${JSON.stringify(record.handle)}, 1);
   if (!binding) throw new Error("binding unavailable");
   const receipt = await prepareChildReceipt(binding, ${JSON.stringify(native)}, ${start});
   await saveChildReceipt(receipt, ${child.pid});
   await writeFile(${JSON.stringify(signal)}, "ready");
   await new Promise(() => { setInterval(() => {}, 1000); });
  });`;
 const writer = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
 let stderr = ""; writer.stderr!.on("data", chunk => { stderr += chunk.toString(); });
 const writerExit = waitExit(writer);
 try {
  const deadline = Date.now() + 8000;
  for (;;) {
   try { await readFile(signal); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
   if (writer.exitCode !== null || writer.signalCode !== null) throw new Error(`writer exited before receipt: ${stderr}`);
   if (Date.now() > deadline) throw new Error(`writer receipt timed out: ${stderr}`);
   await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  writer.kill("SIGKILL"); await writerExit;
  const lifecycle = (id: string, parentId: string | null, phase: string) => JSON.stringify({ type: "custom", id, parentId, customType: "agents.worker-lifecycle", data: { phase, ok: true, owned: ["write"], recoverySafe: true } }) + "\n";
  const header = await readFile(native, "utf8");
  await writeFile(native, header + lifecycle("ready", null, "ready") + lifecycle("stopped", "ready", "stopped"));
  await assert.rejects(store.reconcile(record.handle, owner, 2), /stale_episode/);
  await assert.rejects(store.reconcile(record.handle, owner, 1));
  assert.equal((await store.load(record.handle, owner)).state, "running");
  process.kill(-child.pid!, "SIGKILL"); await childExit;
  await writeFile(native, header + lifecycle("ready", null, "ready") + JSON.stringify({ type: "custom", id: "stopped", parentId: "ready", customType: "agents.worker-lifecycle", data: { phase: "stopped", ok: true, owned: ["write"] } }) + "\n");
  await assert.rejects(store.reconcile(record.handle, owner, 1));
  await writeFile(native, header + lifecycle("ready", null, "ready") + lifecycle("stopped", "ready", "stopped"));
  const recovered = await store.reconcile(record.handle, owner, 1);
  assert.equal(recovered.state, "interrupted");
  assert.equal(recovered.reconciledEpisode, 1);
  assert.equal(recovered.requests[0]!.state, "unknown");
  assert.equal(recovered.candidate, undefined);
  assert.equal(await readFile(edit, "utf8"), "useful work survives\n");
  assert.equal((await store.reconcile(record.handle, owner, 1)).requests[0]!.state, "unknown");
 } finally {
  if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
  await writerExit;
  if (child.exitCode === null && child.signalCode === null && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  await childExit;
  await rm(base, { recursive: true, force: true });
 }
});
