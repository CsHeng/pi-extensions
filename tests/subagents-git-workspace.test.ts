import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, chmod, symlink, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyGitCandidate, captureGitInput, createGitTaskWorkspace, discardGitWorkspace, freezeGitCandidate, refreshGitInputs, inspectGitWorkspace, type GitTaskWorkspace } from "../extensions/subagents/git-workspace.ts";
const exec = promisify(execFile);
const env = () => ({ PATH: process.env.PATH, HOME: "/nonexistent", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" });
async function git(repo: string, ...args: string[]): Promise<string> { return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env: env(), timeout: 10_000 })).stdout.trim(); }
async function fixture(t: TestContext, initial: Record<string, string | Buffer> = { "main.txt": "base\n" }, committed = true) {
	const directory = await mkdtemp(join(tmpdir(), "csheng-wt-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const repo = join(directory, "repo"); await mkdir(repo); await git(repo, "init", "-q", "--template=");
	for (const [file, content] of Object.entries(initial)) { const dest = join(repo, file); await mkdir(join(dest, ".."), { recursive: true }); await writeFile(dest, content); }
	if (committed) { await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "base"); }
	return { repo, directory, worker: async (name = "task") => createGitTaskWorkspace(repo, join(directory, name), await captureGitInput(repo)) };
}
const contents = (root: string, name: string) => readFile(join(root, name), "utf8");
async function parentState(repo: string) { return { head: await git(repo, "rev-parse", "HEAD"), index: await readFile(join(repo, ".git", "index")) }; }
async function assertParentState(repo: string, before: Awaited<ReturnType<typeof parentState>>) { assert.equal(await git(repo, "rev-parse", "HEAD"), before.head); assert.deepEqual(await readFile(join(repo, ".git", "index")), before.index); }

test("dirty tracked, staged, and untracked source is inherited without changing parent index or HEAD", async t => {
	const f = await fixture(t); await writeFile(join(f.repo, "main.txt"), "staged\n"); await git(f.repo, "add", "main.txt");
	await writeFile(join(f.repo, "main.txt"), "working\n"); await writeFile(join(f.repo, "new.txt"), "untracked\n");
	await writeFile(join(f.repo, ".gitignore"), "cache/\n"); await mkdir(join(f.repo, "cache")); await writeFile(join(f.repo, "cache", "ignored"), "not-source");
	const before = await parentState(f.repo); const w = await f.worker();
	assert.equal(await contents(w.path, "main.txt"), "working\n"); assert.equal(await contents(w.path, "new.txt"), "untracked\n");
	await assert.rejects(stat(join(w.path, "cache")), { code: "ENOENT" }); await assertParentState(f.repo, before);
	assert.deepEqual((await freezeGitCandidate(w)).changedPaths, []);
});
test("unborn repository captures visible input without creating a parent branch", async t => {
	const f = await fixture(t, { "first.txt": "new\n" }, false); const w = await f.worker();
	assert.equal(await contents(w.path, "first.txt"), "new\n"); await assert.rejects(git(f.repo, "rev-parse", "--verify", "HEAD"));
	await assert.rejects(stat(join(f.repo, ".git", "index")), { code: "ENOENT" });
});
test("staged new file remains tracked input after a later ignore rule", async t => {
	const f = await fixture(t); await writeFile(join(f.repo, "new.txt"), "v1"); await git(f.repo, "add", "new.txt");
	await writeFile(join(f.repo, ".gitignore"), "new.txt\n"); await writeFile(join(f.repo, "new.txt"), "v2");
	const w = await f.worker(); assert.equal(await contents(w.path, "new.txt"), "v2");
});
test("staged removal with a still-visible nonignored file includes its current content", async t => {
	const f = await fixture(t); await git(f.repo, "rm", "--cached", "main.txt"); const before = await parentState(f.repo);
	const w = await f.worker(); assert.equal(await contents(w.path, "main.txt"), "base\n"); await assertParentState(f.repo, before);
});
test("file-to-directory input transition is represented by Git", async t => {
	const f = await fixture(t); await rm(join(f.repo, "main.txt")); await mkdir(join(f.repo, "main.txt")); await writeFile(join(f.repo, "main.txt", "new"), "nested\n");
	const w = await f.worker(); assert.equal(await contents(w.path, "main.txt/new"), "nested\n");
});
test("two workspaces are independent and preserve dirty parent source", async t => {
	const f = await fixture(t); const input = await captureGitInput(f.repo);
	const a = await createGitTaskWorkspace(f.repo, join(f.directory, "a"), input); const b = await createGitTaskWorkspace(f.repo, join(f.directory, "b"), input);
	await rm(join(a.path, "main.txt")); await writeFile(join(b.path, "main.txt"), "b\n");
	assert.equal(await contents(f.repo, "main.txt"), "base\n"); assert.equal(await contents(b.path, "main.txt"), "b\n");
	assert.notEqual(a.id, b.id);
});
test("dynamic added paths are candidate changes, not limited by a predicted write list", async t => {
	const f = await fixture(t); const w = await f.worker(); await mkdir(join(w.path, "new-module")); await writeFile(join(w.path, "new-module", "impl.ts"), "export const x = 1;\n");
	assert.deepEqual((await freezeGitCandidate(w)).changedPaths, ["new-module/impl.ts"]);
});
test("apply merges compatible same-file changes and preserves parent staging", async t => {
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`); const f = await fixture(t, { "main.txt": lines.join("") });
	await writeFile(join(f.repo, "local.txt"), "local\n"); await git(f.repo, "add", "local.txt");
	const w = await f.worker(); const workerLines = [...lines]; workerLines[2] = "worker\n"; await writeFile(join(w.path, "main.txt"), workerLines.join(""));
	const candidate = await freezeGitCandidate(w); const parentLines = [...lines]; parentLines[25] = "parent\n"; await writeFile(join(f.repo, "main.txt"), parentLines.join(""));
	const before = await parentState(f.repo); const result = await applyGitCandidate(w, candidate); assert.equal(result.status, "applied");
	parentLines[2] = "worker\n"; assert.equal(await contents(f.repo, "main.txt"), parentLines.join("")); await assertParentState(f.repo, before);
});
test("inherited dirty input is not resurrected after parent later deletes it", async t => {
	const f = await fixture(t); await writeFile(join(f.repo, "inherited.txt"), "dirty\n"); const w = await f.worker();
	await writeFile(join(w.path, "main.txt"), "worker\n"); const candidate = await freezeGitCandidate(w); assert.deepEqual(candidate.changedPaths, ["main.txt"]);
	await rm(join(f.repo, "inherited.txt")); assert.equal((await applyGitCandidate(w, candidate)).status, "applied");
	await assert.rejects(stat(join(f.repo, "inherited.txt")), { code: "ENOENT" });
});
test("conflicting edits preserve both sources and the parent index", async t => {
	const f = await fixture(t); const w = await f.worker(); await writeFile(join(w.path, "main.txt"), "worker\n"); const candidate = await freezeGitCandidate(w);
	await writeFile(join(f.repo, "main.txt"), "parent\n"); const before = await parentState(f.repo);
	const result = await applyGitCandidate(w, candidate); assert.equal(result.status, "conflict");
	assert.equal(await contents(f.repo, "main.txt"), "parent\n"); assert.equal(await contents(w.path, "main.txt"), "worker\n"); await assertParentState(f.repo, before);
});
test("Git represents rename, deletion, executable mode, binary and internal symlink changes", async t => {
	const f = await fixture(t, { "old.txt": "rename me\n", "delete.txt": "delete me\n", "tool.sh": "#!/bin/sh\necho hi\n", "data.bin": Buffer.from([0, 1, 2, 255]) }); const w = await f.worker();
	await rename(join(w.path, "old.txt"), join(w.path, "renamed.txt")); await rm(join(w.path, "delete.txt")); await chmod(join(w.path, "tool.sh"), 0o755);
	await writeFile(join(w.path, "data.bin"), Buffer.from([0, 9, 8, 255])); await symlink("renamed.txt", join(w.path, "link.txt"));
	const candidate = await freezeGitCandidate(w); const before = await parentState(f.repo); assert.equal((await applyGitCandidate(w, candidate)).status, "applied");
	assert.equal(await contents(f.repo, "renamed.txt"), "rename me\n"); await assert.rejects(stat(join(f.repo, "old.txt")), { code: "ENOENT" }); await assert.rejects(stat(join(f.repo, "delete.txt")), { code: "ENOENT" });
	assert.ok((await stat(join(f.repo, "tool.sh"))).mode & 0o111); assert.equal(await readlink(join(f.repo, "link.txt")), "renamed.txt");
	assert.deepEqual(await readFile(join(f.repo, "data.bin")), Buffer.from([0, 9, 8, 255])); await assertParentState(f.repo, before);
});
test("explicit refresh retains worker changes and excludes new parent input from the next candidate", async t => {
	const f = await fixture(t); const w = await f.worker(); await writeFile(join(w.path, "worker.txt"), "worker\n");
	await writeFile(join(f.repo, "parent.txt"), "parent\n"); const before = await parentState(f.repo);
	const oldBase = w.inputBase; const result = await refreshGitInputs(w); assert.equal(result.status, "refreshed"); assert.notEqual(w.inputBase, oldBase);
	assert.equal(await contents(w.path, "worker.txt"), "worker\n"); assert.equal(await contents(w.path, "parent.txt"), "parent\n");
	const candidate = await freezeGitCandidate(w); assert.deepEqual(candidate.changedPaths, ["worker.txt"]);
	assert.equal((await applyGitCandidate(w, candidate)).status, "applied"); assert.equal(await contents(f.repo, "worker.txt"), "worker\n"); await assertParentState(f.repo, before);
});
test("refresh conflict retains old basis and preserves B, W, and P", async t => {
	const f = await fixture(t); const w = await f.worker(); const base = w.inputBase;
	await writeFile(join(w.path, "main.txt"), "worker\n"); await writeFile(join(f.repo, "main.txt"), "parent\n");
	const result = await refreshGitInputs(w); assert.equal(result.status, "conflict"); assert.equal(w.inputBase, base);
	assert.equal(await contents(w.path, "main.txt"), "worker\n"); assert.equal(await contents(f.repo, "main.txt"), "parent\n");
	assert.ok(Object.keys(w.ownedRefs).some(ref => ref.includes("/refresh/")));
});
test("applying an already integrated candidate is a no-op and does not duplicate changes", async t => {
	const f = await fixture(t); const w = await f.worker(); await writeFile(join(w.path, "extra.txt"), "worker\n"); const candidate = await freezeGitCandidate(w);
	assert.equal((await applyGitCandidate(w, candidate)).status, "applied"); const again = await applyGitCandidate(w, candidate); assert.equal(again.status, "applied");
	if (again.status === "applied") assert.deepEqual(again.changedPaths, []);
});
test("candidate is immutable even if the idle task worktree changes later", async t => {
	const f = await fixture(t); const w = await f.worker(); await writeFile(join(w.path, "main.txt"), "frozen\n"); const candidate = await freezeGitCandidate(w);
	await writeFile(join(w.path, "main.txt"), "later\n"); assert.equal((await applyGitCandidate(w, candidate)).status, "applied"); assert.equal(await contents(f.repo, "main.txt"), "frozen\n");
});
test("candidate identity and merge base cannot be substituted", async t => {
	const f = await fixture(t); const w = await f.worker(); await writeFile(join(w.path, "main.txt"), "worker\n"); const candidate = await freezeGitCandidate(w);
	await assert.rejects(applyGitCandidate(w, { ...candidate, inputBase: candidate.commit }), { code: "candidate_base_mismatch" });
	await assert.rejects(applyGitCandidate(w, { ...candidate, workspaceId: "wrong" }), { code: "candidate_owner_mismatch" });
});
test("discard removes only the registered task and its exact refs, preserving siblings and user branches", async t => {
	const f = await fixture(t); await git(f.repo, "branch", "keep-me"); const a = await f.worker("a"); const b = await f.worker("b");
	await writeFile(join(a.path, "extra.txt"), "unapplied\n"); await freezeGitCandidate(a); const aRefs = Object.keys(a.ownedRefs);
	await discardGitWorkspace(a); await assert.rejects(stat(a.path), { code: "ENOENT" }); await inspectGitWorkspace(b);
	for (const ref of aRefs) await assert.rejects(git(f.repo, "show-ref", "--verify", ref));
	assert.ok(await git(f.repo, "show-ref", "--verify", "refs/heads/keep-me")); assert.equal(await contents(f.repo, "main.txt"), "base\n");
});
test("modified owned ref is not deleted as if it still belonged to this result", async t => {
	const f = await fixture(t); const w = await f.worker(); const ref = Object.keys(w.ownedRefs)[0]!;
	await git(f.repo, "update-ref", ref, await git(f.repo, "rev-parse", "HEAD"));
	await assert.rejects(discardGitWorkspace(w), { code: "owned_ref_changed" }); assert.equal(await contents(w.path, "main.txt"), "base\n");
});
test("existing destinations are never replaced", async t => {
	const f = await fixture(t); const dest = join(f.directory, "existing"); await mkdir(dest); await writeFile(join(dest, "keep"), "keep");
	await assert.rejects(createGitTaskWorkspace(f.repo, dest, await captureGitInput(f.repo)), { code: "workspace_destination_exists" }); assert.equal(await contents(dest, "keep"), "keep");
});
test("a substituted sibling path cannot be discarded with another task registration", async t => {
	const f = await fixture(t); const a = await f.worker("a"); const b = await f.worker("b");
	await assert.rejects(discardGitWorkspace({ ...a, path: b.path }), { code: "workspace_registration_changed" });
	await inspectGitWorkspace(a); await inspectGitWorkspace(b);
});
test("non-UTF8 path names fail explicitly instead of being silently reinterpreted", async t => {
	const f = await fixture(t); const file = Buffer.concat([Buffer.from(`${f.repo}/`), Buffer.from([0xff])]);
	await writeFile(file, "opaque filename"); await assert.rejects(captureGitInput(f.repo), { code: "unsupported_path_encoding" });
});
test("external symlinks are reported rather than imported into source input", async t => {
	const f = await fixture(t); await symlink("../elsewhere", join(f.repo, "escape")); await assert.rejects(captureGitInput(f.repo), { code: "unsupported_external_symlink" });
});
test("declared content filters are not silently executed during capture", async t => {
	const f = await fixture(t); await writeFile(join(f.repo, ".gitattributes"), "main.txt filter=custom\n");
	await assert.rejects(captureGitInput(f.repo), { code: "unsupported_content_filter" });
});
test("unresolved index conflict is different from ordinary dirty input", async t => {
	const f = await fixture(t); await git(f.repo, "checkout", "-qb", "other"); await writeFile(join(f.repo, "main.txt"), "other\n"); await git(f.repo, "commit", "-qam", "other");
	await git(f.repo, "checkout", "-q", "-"); await writeFile(join(f.repo, "main.txt"), "ours\n"); await git(f.repo, "commit", "-qam", "ours");
	await assert.rejects(git(f.repo, "merge", "other")); await assert.rejects(captureGitInput(f.repo), { code: "unresolved_index_conflict" });
});