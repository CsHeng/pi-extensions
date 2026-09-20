import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { validateGraphStructure, type NormalizedTask } from "../extensions/subagents/graph.ts";
import { createWorkerWorkspace, WorkspaceError } from "../extensions/subagents/workspace.ts";

const exec = promisify(execFile);
function worker(writePaths: string[]): NormalizedTask {
	return { id: "worker", role: "worker", objective: "edit", scope: ["."], inputs: [], dependsOn: [], writePaths, verification: [], resourceLocks: [], externalReadRoots: [] };
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

test("graph write hints are optional but remain safe and repository-relative", () => {
	const absoluteWrite = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "edit", scope: ["."], writePaths: ["/tmp/file.ts"] }] });
	assert.equal(absoluteWrite.ok, false);
	if (absoluteWrite.ok) return;
	assert.equal(absoluteWrite.error.code, "invalid_write_path");
	assert.match(absoluteWrite.error.message, /unsafe write path/);
	const missingWrites = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "edit", scope: ["."] }] });
	assert.equal(missingWrites.ok, true);
	if (missingWrites.ok) assert.deepEqual(missingWrites.tasks[0]!.writePaths, []);
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
