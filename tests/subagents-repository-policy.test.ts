import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HARD_LIMITS } from "../extensions/subagents/contracts.ts";
import { validateGraphRelationships, validateGraphStructure } from "../extensions/subagents/graph.ts";
import {
	admitRepositoryTasks,
	canonicalizeExternalReadRoot,
	captureRepositoryTarget,
	validateRepositoryTarget,
	canonicalizeInternalScope,
	findCanonicalGitRoot,
	type RepositoryHost,
} from "../extensions/subagents/repository-policy.ts";

const exec = promisify(execFile);

async function gitInit(root: string): Promise<void> {
	await exec("git", ["init", "-q", root]);
}

async function layout(t: test.TestContext): Promise<{ parent: string; current: string; sibling: string; plain: string }> {
	const parent = await mkdtemp(join(tmpdir(), "subagent-repo-policy-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const current = join(parent, "current");
	const sibling = join(parent, "sibling");
	const plain = join(parent, "plain");
	await mkdir(join(current, "src", "..config"), { recursive: true });
	await mkdir(join(sibling, "lib"), { recursive: true });
	await mkdir(join(sibling, "..config"), { recursive: true });
	await mkdir(plain);
	await gitInit(current);
	await gitInit(sibling);
	await writeFile(join(current, "README.md"), "root\n");
	await writeFile(join(current, "src", "tracked.ts"), "tracked\n");
	await writeFile(join(current, "src", "real.ts"), "real\n");
	await writeFile(join(current, "src", "..config", "local.ts"), "local\n");
	await writeFile(join(sibling, "secret.ts"), "secret\n");
	await writeFile(join(sibling, "..config", "external.ts"), "external\n");
	await writeFile(join(sibling, "lib", "util.ts"), "util\n");
	await symlink(join(current, "src", "real.ts"), join(current, "src", "inside-link.ts"));
	await symlink(join(sibling, "secret.ts"), join(current, "src", "outside-link.ts"));
	return { parent, current, sibling, plain };
}

function explorer(scope: string[], extra: Record<string, unknown> = {}) {
	return { id: "scan", role: "explorer", objective: "scan", scope, ...extra };
}

async function structure(tasks: Array<Record<string, unknown>>) {
	const result = validateGraphStructure({ tasks } as never);
	assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
	return result.ok ? result.tasks : [];
}

test("one task can write two Git roots and read evidence without a separate channel", async t => {
 const f = await layout(t);
 assert.equal(validateGraphStructure({ tasks: [{ id: "w", role: "explorer", objective: "edit", access: [{ permission: "write", scope: "*" }] }] }).ok, false);
 const tasks = await structure([{ id: "w", role: "explorer", objective: "edit", access: [{ permission: "write", scope: [f.current, f.sibling] }, { permission: "read", scope: f.plain }] }]);
 const admitted = await admitRepositoryTasks(f.current, tasks);
 assert.equal(admitted.ok, true);
 if (!admitted.ok) return;
 const writes = admitted.tasks[0]!.roots?.filter(root => root.permission === "write") ?? [];
 assert.deepEqual(writes.map(root => root.source).sort(), [f.current, f.sibling].sort());
 assert.equal(admitted.tasks[0]!.roots?.some(root => root.permission === "read" && root.source === f.plain), true);
 const relative = validateGraphStructure({ tasks: [{ id: "w", role: "worker", objective: "edit", access: [{ permission: "write", scope: "src" }] }] });
 assert.equal(relative.ok, false);
 const plainWrite = await admitRepositoryTasks(f.current, await structure([{ id: "w", role: "worker", objective: "edit", access: [{ permission: "write", scope: f.plain }] }]));
 assert.equal(plainWrite.ok, false);
 if (!plainWrite.ok) assert.equal(plainWrite.error.code, "non_git_write_unsupported");
});

for (const replace of ["root", "git-dir"] as const) test(`pinned repository detects replacement of ${replace} at the same path`, async t => {
 const f = await layout(t); const pin = await captureRepositoryTarget(f.sibling); await validateRepositoryTarget(pin);
 await rename(replace === "root" ? f.sibling : join(f.sibling, ".git"), join(f.parent, "old")); await gitInit(f.sibling);
 await assert.rejects(validateRepositoryTarget(pin), { code: "task_repository_changed" });
});

test("linked target detects independent common-directory replacement with unchanged worktree and Git-dir identities", async t => {
 const f = await layout(t); await exec("git", ["-C", f.sibling, "add", "secret.ts"]); await exec("git", ["-C", f.sibling, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
 const linked = join(f.parent, "linked"); await exec("git", ["-C", f.sibling, "worktree", "add", "--detach", linked]);
 const before = await captureRepositoryTarget(linked); const common = before.identities[2]!.path; const old = join(f.parent, "old-common");
 await rename(common, old); await mkdir(common); for (const entry of await readdir(old)) await rename(join(old, entry), join(common, entry));
 const after = await captureRepositoryTarget(linked); assert.deepEqual(after.identities.slice(0, 2), before.identities.slice(0, 2)); assert.notEqual(after.identities[2]!.ino, before.identities[2]!.ino);
 await assert.rejects(validateRepositoryTarget(before), { code: "task_repository_changed" });
});
