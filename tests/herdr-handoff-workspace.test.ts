import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	WorkspaceError,
	assertManagedParent,
	captureBaseline,
	inspectPostflight,
	normalizeWritePath,
	resolveGitIdentity,
	validateAllowedWrites,
	validateRecipientWorktree,
} from "../extensions/herdr-handoff/workspace.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
	await exec("git", ["-C", cwd, ...args]);
}

async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "herdr-handoff-git-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q", root]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "test"]);
	await mkdir(join(root, "src"));
	await writeFile(join(root, ".gitignore"), "ignored.txt\n");
	await writeFile(join(root, "src", "tracked.ts"), "index\n", { mode: 0o644 });
	await writeFile(join(root, "src", "other.ts"), "other\n");
	await git(root, ["add", ".gitignore", "src/tracked.ts", "src/other.ts"]);
	await git(root, ["commit", "-qm", "init"]);
	return root;
}

async function linkedWorktree(t: test.TestContext, root: string): Promise<string> {
	const dest = await mkdtemp(join(tmpdir(), "herdr-handoff-worktree-"));
	t.after(async () => {
		await exec("git", ["-C", root, "worktree", "remove", "--force", dest]).catch(() => undefined);
		await rm(dest, { recursive: true, force: true });
	});
	await rm(dest, { recursive: true, force: true });
	await exec("git", ["-C", root, "worktree", "add", "-q", dest, "HEAD"]);
	return dest;
}

test("allowed create and modify in a clean isolated worktree pass postflight", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	await validateRecipientWorktree(root, recipient, "delegate-return");
	const baseline = await captureBaseline(recipient, ["src/tracked.ts", "src/new.ts"]);
	await writeFile(join(recipient, "src", "tracked.ts"), "changed\n");
	await writeFile(join(recipient, "src", "new.ts"), "new\n");
	const postflight = await inspectPostflight(baseline, recipient);
	assert.equal(postflight.status, "within_declared_writes");
	assert.deepEqual(postflight.changedPaths, ["src/new.ts", "src/tracked.ts"]);
});

test("pre-existing dirty allowed path can change again; unrelated dirt must stay identical", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	await writeFile(join(recipient, "src", "tracked.ts"), "dirty-allowed\n");
	await writeFile(join(recipient, "src", "other.ts"), "dirty-other\n");
	const baseline = await captureBaseline(recipient, ["src/tracked.ts"]);
	await writeFile(join(recipient, "src", "tracked.ts"), "dirty-allowed-2\n");
	const ok = await inspectPostflight(baseline, recipient);
	assert.equal(ok.status, "within_declared_writes");
	await writeFile(join(recipient, "src", "other.ts"), "concurrent\n");
	const violated = await inspectPostflight(baseline, recipient);
	assert.equal(violated.status, "scope_violation");
});

test("outside path, delete, symlink, mode, index, and HEAD changes are violations", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const baseline = await captureBaseline(recipient, ["src/tracked.ts"]);
	await writeFile(join(recipient, "src", "outside.ts"), "nope\n");
	assert.equal((await inspectPostflight(baseline, recipient)).status, "scope_violation");

	const deleted = await captureBaseline(recipient, ["src/tracked.ts"]);
	await rm(join(recipient, "src", "tracked.ts"));
	assert.equal((await inspectPostflight(deleted, recipient)).error?.code, "scope_violation");

	const linked = await linkedWorktree(t, root);
	const symlinkBase = await captureBaseline(linked, ["src/tracked.ts"]);
	await rm(join(linked, "src", "tracked.ts"));
	await symlink(join(linked, "src", "other.ts"), join(linked, "src", "tracked.ts"));
	assert.equal((await inspectPostflight(symlinkBase, linked)).status, "scope_violation");

	const modeRepo = await linkedWorktree(t, root);
	const modeBase = await captureBaseline(modeRepo, ["src/tracked.ts"]);
	await chmod(join(modeRepo, "src", "tracked.ts"), 0o600);
	assert.equal((await inspectPostflight(modeBase, modeRepo)).status, "scope_violation");

	const indexRepo = await linkedWorktree(t, root);
	const indexBase = await captureBaseline(indexRepo, ["src/tracked.ts"]);
	await writeFile(join(indexRepo, "src", "staged.ts"), "staged\n");
	await git(indexRepo, ["add", "src/staged.ts"]);
	assert.equal((await inspectPostflight(indexBase, indexRepo)).error?.code, "index_changed");

	const historyRepo = await linkedWorktree(t, root);
	const historyBase = await captureBaseline(historyRepo, ["src/tracked.ts"]);
	await writeFile(join(historyRepo, "src", "tracked.ts"), "commit\n");
	await git(historyRepo, ["add", "src/tracked.ts"]);
	await git(historyRepo, ["commit", "-qm", "move"]);
	assert.equal((await inspectPostflight(historyBase, historyRepo)).error?.code, "history_changed");
});

test("ignored files stay outside postflight observability", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const baseline = await captureBaseline(recipient, ["src/tracked.ts"]);
	await writeFile(join(recipient, "ignored.txt"), "secret\n");
	const postflight = await inspectPostflight(baseline, recipient);
	assert.equal(postflight.status, "within_declared_writes");
	assert.deepEqual(postflight.changedPaths, []);
});

test("unborn repositories and nested cwd keep worktree identity", async (t) => {
	const unborn = await mkdtemp(join(tmpdir(), "herdr-handoff-unborn-"));
	t.after(async () => rm(unborn, { recursive: true, force: true }));
	await exec("git", ["init", "-q", unborn]);
	const identity = await resolveGitIdentity(unborn);
	assert.equal(identity.unborn, true);

	const root = await repository(t);
	const nested = await resolveGitIdentity(join(root, "src"));
	const top = await resolveGitIdentity(root);
	assert.equal(nested.worktreeRoot, top.worktreeRoot);
});

test("parent checkout and unrelated repositories are rejected; transfer requires clean isolation", async (t) => {
	const root = await repository(t);
	await assert.rejects(validateRecipientWorktree(root, root, "delegate-return"), (error: unknown) => (
		error instanceof WorkspaceError && error.code === "workspace_mismatch"
	));
	await assert.rejects(validateRecipientWorktree(root, root, "transfer"), (error: unknown) => (
		error instanceof WorkspaceError && error.code === "workspace_mismatch"
	));

	const other = await repository(t);
	await assert.rejects(validateRecipientWorktree(root, other, "delegate-return"), (error: unknown) => (
		error instanceof WorkspaceError && error.code === "workspace_mismatch"
	));

	const recipient = await linkedWorktree(t, root);
	await validateRecipientWorktree(root, recipient, "transfer");
	await writeFile(join(recipient, "src", "tracked.ts"), "dirty\n");
	await assert.rejects(validateRecipientWorktree(root, recipient, "transfer"), (error: unknown) => (
		error instanceof WorkspaceError && error.code === "workspace_dirty"
	));
	await captureBaseline(recipient, ["src/tracked.ts"]);
});

test("write path admission rejects traversal, absolute, symlink, directory, duplicate, and missing parent", async (t) => {
	const root = await repository(t);
	await assertManagedParent(root);
	assert.throws(() => normalizeWritePath("../x"));
	assert.throws(() => normalizeWritePath("/tmp/x"));
	await assert.rejects(validateAllowedWrites(root, ["src"]), (error: unknown) => error instanceof WorkspaceError);
	await assert.rejects(validateAllowedWrites(root, ["src/tracked.ts", "src/tracked.ts"]), (error: unknown) => error instanceof WorkspaceError);
	await assert.rejects(validateAllowedWrites(root, ["missing/dir/file.ts"]), (error: unknown) => error instanceof WorkspaceError);
	const outside = await mkdtemp(join(tmpdir(), "herdr-handoff-out-"));
	t.after(async () => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "file.ts"), "x");
	await symlink(join(outside, "file.ts"), join(root, "src", "link.ts"));
	await assert.rejects(validateAllowedWrites(root, ["src/link.ts"]), (error: unknown) => error instanceof WorkspaceError);
});
