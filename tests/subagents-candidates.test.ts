import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { MANAGED_LIMITS } from "../extensions/subagents/session-contracts.ts";
import { applyCandidate, freezeCandidate, prepareManagedWorkspace, syncManagedInputs } from "../extensions/subagents/candidates.ts";
import { discardGitWorkspace, discardGitInput } from "../extensions/subagents/git-workspace.ts";
const exec = promisify(execFile);
async function setup(t: test.TestContext, initial?: (repo: string) => Promise<void>) {
 const base = await mkdtemp(join(tmpdir(), "managed-candidates-v3-")); const repo = join(base, "repo"); await mkdir(repo);
 await exec("git", ["init", "-q", repo]); await initial?.(repo);
 const owner = { repo, parentSessionId: "parent", anchor: "entry", branch: ["entry"] };
 const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", scope: ["."], writePaths: ["hint.txt"] }] }); if (!graph.ok) throw new Error("fixture");
 const store = new ManagedSessionStore(base); const record = (await store.allocate(owner, "create", graph.tasks)).records[0]!;
 t.after(async () => { if (record.workspace?.inputs.gitWorkspace) await discardGitWorkspace(record.workspace.inputs.gitWorkspace); if (record.inputRef && record.input) await discardGitInput(repo, record.inputRef, record.input); await rm(base, { recursive: true, force: true }); });
 await prepareManagedWorkspace(store, record); record.episode = 1;
 record.result = { id: "worker", role: "worker", status: "succeeded", reportComplete: true, output: "done", stderr: "", durationMs: 1, usage: emptyUsage(), changedPaths: [], convergence: "not-applicable" };
 return { repo, owner, store, record, source: join(store.path(record.handle), "source") };
}

test("apply receipts preserve actual parent rename integration paths and allow a no-op apply", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 await writeFile(join(f.source, "a.txt"), "worker\n"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await rename(join(f.repo, "a.txt"), join(f.repo, "b.txt"));
 const applied = await applyCandidate(f.store, f.record, candidate.id); assert.equal(applied.status, "applied"); assert.deepEqual(applied.changedPaths, ["a.txt"]); assert.deepEqual(applied.appliedPaths, ["b.txt"]);
 assert.deepEqual((await f.store.load(f.record.handle, f.owner)).candidate?.appliedPaths, ["b.txt"]);
 const g = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 await writeFile(join(g.source, "a.txt"), "same\n"); const identical = await freezeCandidate(g.store, g.record); assert.ok(identical); await writeFile(join(g.repo, "a.txt"), "same\n");
 assert.deepEqual((await applyCandidate(g.store, g.record, identical.id)).appliedPaths, []);
 assert.equal((await g.store.load(g.record.handle, g.owner)).candidate?.status, "applied");
});

test("v3 candidates are immutable input-relative Git objects; apply never refreshes the task basis", async t => {
 const f = await setup(t); const basis = f.record.workspace!.inputs.gitWorkspace!.inputBase;
 await writeFile(join(f.source, "new.txt"), "one"); const first = await freezeCandidate(f.store, f.record); assert.ok(first);
 await writeFile(join(f.source, "new.txt"), "unfrozen");
 assert.equal((await applyCandidate(f.store, f.record, first.id)).status, "applied"); assert.equal(await readFile(join(f.repo, "new.txt"), "utf8"), "one");
 assert.equal(f.record.workspace!.inputs.gitWorkspace!.inputBase, basis);
 assert.equal((await applyCandidate(f.store, f.record, first.id)).status, "applied");
 f.record.episode++; const second = await freezeCandidate(f.store, f.record); assert.ok(second);
 assert.equal((await applyCandidate(f.store, f.record, second.id)).status, "conflict", "both parent and worker changed an initially absent path differently");
});

test("refresh explicitly incorporates applied input while preserving the worker repair and native record", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "file"), "base\n"));
 await writeFile(join(f.source, "file"), "one\n"); const first = await freezeCandidate(f.store, f.record); assert.ok(first);
 await applyCandidate(f.store, f.record, first.id); const prior = f.record.workspace!.inputs.gitWorkspace!.inputBase;
 await syncManagedInputs(f.store, f.record); assert.notEqual(f.record.workspace!.inputs.gitWorkspace!.inputBase, prior);
 f.record.episode++; await writeFile(join(f.source, "file"), "two\n"); const second = await freezeCandidate(f.store, f.record); assert.ok(second);
 assert.equal((await applyCandidate(f.store, f.record, second.id)).status, "applied"); assert.equal(await readFile(join(f.repo, "file"), "utf8"), "two\n");
});

test("actual additions, deletion, executable mode, binary data and contained symlink exceed advisory write hints", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "delete.txt"), "inherited"));
 await rm(join(f.source, "delete.txt")); await mkdir(join(f.source, "nested")); await writeFile(join(f.source, "nested/run"), "#!/bin/sh\n", { mode: 0o755 });
 await writeFile(join(f.source, "data.bin"), Buffer.from([0, 255, 7])); await symlink("data.bin", join(f.source, "link"));
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate); assert.deepEqual(candidate.changedPaths, ["data.bin", "delete.txt", "link", "nested/run"]);
 assert.equal((await applyCandidate(f.store, f.record, candidate.id)).status, "applied");
 assert.equal((await lstat(join(f.repo, "nested/run"))).mode & 0o111, 0o111); assert.ok((await lstat(join(f.repo, "link"))).isSymbolicLink()); await assert.rejects(lstat(join(f.repo, "delete.txt")), { code: "ENOENT" });
});

test("compatible parent dirty content and staged input survive Git integration", async t => {
 const lines = Array.from({ length: 40 }, (_, i) => `${i}\n`); const f = await setup(t, async repo => { await writeFile(join(repo, "file"), lines.join("")); await exec("git", ["-C", repo, "add", "file"]); });
 const before = (await exec("git", ["-C", f.repo, "ls-files", "--stage"])).stdout;
 const worker = [...lines]; worker[2] = "worker\n"; await writeFile(join(f.source, "file"), worker.join("")); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 const parent = [...lines]; parent[35] = "parent\n"; await writeFile(join(f.repo, "file"), parent.join(""));
 assert.equal((await applyCandidate(f.store, f.record, candidate.id)).status, "applied"); worker[35] = "parent\n";
 assert.equal(await readFile(join(f.repo, "file"), "utf8"), worker.join("")); assert.equal((await exec("git", ["-C", f.repo, "ls-files", "--stage"])).stdout, before);
});

test("same-line conflicts retain both source versions and report conflict without forced overwrite", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "file"), "base\n")); await writeFile(join(f.source, "file"), "worker\n"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await writeFile(join(f.repo, "file"), "parent\n"); assert.equal((await applyCandidate(f.store, f.record, candidate.id)).status, "conflict");
 await assert.rejects(syncManagedInputs(f.store, f.record), /convergence_conflict/); assert.equal(await readFile(join(f.source, "file"), "utf8"), "worker\n"); assert.equal(await readFile(join(f.repo, "file"), "utf8"), "parent\n");
});

test("private dependency mutations remain local runtime state and explicit refresh updates parent dependency input", async t => {
 const f = await setup(t, async repo => { await writeFile(join(repo, ".gitignore"), "node_modules/\n"); await mkdir(join(repo, "node_modules")); await writeFile(join(repo, "node_modules/pkg"), "one"); });
 await writeFile(join(f.source, "node_modules/pkg"), "local"); await writeFile(join(f.source, "new.txt"), "source"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate); assert.deepEqual(candidate.changedPaths, ["new.txt"]);
 await applyCandidate(f.store, f.record, candidate.id); assert.equal(await readFile(join(f.repo, "node_modules/pkg"), "utf8"), "one");
 await writeFile(join(f.repo, "node_modules/pkg"), "two"); await syncManagedInputs(f.store, f.record); assert.equal(await readFile(join(f.source, "node_modules/pkg"), "utf8"), "two");
});

test("no source change produces no candidate; new ignored runtime dependency is excluded even without parent ignore rule", async t => {
 const f = await setup(t); await mkdir(join(f.source, "node_modules")); await writeFile(join(f.source, "node_modules/state"), "local"); assert.equal(await freezeCandidate(f.store, f.record), undefined);
});

test("candidate byte cap, incomplete reports, unknown apply state and forged candidate metadata fail closed", async t => {
 const f = await setup(t); await writeFile(join(f.source, "large"), ""); await truncate(join(f.source, "large"), MANAGED_LIMITS.maxCandidateBytes + 1);
 await assert.rejects(freezeCandidate(f.store, f.record), /candidate_limit/); await rm(join(f.source, "large")); await writeFile(join(f.source, "file"), "source");
 f.record.result!.reportComplete = false; await assert.rejects(freezeCandidate(f.store, f.record), /candidate_report_incomplete/); f.record.result!.reportComplete = true;
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate); candidate.status = "unknown"; await assert.rejects(applyCandidate(f.store, f.record, candidate.id), /candidate_recovery_required/);
 candidate.status = "not-applied"; candidate.git!.changedPaths = ["forged"]; await assert.rejects(applyCandidate(f.store, f.record, candidate.id), /candidate_paths_mismatch/); await assert.rejects(lstat(join(f.repo, "file")), { code: "ENOENT" });
});

test("v1 and v2 source/candidate helpers are read-only, not a second writable backend", async t => {
 const f = await setup(t); for (const version of [1, 2] as const) { f.record.version = version; await assert.rejects(prepareManagedWorkspace(f.store, f.record), /legacy_session_read_only/); await assert.rejects(syncManagedInputs(f.store, f.record), /legacy_session_read_only/); await assert.rejects(freezeCandidate(f.store, f.record), /legacy_session_read_only/); await assert.rejects(applyCandidate(f.store, f.record, "candidate"), /legacy_session_read_only/); }
});
