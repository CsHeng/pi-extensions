import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { admitRepositoryTasks } from "../extensions/subagents/repository-policy.ts";
import { ManagedSessionStore, type ManagedRecord } from "../extensions/subagents/managed-sessions.ts";
import { MANAGED_LIMITS } from "../extensions/subagents/session-contracts.ts";
import { applyCandidate, freezeCandidate, prepareManagedWorkspace, releaseManagedResources, syncManagedInputs } from "../extensions/subagents/candidates.ts";
import { discardGitWorkspace, discardGitInput, planGitApply } from "../extensions/subagents/git-workspace.ts";
const exec = promisify(execFile);
/** A real store whose persistence can be interrupted deterministically at a chosen save. */
class InterruptingStore extends ManagedSessionStore {
 private saves = 0;
 private interrupted = false;
 failAt: number | undefined;
 failWhen: ((record: ManagedRecord, saves: number) => boolean) | undefined;
 override async save(record: ManagedRecord): Promise<void> {
  this.saves++;
  if (this.failAt !== undefined && this.saves === this.failAt) { this.failAt = undefined; throw new Error("simulated persistence failure"); }
  if (!this.interrupted && this.failWhen?.(record, this.saves)) { this.interrupted = true; throw new Error("simulated persistence interruption"); }
  return super.save(record);
 }
}
async function setup(t: test.TestContext, initial?: (repo: string) => Promise<void>) {
 const base = await mkdtemp(join(tmpdir(), "managed-candidates-v3-")); const repo = join(base, "repo"); await mkdir(repo);
 await exec("git", ["init", "-q", repo]); await initial?.(repo);
 const owner = { repo, parentSessionId: "parent", anchor: "entry", branch: ["entry"] };
 const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", access: [{ permission: "write", scope: repo }] }] }); if (!graph.ok) throw new Error("fixture");
 const admitted = await admitRepositoryTasks(repo, graph.tasks); if (!admitted.ok) throw new Error(admitted.error.message);
 const store = new ManagedSessionStore(base); const record = (await store.allocate(owner, "create", admitted.tasks)).records[0]!;
 t.after(async () => { for (const root of record.roots) { if (root.inputs?.gitWorkspace) await discardGitWorkspace(root.inputs.gitWorkspace); if (root.inputRef && root.input) await discardGitInput(root.source, root.inputRef, root.input); } await rm(base, { recursive: true, force: true }); });
 await prepareManagedWorkspace(store, record); record.episode = 1;
 record.result = { id: "worker", role: "worker", status: "succeeded", reportComplete: true, output: "done", stderr: "", durationMs: 1, usage: emptyUsage(), changedPaths: [], convergence: "not-applicable" };
 const source = record.roots.find(root => root.permission === "write")?.inputs?.gitWorkspace?.path;
 if (!source) throw new Error("missing prepared root");
 return { repo, owner, store, record, source };
}
function gitOf(record: { roots: Array<{ inputs?: { gitWorkspace?: { inputBase: string } } }> }) {
 const workspace = record.roots.find(root => root.inputs?.gitWorkspace)?.inputs?.gitWorkspace;
 if (!workspace) throw new Error("missing workspace");
 return workspace;
}
async function multiSetup(t: test.TestContext, initial?: (repoA: string, repoB: string) => Promise<void>) {
 const base = await mkdtemp(join(tmpdir(), "managed-candidates-multi-")); const repoA = join(base, "repo-a"); const repoB = join(base, "repo-b");
 await mkdir(repoA); await mkdir(repoB); await exec("git", ["init", "-q", repoA]); await exec("git", ["init", "-q", repoB]); await initial?.(repoA, repoB);
 for (const repo of [repoA, repoB]) { await exec("git", ["-C", repo, "add", "-A"]); await exec("git", ["-C", repo, "commit", "-qm", "base", "--allow-empty"]); }
 const owner = { repo: repoA, parentSessionId: "parent", anchor: "entry", branch: ["entry"] };
 const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", access: [{ permission: "write", scope: [repoA, repoB] }] }] }); if (!graph.ok) throw new Error("fixture");
 const admitted = await admitRepositoryTasks(repoA, graph.tasks); if (!admitted.ok) throw new Error(admitted.error.message);
 const store = new ManagedSessionStore(base); const record = (await store.allocate(owner, "create", admitted.tasks)).records[0]!;
 t.after(async () => {
  for (const root of record.roots) {
   if (root.inputs?.gitWorkspace) { try { await discardGitWorkspace(root.inputs.gitWorkspace); } catch { /* best effort */ } }
   if (root.inputRef && root.input) { try { await discardGitInput(root.source, root.inputRef, root.input); } catch { /* best effort */ } }
  }
  await rm(base, { recursive: true, force: true });
 });
 await prepareManagedWorkspace(store, record); record.episode = 1;
 record.result = { id: "worker", role: "worker", status: "succeeded", reportComplete: true, output: "done", stderr: "", durationMs: 1, usage: emptyUsage(), changedPaths: [], convergence: "not-applicable" };
 const writeRoots = record.roots.filter(root => root.permission === "write");
 if (writeRoots.length !== 2) throw new Error("missing prepared roots");
 return { base, repoA, repoB, owner, store, record, workspaceA: writeRoots[0]!.inputs!.gitWorkspace!, workspaceB: writeRoots[1]!.inputs!.gitWorkspace! };
}

test("apply receipts preserve actual parent rename integration paths and allow a no-op apply", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 await writeFile(join(f.source, "a.txt"), "worker\n"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await rename(join(f.repo, "a.txt"), join(f.repo, "b.txt"));
 const applied = await applyCandidate(f.store, f.record, candidate.id); assert.equal(applied.status, "applied"); assert.deepEqual(applied.roots[0]!.changedPaths, ["a.txt"]); assert.deepEqual(applied.roots[0]!.appliedPaths, ["b.txt"]); assert.deepEqual(applied.changedPaths, [`${applied.roots[0]!.rootId}/a.txt`]); assert.deepEqual(applied.appliedPaths, [`${applied.roots[0]!.rootId}/b.txt`]);
 assert.deepEqual((await f.store.load(f.record.handle, f.owner)).candidate?.roots[0]?.appliedPaths, ["b.txt"]);
 const g = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 await writeFile(join(g.source, "a.txt"), "same\n"); const identical = await freezeCandidate(g.store, g.record); assert.ok(identical); await writeFile(join(g.repo, "a.txt"), "same\n");
 assert.deepEqual((await applyCandidate(g.store, g.record, identical.id)).appliedPaths, []);
 assert.equal((await g.store.load(g.record.handle, g.owner)).candidate?.status, "applied");
});

test("v3 candidates are immutable input-relative Git objects; apply never refreshes the task basis", async t => {
 const f = await setup(t); const basis = gitOf(f.record).inputBase;
 await writeFile(join(f.source, "new.txt"), "one"); const first = await freezeCandidate(f.store, f.record); assert.ok(first);
 await writeFile(join(f.source, "new.txt"), "unfrozen");
 assert.equal((await applyCandidate(f.store, f.record, first.id)).status, "applied"); assert.equal(await readFile(join(f.repo, "new.txt"), "utf8"), "one");
 assert.equal(gitOf(f.record).inputBase, basis);
 assert.equal((await applyCandidate(f.store, f.record, first.id)).status, "applied");
 f.record.episode++; const second = await freezeCandidate(f.store, f.record); assert.ok(second);
 assert.equal((await applyCandidate(f.store, f.record, second.id)).status, "conflict", "both parent and worker changed an initially absent path differently");
});

test("refresh explicitly incorporates applied input while preserving the worker repair and native record", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "file"), "base\n"));
 await writeFile(join(f.source, "file"), "one\n"); const first = await freezeCandidate(f.store, f.record); assert.ok(first);
 await applyCandidate(f.store, f.record, first.id); const prior = gitOf(f.record).inputBase;
 await syncManagedInputs(f.store, f.record); assert.notEqual(gitOf(f.record).inputBase, prior);
 f.record.episode++; await writeFile(join(f.source, "file"), "two\n"); const second = await freezeCandidate(f.store, f.record); assert.ok(second);
 assert.equal((await applyCandidate(f.store, f.record, second.id)).status, "applied"); assert.equal(await readFile(join(f.repo, "file"), "utf8"), "two\n");
});

test("actual additions, deletion, executable mode, binary data and contained symlink exceed advisory write hints", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "delete.txt"), "inherited"));
 await rm(join(f.source, "delete.txt")); await mkdir(join(f.source, "nested")); await writeFile(join(f.source, "nested/run"), "#!/bin/sh\n", { mode: 0o755 });
 await writeFile(join(f.source, "data.bin"), Buffer.from([0, 255, 7])); await symlink("data.bin", join(f.source, "link"));
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate); assert.deepEqual(candidate.roots[0]!.changedPaths, ["data.bin", "delete.txt", "link", "nested/run"]);
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

test("ignored environments remain project-owned through candidate apply and source refresh", async t => {
 const f = await setup(t, async repo => { await writeFile(join(repo, ".gitignore"), "node_modules/\n"); await mkdir(join(repo, "node_modules")); await writeFile(join(repo, "node_modules/pkg"), "one"); });
 await mkdir(join(f.source, "node_modules")); await writeFile(join(f.source, "node_modules/pkg"), "local"); await writeFile(join(f.source, "new.txt"), "source"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate); assert.deepEqual(candidate.roots[0]!.changedPaths, ["new.txt"]);
 await applyCandidate(f.store, f.record, candidate.id); assert.equal(await readFile(join(f.repo, "node_modules/pkg"), "utf8"), "one");
 await writeFile(join(f.repo, "node_modules/pkg"), "two"); await syncManagedInputs(f.store, f.record); assert.equal(await readFile(join(f.source, "node_modules/pkg"), "utf8"), "local");
});

test("Git project rules, not package-directory names, determine candidate source", async t => {
 const f = await setup(t); await mkdir(join(f.source, "node_modules")); await writeFile(join(f.source, "node_modules/state"), "local"); assert.deepEqual((await freezeCandidate(f.store, f.record))?.roots[0]?.changedPaths, ["node_modules/state"]);
});

test("candidate byte cap, incomplete reports, unknown apply state and forged candidate metadata fail closed", async t => {
 const f = await setup(t); await writeFile(join(f.source, "large"), ""); await truncate(join(f.source, "large"), MANAGED_LIMITS.maxCandidateBytes + 1);
 await assert.rejects(freezeCandidate(f.store, f.record), /candidate_limit/); await rm(join(f.source, "large")); await writeFile(join(f.source, "file"), "source");
 f.record.result!.reportComplete = false; await assert.rejects(freezeCandidate(f.store, f.record), /candidate_report_incomplete/); f.record.result!.reportComplete = true;
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate); candidate.status = "unknown"; const recovered = await applyCandidate(f.store, f.record, candidate.id); assert.equal(recovered.roots[0]?.status, "applied");
 candidate.status = "not-applied"; candidate.roots[0]!.status = "not-applied"; candidate.roots[0]!.git!.changedPaths = ["forged"]; await assert.rejects(applyCandidate(f.store, f.record, candidate.id), /candidate_mismatch/); assert.equal(await readFile(join(f.repo, "file"), "utf8"), "source");
});

test("parent rename cannot apply a partial grant outside its selected path", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 const root = f.record.roots.find(item => item.permission === "write")!;
 root.paths = ["a.txt"];
 await writeFile(join(f.source, "a.txt"), "worker\n");
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await rename(join(f.repo, "a.txt"), join(f.repo, "renamed.txt"));
 await assert.rejects(applyCandidate(f.store, f.record, candidate.id), /candidate_outside_grant/);
 assert.equal(await readFile(join(f.repo, "renamed.txt"), "utf8"), "base\n");
 await assert.rejects(lstat(join(f.repo, "a.txt")), { code: "ENOENT" });
});

test("re-entry keeps the stored plan paths instead of inferring a fresh snapshot", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 await writeFile(join(f.source, "a.txt"), "worker\n");
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 const applied = await applyCandidate(f.store, f.record, candidate.id);
 const attempt = applied.roots[0]?.attempt; assert.ok(attempt);
 applied.roots[0]!.status = "unknown"; applied.status = "unknown"; applied.roots[0]!.appliedPaths = [];
 const again = await applyCandidate(f.store, f.record, candidate.id);
 assert.equal(again.roots[0]?.status, "applied");
 assert.deepEqual(again.roots[0]?.appliedPaths, attempt.paths);
 assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "worker\n");
});

test("release retries the remaining input ref after the worktree is already gone", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 const root = f.record.roots.find(item => item.inputs?.gitWorkspace)!;
 await discardGitWorkspace(root.inputs!.gitWorkspace!);
 await releaseManagedResources(f.store, f.record);
 assert.equal(f.record.release?.status, "complete");
 assert.equal(root.released, true);
 assert.equal(root.workspaceReleased, true);
 assert.equal(root.inputRef, undefined);
 assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "base\n");
});

test("a conflict plan is never journaled or applied as a successful merge on retry", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "file"), "base\n"));
 await writeFile(join(f.source, "file"), "worker\n"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await writeFile(join(f.repo, "file"), "parent\n");
 const first = await applyCandidate(f.store, f.record, candidate.id);
 assert.equal(first.status, "conflict");
 assert.equal(first.roots[0]!.attempt, undefined, "a conflict plan must not be journaled as an applicable attempt");
 const root = f.record.roots.find(item => item.permission === "write")!;
 const ownedBefore = Object.keys(root.inputs!.gitWorkspace!.ownedRefs).length;
 const persisted = await f.store.load(f.record.handle, f.owner);
 assert.equal(Object.keys(persisted.roots.find(item => item.id === root.id)!.inputs!.gitWorkspace!.ownedRefs).length, ownedBefore, "a conflict plan creates no unrecorded integration ref");
 const second = await applyCandidate(f.store, f.record, candidate.id);
 assert.equal(second.status, "conflict", "retry must not treat a conflict result as applied");
 assert.equal(second.roots[0]!.status, "conflict");
 assert.equal(Object.keys(root.inputs!.gitWorkspace!.ownedRefs).length, ownedBefore, "conflict retry does not accumulate owned refs");
 const content = await readFile(join(f.repo, "file"), "utf8");
 assert.equal(content, "parent\n");
 assert.ok(!content.includes("<<<<<<<"), "retry must never write conflict markers");
 await releaseManagedResources(f.store, f.record);
 assert.equal(f.record.release?.status, "complete");
});
test("a legacy journaled conflict attempt is re-planned instead of executing conflict markers", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "file"), "base\n"));
 await writeFile(join(f.source, "file"), "worker\n"); const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 const root = f.record.roots.find(item => item.permission === "write")!;
 const workspace = root.inputs!.gitWorkspace!;
 await writeFile(join(f.repo, "file"), "parent\n");
 // Reproduce an attempt persisted by an earlier build: a conflict tree with no applicable paths.
 const conflict = await planGitApply(workspace, candidate.roots[0]!.git!);
 assert.equal(conflict.status, "conflict");
 candidate.roots[0]!.attempt = { ...conflict.attempt, integrationRef: `refs/csheng/subagents/${workspace.id}/integration/legacy` };
 await f.store.save(f.record);
 const reloaded = await f.store.load(f.record.handle, f.owner);
 assert.equal(reloaded.candidate!.roots[0]!.attempt?.paths.length, 0);
 const result = await applyCandidate(f.store, reloaded, reloaded.candidate!.id);
 assert.equal(result.status, "conflict", "a legacy conflict attempt must not be applied as a successful merge");
 const content = await readFile(join(f.repo, "file"), "utf8");
 assert.equal(content, "parent\n");
 assert.ok(!content.includes("<<<<<<<"), "re-entry must never write conflict markers");
});
test("an invalid later candidate cannot mutate an earlier root of the same bundle", async t => {
 const f = await multiSetup(t, async (a, b) => { await writeFile(join(a, "a.txt"), "base-a\n"); await writeFile(join(b, "b.txt"), "base-b\n"); });
 await writeFile(join(f.workspaceA.path, "a.txt"), "worker-a\n");
 await writeFile(join(f.workspaceB.path, "b.txt"), "worker-b\n");
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 assert.equal(candidate.roots.length, 2);
 candidate.roots[1]!.git!.changedPaths = ["forged"];
 await assert.rejects(applyCandidate(f.store, f.record, candidate.id), /candidate_mismatch/);
 assert.equal(await readFile(join(f.repoA, "a.txt"), "utf8"), "base-a\n");
 assert.equal(await readFile(join(f.repoB, "b.txt"), "utf8"), "base-b\n");
});
test("a reloaded partial apply preserves the applied prefix, paths and parent index", async t => {
 const f = await multiSetup(t, async (a, b) => { await writeFile(join(a, "a.txt"), "base-a\n"); await writeFile(join(b, "b.txt"), "base-b\n"); });
 await writeFile(join(f.workspaceA.path, "a.txt"), "worker-a\n");
 await writeFile(join(f.workspaceB.path, "b.txt"), "worker-b\n");
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await writeFile(join(f.repoB, "b.txt"), "parent-b\n");
 const indexA = await readFile(join(f.repoA, ".git", "index"));
 const applied = await applyCandidate(f.store, f.record, candidate.id);
 assert.equal(applied.status, "partial");
 const appliedRoot = applied.roots.find(root => root.status === "applied")!;
 const conflictRoot = applied.roots.find(root => root.status === "conflict")!;
 assert.deepEqual(appliedRoot.appliedPaths, ["a.txt"]);
 assert.equal(await readFile(join(f.repoA, "a.txt"), "utf8"), "worker-a\n");
 assert.equal(await readFile(join(f.repoB, "b.txt"), "utf8"), "parent-b\n");
 const reloaded = await f.store.load(f.record.handle, f.owner);
 const reloadedApplied = reloaded.candidate!.roots.find(root => root.rootId === appliedRoot.rootId)!;
 assert.equal(reloadedApplied.status, "applied");
 assert.deepEqual(reloadedApplied.appliedPaths, appliedRoot.appliedPaths);
 assert.ok(reloadedApplied.attempt, "the applied prefix keeps its journaled attempt across reload");
 const again = await applyCandidate(f.store, reloaded, reloaded.candidate!.id);
 assert.equal(again.roots.find(root => root.rootId === appliedRoot.rootId)!.status, "applied");
 assert.deepEqual(again.roots.find(root => root.rootId === appliedRoot.rootId)!.appliedPaths, appliedRoot.appliedPaths);
 assert.equal(again.roots.find(root => root.rootId === conflictRoot.rootId)!.status, "conflict");
 assert.equal(await readFile(join(f.repoA, "a.txt"), "utf8"), "worker-a\n");
 assert.equal(await readFile(join(f.repoB, "b.txt"), "utf8"), "parent-b\n");
 assert.deepEqual(await readFile(join(f.repoA, ".git", "index")), indexA);
});
test("a persistence interruption after the destination write preserves the applied result", async t => {
 const f = await setup(t, async repo => { await writeFile(join(repo, "a.txt"), "base\n"); await exec("git", ["-C", repo, "add", "a.txt"]); await exec("git", ["-C", repo, "commit", "-qm", "base"]); });
 await writeFile(join(f.source, "a.txt"), "worker\n");
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 await f.store.save(f.record);
 const head = (await exec("git", ["-C", f.repo, "rev-parse", "HEAD"])).stdout.trim();
 const index = await readFile(join(f.repo, ".git", "index"));
 // Interrupt exactly the applied-status save, after git apply has already mutated the destination.
 const store = new InterruptingStore(dirname(f.store.root));
 store.failWhen = record => record.candidate?.roots.some(root => root.status === "applied") ?? false;
 await assert.rejects(applyCandidate(store, f.record, candidate.id), /candidate_apply_unknown/);
 assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "worker\n", "the destination write really happened");
 const interrupted = await f.store.load(f.record.handle, f.owner);
 const rootState = interrupted.candidate!.roots[0]!;
 assert.equal(rootState.status, "unknown");
 assert.ok(rootState.attempt, "the pre-mutation journal survives the interrupted promotion");
 const again = await applyCandidate(f.store, interrupted, interrupted.candidate!.id);
 assert.equal(again.roots[0]!.status, "applied");
 assert.deepEqual(again.roots[0]!.appliedPaths, rootState.attempt!.paths);
 assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "worker\n");
 assert.equal((await exec("git", ["-C", f.repo, "rev-parse", "HEAD"])).stdout.trim(), head);
 assert.deepEqual(await readFile(join(f.repo, ".git", "index")), index);
});
test("a failed promotion checkpoint keeps a durable creation intent that a later discard releases", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 await writeFile(join(f.source, "a.txt"), "worker\n");
 const candidate = await freezeCandidate(f.store, f.record); assert.ok(candidate);
 const root = f.record.roots.find(item => item.permission === "write")!;
 const workspace = root.inputs!.gitWorkspace!;
 // The first checkpoint records the creation intent; the promotion checkpoint then fails.
 const store = new InterruptingStore(dirname(f.store.root));
 store.failAt = 2;
 await assert.rejects(applyCandidate(store, f.record, candidate.id), /simulated persistence failure/);
 const integration = Object.keys(workspace.ownedRefs).find(ref => ref.includes("/integration/"));
 assert.ok(integration, "the created integration ref is recorded in memory");
 const expected = workspace.ownedRefs[integration]!;
 const persisted = await f.store.load(f.record.handle, f.owner);
 const persistedWorkspace = persisted.roots.find(item => item.id === root.id)!.inputs!.gitWorkspace!;
 assert.equal(persistedWorkspace.pendingRefs?.[integration], expected, "the creation intent is durable");
 assert.ok(Object.keys(persistedWorkspace.ownedRefs).every(ref => !ref.includes("/integration/")), "promotion was not persisted as ordinary ownership");
 // Even with the created ref locked, a reload still inventories it and release can retry to completion.
 const lockPath = join(f.repo, ".git", `${integration}.lock`);
 await writeFile(lockPath, "locked\n");
 const reloaded = await f.store.load(f.record.handle, f.owner);
 await assert.rejects(releaseManagedResources(f.store, reloaded), /cleanup_partial/);
 const afterFailure = await f.store.load(f.record.handle, f.owner);
 const afterWorkspace = afterFailure.roots.find(item => item.id === root.id)!.inputs!.gitWorkspace!;
 assert.ok(afterWorkspace.ownedRefs[integration] || afterWorkspace.pendingRefs?.[integration], "a locked integration ref stays inventoried after a partial release");
 await rm(lockPath, { force: true });
 await releaseManagedResources(f.store, afterFailure);
 assert.equal(afterFailure.release?.status, "complete");
 await assert.rejects(exec("git", ["-C", f.repo, "show-ref", "--verify", integration]), /Command failed/);
});
test("release retries an owned ref whose deletion failed after the worktree was removed", async t => {
 const f = await setup(t, repo => writeFile(join(repo, "a.txt"), "base\n"));
 const root = f.record.roots.find(item => item.inputs?.gitWorkspace)!;
 const workspace = root.inputs!.gitWorkspace!;
 await writeFile(join(f.source, "a.txt"), "worker\n");
 await freezeCandidate(f.store, f.record);
 const refs = Object.keys(workspace.ownedRefs);
 assert.ok(refs.length >= 2, JSON.stringify(refs));
 const blocked = refs.find(ref => ref.includes("/candidate/")) ?? refs.at(-1)!;
 const lockPath = join(f.repo, ".git", `${blocked}.lock`);
 await writeFile(lockPath, "blocked\n");
 await assert.rejects(releaseManagedResources(f.store, f.record), /cleanup_partial/);
 assert.equal(f.record.release?.status, "partial");
 assert.ok(f.record.release?.remaining.includes(root.id));
 assert.ok(root.inputs?.gitWorkspace, "remaining ownership inventory is retained after a partial release");
 const persisted = await f.store.load(f.record.handle, f.owner);
 const persistedRoot = persisted.roots.find(item => item.id === root.id)!;
 assert.ok(persistedRoot.inputs?.gitWorkspace?.ownedRefs[blocked]);
 await rm(lockPath, { force: true });
 await releaseManagedResources(f.store, persisted);
 assert.equal(persisted.release?.status, "complete");
 assert.equal(persistedRoot.released, true);
 assert.equal(persistedRoot.inputs, undefined);
 assert.equal((await f.store.load(persisted.handle, f.owner)).release?.status, "complete");
});
test("v1 and v2 source/candidate helpers are read-only, not a second writable backend", async t => {
 const f = await setup(t); (f.record as { version: number }).version = 3; await assert.rejects(prepareManagedWorkspace(f.store, f.record), /unsupported_contract/);
});
