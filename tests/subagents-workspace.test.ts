import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { validateGraph, type NormalizedTask } from "../extensions/subagents/graph.ts";
import { convergeWorkerWorkspace, createWorkerWorkspace, WorkspaceError } from "../extensions/subagents/workspace.ts";

const exec = promisify(execFile);

function worker(writePaths: string[]): NormalizedTask {
	return {
		id: "worker",
		role: "worker",
		objective: "edit",
		scope: ["."],
		inputs: [],
		dependsOn: [],
		writePaths,
		verification: [],
		resourceLocks: [],
		externalReadRoots: [],
	};
}

async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-workspace-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q", root]);
	await mkdir(join(root, "src"));
	await writeFile(join(root, ".gitignore"), "ignored.txt\n");
	await writeFile(join(root, "src", "tracked.ts"), "index\n", { mode: 0o640 });
	await writeFile(join(root, "src", "staged.ts"), "staged\n");
	await writeFile(join(root, "src", "deleted.ts"), "deleted\n");
	await exec("git", ["-C", root, "add", ".gitignore", "src/tracked.ts", "src/staged.ts", "src/deleted.ts"]);
	await rm(join(root, "src", "deleted.ts"));
	await writeFile(join(root, "src", "tracked.ts"), "working\n", { mode: 0o640 });
	await writeFile(join(root, "src", "untracked.ts"), "untracked\n");
	await writeFile(join(root, "ignored.txt"), "secret\n");
	return root;
}

test("snapshot preserves dirty, staged, and eligible untracked state while excluding Git and ignored files", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => workspace.cleanup());
	assert.equal(await readFile(join(workspace.root, "src", "tracked.ts"), "utf8"), "working\n");
	assert.equal(await readFile(join(workspace.root, "src", "staged.ts"), "utf8"), "staged\n");
	assert.equal(await readFile(join(workspace.root, "src", "untracked.ts"), "utf8"), "untracked\n");
	await assert.rejects(lstat(join(workspace.root, ".git")), /ENOENT/);
	await assert.rejects(lstat(join(workspace.root, "ignored.txt")), /ENOENT/);
	await assert.rejects(lstat(join(workspace.root, "src", "deleted.ts")), /ENOENT/);
});

test("managed bounded source admission preserves ordinary unstaged deletions", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts"]), { maxBytes: 1024 * 1024, maxEntries: 100 });
	t.after(() => workspace.cleanup());
	await assert.rejects(lstat(join(workspace.root, "src/deleted.ts")), { code: "ENOENT" });
	assert.equal(await readFile(join(workspace.root, "src/tracked.ts"), "utf8"), "working\n");
});

test("snapshot permits repository components beginning with two dots", async (t) => {
	const root = await repository(t);
	await mkdir(join(root, "..state"));
	await writeFile(join(root, "..state", "tracked.ts"), "state\n");
	await exec("git", ["-C", root, "add", "..state/tracked.ts"]);
	const workspace = await createWorkerWorkspace(root, worker(["..state/tracked.ts"]));
	t.after(() => workspace.cleanup());
	assert.equal(await readFile(join(workspace.root, "..state", "tracked.ts"), "utf8"), "state\n");
});

test("convergence atomically applies exact create and modify operations with mode preservation", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts", "src/new.ts"]));
	t.after(() => workspace.cleanup());
	await writeFile(join(workspace.root, "src", "tracked.ts"), "changed\n");
	await writeFile(join(workspace.root, "src", "new.ts"), "new\n", { mode: 0o644 });
	const result = await convergeWorkerWorkspace(workspace);
	assert.deepEqual(result, { ok: true, changedPaths: ["src/new.ts", "src/tracked.ts"] });
	assert.equal(await readFile(join(root, "src", "tracked.ts"), "utf8"), "changed\n");
	assert.equal((await lstat(join(root, "src", "tracked.ts"))).mode & 0o777, 0o640);
	assert.equal(await readFile(join(root, "src", "new.ts"), "utf8"), "new\n");
});

test("declared new files create missing internal directories only when applied", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["new/nested/file.ts"]));
	t.after(() => workspace.cleanup());
	await assert.rejects(lstat(join(root, "new")), { code: "ENOENT" });
	await writeFile(join(workspace.root, "new/nested/file.ts"), "candidate");
	assert.equal((await convergeWorkerWorkspace(workspace)).ok, true);
	assert.equal(await readFile(join(root, "new/nested/file.ts"), "utf8"), "candidate");
});

test("new-file directory replacement cannot escape during apply", async (t) => {
	const root = await repository(t);
	const outside = await mkdtemp(join(tmpdir(), "subagent-new-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	const workspace = await createWorkerWorkspace(root, worker(["new/file.ts"]));
	t.after(() => workspace.cleanup());
	await writeFile(join(workspace.root, "new/file.ts"), "candidate");
	await symlink(outside, join(root, "new"));
	await assert.rejects(convergeWorkerWorkspace(workspace), (error: unknown) => error instanceof WorkspaceError && error.code === "write_symlink");
	await assert.rejects(lstat(join(outside, "file.ts")), { code: "ENOENT" });
});

test("convergence rejects ancestor replacement rather than applying into another repository", async (t) => {
	const base = await repository(t);
	const parent = join(base, "parent");
	const root = join(parent, "repo");
	await mkdir(root, { recursive: true });
	await exec("git", ["init", "-q", root]);
	const workspace = await createWorkerWorkspace(root, worker(["new/file.ts"]));
	t.after(() => workspace.cleanup());
	await writeFile(join(workspace.root, "new/file.ts"), "candidate");
	await mkdir(join(base, "outside", "repo"), { recursive: true });
	await rename(parent, join(base, "preserved"));
	await symlink(join(base, "outside"), parent);
	await assert.rejects(convergeWorkerWorkspace(workspace), (error: unknown) => error instanceof WorkspaceError && error.code === "write_symlink");
	await assert.rejects(lstat(join(base, "outside", "repo", "new")), { code: "ENOENT" });
});

test("empty complete worker diff fails without mutating the parent", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => workspace.cleanup());
	const result = await convergeWorkerWorkspace(workspace);
	assert.equal(result.ok, false);
	assert.deepEqual(result.changedPaths, []);
	assert.equal(result.error?.code, "worker_no_changes");
	assert.equal(await readFile(join(root, "src", "tracked.ts"), "utf8"), "working\n");
});

test("declared parent drift takes precedence over the empty-worker diagnostic", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => workspace.cleanup());
	await writeFile(join(root, "src", "tracked.ts"), "external\n");
	const result = await convergeWorkerWorkspace(workspace);
	assert.equal(result.error?.code, "convergence_conflict");
	assert.deepEqual(result.changedPaths, []);
	assert.equal(await readFile(join(root, "src", "tracked.ts"), "utf8"), "external\n");
});

test("undeclared mutation takes precedence over the empty-worker diagnostic", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => workspace.cleanup());
	await writeFile(join(workspace.root, "src", "untracked.ts"), "bad\n");
	const result = await convergeWorkerWorkspace(workspace);
	assert.equal(result.error?.code, "unexpected_worker_change");
	assert.deepEqual(result.changedPaths, ["src/untracked.ts"]);
	assert.equal(await readFile(join(root, "src", "untracked.ts"), "utf8"), "untracked\n");
});

test("unexpected mutation and parent drift fail without overwriting parent state", async (t) => {
	const root = await repository(t);
	const unexpected = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => unexpected.cleanup());
	await writeFile(join(unexpected.root, "src", "untracked.ts"), "bad\n");
	const rejected = await convergeWorkerWorkspace(unexpected);
	assert.equal(rejected.error?.code, "unexpected_worker_change");
	assert.equal(await readFile(join(root, "src", "untracked.ts"), "utf8"), "untracked\n");

	const conflict = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => conflict.cleanup());
	await writeFile(join(conflict.root, "src", "tracked.ts"), "worker\n");
	await writeFile(join(root, "src", "tracked.ts"), "external\n");
	const conflicted = await convergeWorkerWorkspace(conflict);
	assert.equal(conflicted.error?.code, "convergence_conflict");
	assert.equal(await readFile(join(root, "src", "tracked.ts"), "utf8"), "external\n");
});

test("graph path diagnostics keep write paths exact and repository-relative", () => {
	const absoluteWrite = validateGraph({
		tasks: [{ id: "worker", role: "worker", objective: "edit", scope: ["."], writePaths: ["/tmp/file.ts"] }],
	});
	assert.equal(absoluteWrite.ok, false);
	if (absoluteWrite.ok) return;
	assert.equal(absoluteWrite.error.code, "invalid_write_path");
	assert.match(absoluteWrite.error.message, /unsafe write path/);

	const missingWrites = validateGraph({
		tasks: [{ id: "worker", role: "worker", objective: "edit", scope: ["."] }],
	});
	assert.equal(missingWrites.ok, false);
	if (missingWrites.ok) return;
	assert.equal(missingWrites.error.code, "worker_write_paths_required");
	assert.match(missingWrites.error.message, /exact repository-relative files in writePaths/);
	assert.match(missingWrites.error.message, /not inferred/);
});

test("snapshot rejects escaping write symlinks and non-Git workspaces", async (t) => {
	const root = await repository(t);
	const outside = await mkdtemp(join(tmpdir(), "subagent-workspace-outside-"));
	t.after(async () => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "file"), "outside");
	await symlink(join(outside, "file"), join(root, "src", "link.ts"));
	await assert.rejects(createWorkerWorkspace(root, worker(["src/link.ts"])), (error: unknown) => error instanceof WorkspaceError && error.code === "write_symlink");

	const plain = await mkdtemp(join(tmpdir(), "subagent-nongit-"));
	t.after(async () => rm(plain, { recursive: true, force: true }));
	await assert.rejects(createWorkerWorkspace(plain, worker(["file"])), (error: unknown) => error instanceof WorkspaceError && error.code === "writable_isolation_unavailable");
});

test("worker permission changes are rejected", async (t) => {
	const root = await repository(t);
	const workspace = await createWorkerWorkspace(root, worker(["src/tracked.ts"]));
	t.after(() => workspace.cleanup());
	await chmod(join(workspace.root, "src", "tracked.ts"), 0o600);
	const result = await convergeWorkerWorkspace(workspace);
	assert.equal(result.error?.code, "unexpected_worker_change");
});
