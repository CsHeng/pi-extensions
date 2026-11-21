import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { childProofSettled, prepareChildReceipt, saveChildReceipt, workerToolsSettled } from "../extensions/agents/child-proof.ts";
import { newWriterMarker } from "../extensions/agents/writer-recovery.ts";

const event = (phase: string) => JSON.stringify({ type: "custom", customType: "agents.worker-lifecycle", data: { phase, ok: true, owned: ["write"], recoverySafe: true } }) + "\n";

test("episode proof requires the exact marker, native identity, stopped lifecycle and absent group",  { skip: process.platform !== "linux" }, async () => {
 const dir = await mkdtemp(join(tmpdir(), "child-proof-test-"));
 try {
  const native = join(dir, "native.jsonl"), path = join(dir, "receipt");
  await writeFile(native, "");
  const marker = (await newWriterMarker())!; marker.phase = "launch-intent";
  const binding = { path, marker, episode: 1 };
  const proof = await prepareChildReceipt(binding, native, 0);
  assert.equal(await childProofSettled(binding, native, async () => true), false);
  await saveChildReceipt(proof, process.pid);
  await writeFile(native, event("ready") + event("stopped"));
  // process.pid need not be a group leader; use a known absent group below.
  const receipt = JSON.parse(await readFile(path, "utf8"));
  const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
   receipt.pgid = live.pid;
   await writeFile(path, JSON.stringify(receipt));
   assert.equal(await childProofSettled(binding, native, async () => true), false);
  } finally { if (live.pid) process.kill(-live.pid, "SIGKILL"); await new Promise<void>(resolve => live.once("close", () => resolve())); }
  receipt.pgid = 2147483647;
  await writeFile(path, JSON.stringify(receipt));
  assert.equal(await childProofSettled(binding, native, async () => true), true);
  assert.equal(await childProofSettled({ ...binding, episode: 2 }, native, async () => true), false);
  assert.equal(await childProofSettled({ ...binding, marker: { ...marker, token: "different" } }, native, async () => true), false);
  assert.equal(await childProofSettled(binding, native, async () => false), false);
  await writeFile(native, event("ready"));
  assert.equal(await childProofSettled(binding, native, async () => true), false);
  await writeFile(native, event("ready") + event("stopped") + event("ready"));
  assert.equal(await workerToolsSettled(native, 0, true), false);
  await writeFile(native, event("ready") + event("stopped").replace('"recoverySafe":true', '"recoverySafe":false'));
  assert.equal(await childProofSettled(binding, native, async () => true), false);
  await rm(native); await symlink(path, native);
  assert.equal(await childProofSettled(binding, native, async () => true), false);
  await rm(native); await writeFile(native, event("ready") + event("stopped"));
  assert.equal(await childProofSettled(binding, native, async () => true), false);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
