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

test("explicit worker repository admission binds scope and read grants to the target, not origin", async t => {
 const f = await layout(t);
 for (const repository of ["../sibling", "bad\u0000path"]) assert.equal(validateGraphStructure({ tasks: [{ id: "w", role: "worker", objective: "edit", scope: ["."], repository }] }).ok, false);
 for (const role of ["explorer", "reviewer"] as const) assert.equal(validateGraphStructure({ tasks: [{ id: "r", role, objective: "read", scope: ["."], repository: f.sibling }] }).ok, false);
 const tasks = await structure([{ id: "w", role: "worker", objective: "edit", repository: f.sibling, scope: [f.sibling], externalReadRoots: [f.current] }]);
 const admitted = await admitRepositoryTasks(f.current, tasks); assert.equal(admitted.ok, true);
 if (!admitted.ok) return;
 assert.equal(admitted.gitRoot, f.current); assert.equal(admitted.tasks[0]!.repositoryTarget!.root, f.sibling); assert.deepEqual(admitted.tasks[0]!.scope, ["."]); assert.deepEqual(admitted.tasks[0]!.externalReadRoots, [f.current]);
 const defaults = await admitRepositoryTasks(f.current, await structure([{ id: "w", role: "worker", objective: "edit", scope: ["."] }]));
 assert.equal(defaults.ok && defaults.tasks[0]!.repositoryTarget, undefined);
 for (const repository of [f.plain, join(f.sibling, "lib"), join(f.parent, "missing")]) {
  const rejected = await admitRepositoryTasks(f.current, [{ ...tasks[0]!, repository }]); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "task_repository_unavailable");
 }
 const escape = await admitRepositoryTasks(f.current, [{ ...tasks[0]!, scope: [f.current] }]); assert.equal(escape.ok, false);
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

test("structure validation keeps absolute scope and permits explicit worker read roots", () => {
	const absolute = validateGraphStructure({
		tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["/tmp/current"] }],
	});
	assert.equal(absolute.ok, true);

	const worker = validateGraphStructure({
		tasks: [{
			id: "write",
			role: "worker",
			objective: "edit",
			scope: ["."],
			writePaths: ["src/a.ts"],
			externalReadRoots: ["/outside"],
		}],
	});
	assert.equal(worker.ok, true);

	const relativeExternal = validateGraphStructure({
		tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["."], externalReadRoots: ["../sibling"] }],
	});
	assert.equal(relativeExternal.ok, false);
	if (relativeExternal.ok) return;
	assert.equal(relativeExternal.error.code, "invalid_external_read_root");
});

test("permission-neutral arrays normalize without granting writes or external reads", () => {
	for (const role of ["explorer", "reviewer", "worker"] as const) {
		const result = validateGraphStructure({ tasks: [{ id: role, role, objective: "bounded", scope: ["."],
			writePaths: role === "worker" ? ["src/a.ts"] : [], externalReadRoots: [] }] });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.tasks[0]?.externalReadRoots, []);
			assert.deepEqual(result.tasks[0]?.writePaths, role === "worker" ? ["src/a.ts"] : []);
		}
	}
	assert.equal(validateGraphStructure({ tasks: [{ id: "review", role: "reviewer", objective: "bounded", scope: ["."], writePaths: ["a"] }] }).ok, false);
});

test("canonical Git discovery supports ordinary roots and linked worktrees", async (t) => {
	const { current } = await layout(t);
	const root = await findCanonicalGitRoot(join(current, "src"));
	assert.equal(root, await realpath(current));

	await exec("git", ["-C", current, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
	await exec("git", ["-C", current, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
	const worktree = join(current, "..", "linked");
	await exec("git", ["-C", current, "worktree", "add", "-q", worktree, "HEAD"]);
	assert.equal(await findCanonicalGitRoot(worktree), await realpath(worktree));
});

test("internal scope canonicalizes contained spellings and preserves missing files", async (t) => {
	const { current } = await layout(t);
	const gitRoot = await findCanonicalGitRoot(current);
	assert.equal(await canonicalizeInternalScope(gitRoot, "."), ".");
	assert.equal(await canonicalizeInternalScope(gitRoot, "src"), "src");
	assert.equal(await canonicalizeInternalScope(gitRoot, "src/tracked.ts"), "src/tracked.ts");
	assert.equal(await canonicalizeInternalScope(gitRoot, gitRoot), ".");
	assert.equal(await canonicalizeInternalScope(gitRoot, join(gitRoot, "src")), "src");
	assert.equal(await canonicalizeInternalScope(gitRoot, `../${basename(current)}/src/tracked.ts`), "src/tracked.ts");
	assert.equal(await canonicalizeInternalScope(gitRoot, "src/inside-link.ts"), "src/real.ts");
	assert.equal(await canonicalizeInternalScope(gitRoot, "src/new.ts"), "src/new.ts");
	assert.equal(await canonicalizeInternalScope(gitRoot, "src/..config/local.ts"), "src/..config/local.ts");

	await assert.rejects(canonicalizeInternalScope(gitRoot, "../sibling/secret.ts"), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "scope_outside_repository" && !error.message.includes("/")
	));
	await assert.rejects(canonicalizeInternalScope(gitRoot, join(current, "..", "sibling", "secret.ts")), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "scope_outside_repository"
	));
	await assert.rejects(canonicalizeInternalScope(gitRoot, "src/outside-link.ts"), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "scope_outside_repository"
	));
	await assert.rejects(canonicalizeInternalScope(gitRoot, "bad\0path"), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "invalid_scope"
	));
	await assert.rejects(canonicalizeInternalScope(gitRoot, "x".repeat(HARD_LIMITS.maxPathBytes + 1)), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "invalid_scope"
	));
});

test("non-Git cwd and unsafe paths fail before graph relationships", async (t) => {
	const { current, plain } = await layout(t);
	const tasks = await structure([explorer(["."])]);
	const missingGit = await admitRepositoryTasks(plain, tasks);
	assert.equal(missingGit.ok, false);
	if (missingGit.ok) return;
	assert.equal(missingGit.error.code, "repository_root_unavailable");
	assert.doesNotMatch(missingGit.error.message, /\/|plain/);

	const unsafe = validateGraphStructure({
		tasks: [{ id: "scan", role: "explorer", objective: "scan", scope: ["src\u2028dir"] }],
	});
	assert.equal(unsafe.ok, false);
	if (unsafe.ok) return;
	assert.equal(unsafe.error.code, "invalid_scope");

	const admitted = await admitRepositoryTasks(current, await structure([explorer(["src"])]));
	assert.equal(admitted.ok, true);
});

test("external roots require existing ordinary absolute targets outside the current repository", async (t) => {
	const { current, sibling, plain } = await layout(t);
	const gitRoot = await findCanonicalGitRoot(current);
	const siblingRoot = await realpath(sibling);
	assert.equal(await canonicalizeExternalReadRoot(gitRoot, siblingRoot), siblingRoot);
	assert.equal(await canonicalizeExternalReadRoot(gitRoot, join(sibling, "lib")), await realpath(join(sibling, "lib")));
	assert.equal(await canonicalizeExternalReadRoot(gitRoot, join(sibling, "secret.ts")), await realpath(join(sibling, "secret.ts")));
	assert.equal(await canonicalizeExternalReadRoot(gitRoot, join(sibling, "..config")), await realpath(join(sibling, "..config")));

	await assert.rejects(canonicalizeExternalReadRoot(gitRoot, "sibling"), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "invalid_external_read_root"
	));
	await assert.rejects(canonicalizeExternalReadRoot(gitRoot, join(sibling, "missing.ts")), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "external_read_root_unavailable"
	));
	assert.equal(await canonicalizeExternalReadRoot(gitRoot, plain), await realpath(plain));
	await assert.rejects(canonicalizeExternalReadRoot(gitRoot, join(current, "src")), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "external_read_root_not_external"
	));

	const unsafeCanonical = join(sibling, "unsafe\nroot");
	const safeAlias = join(sibling, "safe-alias");
	await mkdir(unsafeCanonical);
	await symlink(unsafeCanonical, safeAlias);
	await assert.rejects(canonicalizeExternalReadRoot(gitRoot, safeAlias), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "invalid_external_read_root"
	));

	const fifo = join(sibling, "named-pipe");
	await exec("mkfifo", [fifo]);
	await assert.rejects(canonicalizeExternalReadRoot(gitRoot, fifo), (error: unknown) => (
		error instanceof Error && "code" in error && error.code === "external_read_root_unavailable"
	));
});

test("admission canonicalizes a complete batch and rejects duplicates, workers, and escaping writes", async (t) => {
	const { current, sibling } = await layout(t);
	const gitRoot = await findCanonicalGitRoot(current);
	const siblingFile = await realpath(join(sibling, "secret.ts"));
	const admitted = await admitRepositoryTasks(current, await structure([
		explorer([join(gitRoot, "src"), `../${basename(current)}/README.md`], {
			externalReadRoots: [siblingFile, join(sibling, "lib", "..", "secret.ts")],
		}),
	]));
	assert.equal(admitted.ok, false);
	if (admitted.ok) return;
	assert.equal(admitted.error.code, "duplicate_external_read_root");
	assert.doesNotMatch(admitted.error.message, /secret/);

	const ok = await admitRepositoryTasks(current, await structure([
		explorer([".", "src/new.ts"], { externalReadRoots: [siblingFile] }),
		{
			id: "write",
			role: "worker",
			objective: "edit",
			scope: [join(gitRoot, "src"), "src/created.ts"],
			writePaths: ["src/tracked.ts", "src/created.ts"],
		},
	]));
	assert.equal(ok.ok, true);
	if (!ok.ok) return;
	assert.equal(ok.gitRoot, gitRoot);
	assert.deepEqual(ok.tasks[0]?.scope, [".", "src/new.ts"]);
	assert.deepEqual(ok.tasks[0]?.externalReadRoots, [siblingFile]);
	assert.deepEqual(ok.tasks[1]?.scope, ["src", "src/created.ts"]);
	assert.deepEqual(ok.tasks[1]?.externalReadRoots, []);
	assert.equal(validateGraphRelationships(ok.tasks).ok, true);

	const escaped = await admitRepositoryTasks(current, await structure([{
		id: "write",
		role: "worker",
		objective: "edit",
		scope: ["src"],
		writePaths: ["README.md"],
	}]));
	assert.equal(escaped.ok, true);
	if (!escaped.ok) return;
	const related = validateGraphRelationships(escaped.tasks);
	assert.equal(related.ok, false);
	if (related.ok) return;
	assert.equal(related.error.code, "write_outside_scope");
});

test("injectable host avoids ambient repository dependence", async () => {
	let probes = 0;
	const host: RepositoryHost = {
		async findGitToplevel() {
			probes += 1;
			throw new Error("ambient git must not run");
		},
		async realpath() {
			probes += 1;
			throw new Error("ambient realpath must not run");
		},
		async lstat() {
			probes += 1;
			throw new Error("ambient lstat must not run");
		},
	};
	const tasks = await structure([explorer(["."])]);
	const result = await admitRepositoryTasks("/nonexistent-cwd", tasks, host);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.code, "repository_root_unavailable");
	assert.ok(probes >= 1);
});

test("staged repository admission accepts ordinary relative callers", async (t) => {
	const { current } = await layout(t);
	for (const tasks of [
		[{ id: "scan", role: "explorer", objective: "scan", scope: ["."] }],
		[{ id: "write", role: "worker", objective: "edit", scope: ["src"], writePaths: ["src/a.ts"] }],
	]) {
		const normalized = await structure(tasks);
		const admitted = await admitRepositoryTasks(current, normalized);
		assert.equal(admitted.ok, true);
		if (!admitted.ok) throw new Error("expected repository admission");
		assert.equal(validateGraphRelationships(admitted.tasks).ok, true);
	}
});
