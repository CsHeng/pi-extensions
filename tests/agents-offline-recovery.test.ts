import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { validateGraphStructure } from "../extensions/agents/graph.ts";
import { remediate } from "../scripts/recover-agent-offline.ts";

async function fixture(t: test.TestContext) {
 const base = await mkdtemp(join(tmpdir(), "legacy-repair-"));
 t.after(() => rm(base, { recursive: true, force: true }));
 const owner = { repo: base, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
 const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", access: [{ permission: "read", scope: base }] }] });
 if (!graph.ok) throw new Error("fixture");
 const store = new ManagedSessionStore(base);
 const record = (await store.allocate(owner, "request", graph.tasks)).records[0]!;
 record.state = "running"; record.episode = 1;
 record.requests = [{ id: "req", fingerprint: "a".repeat(64), episode: 1, state: "running" }];
 await store.save(record);
 const marker = join(store.path(record.handle), ".writer-lock");
 const legacyToken = randomUUID();
 await writeFile(marker, legacyToken, { mode: 0o600 });
 return { store, owner, record, marker, legacyToken, input: { agentDirectory: base, repo: base, session: "parent", anchor: "branch", handle: record.handle, episode: 1, quiescent: true } };
}
test("offline repair retains exact evidence and records unknown execution", async t => {
 const f = await fixture(t); const original = await readFile(join(f.store.path(f.record.handle), "registry.json"));
 const quarantine = await remediate(f.input);
 assert.deepEqual(await readFile(join(quarantine, "registry.json")), original);
 assert.equal(await readFile(join(quarantine, "writer-lock"), "utf8"), f.legacyToken);
 await assert.rejects(readFile(f.marker));
 const repaired = await f.store.load(f.record.handle, f.owner);
 assert.equal(repaired.state, "interrupted"); assert.equal(repaired.requests[0]!.state, "unknown"); assert.equal(repaired.candidate, undefined);
});
test("a quiescent retry releases abandoned recovery fences without rewriting the committed result", async t => {
 const f = await fixture(t);
 f.record.state = "interrupted"; f.record.reconciledEpisode = f.input.episode;
 f.record.requests[0]!.state = "unknown"; await f.store.save(f.record);
 const dir = f.store.path(f.record.handle), registry = join(dir, "registry.json"), claim = join(dir, ".recovery-claim");
 await writeFile(claim, "", { mode: 0o600 });
 const committed = await readFile(registry);
 await remediate(f.input);
 assert.deepEqual(await readFile(registry), committed);
 await assert.rejects(readFile(claim), { code: "ENOENT" }); await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});
test("an abandoned claim before save or after marker unlink fences normal writes until scoped repair", async t => {
 for (const afterUnlink of [false, true]) {
  const f = await fixture(t), directory = f.store.path(f.record.handle);
  if (afterUnlink) {
   f.record.state = "interrupted"; f.record.requests[0]!.state = "unknown"; f.record.reconciledEpisode = 1;
   await f.store.save(f.record); await rm(f.marker);
  }
  const claim = join(directory, ".recovery-claim");
  await writeFile(claim, "", { mode: 0o600 });
  await assert.rejects(f.store.withSession(f.record.handle, f.owner, async () => assert.fail("writer admitted")), /managed_(writer|recovery)_busy_or_unknown/);
  const quarantine = await remediate(f.input);
  assert.deepEqual(await readFile(join(quarantine, "recovery-claim")), Buffer.alloc(0));
  assert.equal((await f.store.load(f.record.handle, f.owner)).reconciledEpisode, 1);
  await f.store.withSession(f.record.handle, f.owner, async record => assert.equal(record.state, "interrupted"));
 }
});
test("an empty private writer can be backed up offline; a finalized episode only loses its abandoned claim", async t => {
 const f = await fixture(t), directory = f.store.path(f.record.handle), registry = join(directory, "registry.json");
 await writeFile(f.marker, "");
 const backup = await remediate(f.input);
 assert.deepEqual(await readFile(join(backup, "writer-lock")), Buffer.alloc(0));
 f.record.state = "idle"; f.record.requests[0]!.state = "complete";
 f.record.candidate = { id: randomUUID().replaceAll("-", ""), episode: 1, status: "not-applied", changedPaths: [], appliedPaths: [], roots: [] };
 await f.store.save(f.record);
 const finalized = await readFile(registry), claim = join(directory, ".recovery-claim");
 await writeFile(claim, "", { mode: 0o600 });
 await remediate(f.input);
 assert.deepEqual(await readFile(registry), finalized);
 await assert.rejects(readFile(claim), { code: "ENOENT" });
});
test("unsafe targets remain unchanged", async t => {
 const f = await fixture(t); const registry = join(f.store.path(f.record.handle), "registry.json"); const original = await readFile(registry);
 await assert.rejects(remediate({ ...f.input, quiescent: false }));
 await assert.rejects(remediate({ ...f.input, anchor: "other" }));
 await assert.rejects(remediate({ ...f.input, episode: 2 }));
 await writeFile(f.marker, '{"version":1}'); await assert.rejects(remediate(f.input));
 await writeFile(f.marker, f.legacyToken);
 await writeFile(join(f.store.path(f.record.handle), "finalization_1.pending"), "{}"); await assert.rejects(remediate(f.input));
 assert.deepEqual(await readFile(registry), original); assert.equal(await readFile(f.marker, "utf8"), f.legacyToken);
});
