import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { inspectWorkerInputs, prepareWorkerInputs, refreshWorkerInputs, scanWorkerSource, workerSourceFingerprint } from "../extensions/subagents/worker-inputs.ts";
const exec = promisify(execFile);
async function fixture(t: TestContext, dependencies = true) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "worker-inputs-")));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const repo = join(directory, "repo"); await mkdir(repo);
	await exec("git", ["-C", repo, "init", "--quiet", "--template="]);
	await writeFile(join(repo, "a.txt"), "original");
	await writeFile(join(repo, ".gitignore"), "node_modules/\nignored/\n");
	await exec("git", ["-C", repo, "add", "a.txt", ".gitignore"]);
	await exec("git", ["-C", repo, "config", "--local", "remote.origin.url", "https://private.invalid/repo"]);
	if (dependencies) { await mkdir(join(repo, "node_modules", "pkg"), { recursive: true }); await writeFile(join(repo, "node_modules", "pkg", "index.js"), "dependency"); }
	const makeSource = async (name: string) => { const source = join(directory, name); await mkdir(source); for (const path of ["a.txt", ".gitignore"]) await cp(join(repo, path), join(source, path)); return source; };
	return { directory, repo, source: await makeSource("source"), makeSource };
}

test("private dependency copies and Git index never share parent mutation or metadata", async (t) => {
	const f = await fixture(t);
	const originalConfig = await readFile(join(f.repo, ".git", "config")); const originalIndex = await readFile(join(f.repo, ".git", "index"));
	const state = await prepareWorkerInputs(f.repo, f.source);
	const other = await f.makeSource("other"); await prepareWorkerInputs(f.repo, other);
	assert.equal((await exec("git", ["-C", f.source, "diff", "--name-only"])).stdout, "");
	assert.doesNotMatch(await readFile(join(f.source, ".git", "config"), "utf8"), /private.invalid|remote/);
	await assert.rejects(lstat(join(f.source, ".git", "hooks")), { code: "ENOENT" });
	await writeFile(join(f.source, "a.txt"), "owned edit");
	assert.equal((await exec("git", ["-C", f.source, "diff", "--name-only"])).stdout.trim(), "a.txt");
	const path = "node_modules/pkg/index.js";
	assert.notEqual((await lstat(join(f.repo, path))).ino, (await lstat(join(f.source, path))).ino);
	await writeFile(join(f.source, path), "private dependency edit");
	assert.equal(await readFile(join(f.repo, path), "utf8"), "dependency"); assert.equal(await readFile(join(other, path), "utf8"), "dependency");
	assert.deepEqual(await readFile(join(f.repo, ".git", "config")), originalConfig); assert.deepEqual(await readFile(join(f.repo, ".git", "index")), originalIndex);
	assert.notEqual((await inspectWorkerInputs(f.source, state)).dependencyKey, state.dependencyKey);
});

test("refresh retains useful local dependencies until parent input changes without overwriting owned source", async (t) => {
	const f = await fixture(t); let state = await prepareWorkerInputs(f.repo, f.source);
	await writeFile(join(f.source, "a.txt"), "owned edit");
	await writeFile(join(f.source, "node_modules/pkg/index.js"), "private edit");
	state = await refreshWorkerInputs(f.repo, f.source, state);
	assert.equal(await readFile(join(f.source, "node_modules/pkg/index.js"), "utf8"), "private edit");
	await writeFile(join(f.repo, "node_modules/pkg/index.js"), "parent update");
	state = await refreshWorkerInputs(f.repo, f.source, state);
	assert.equal(await readFile(join(f.source, "node_modules/pkg/index.js"), "utf8"), "parent update");
	assert.equal(await readFile(join(f.source, "a.txt"), "utf8"), "owned edit");
	assert.equal(state.parentDependencyKey, state.dependencyKey);
});

test("local dependency preparation from absence is retained and source versus environment identities remain separate", async (t) => {
	const f = await fixture(t, false); const state = await prepareWorkerInputs(f.repo, f.source);
	const before = await workerSourceFingerprint(f.source, state); const environment = await inspectWorkerInputs(f.source, state);
	await mkdir(join(f.source, "node_modules", "pkg"), { recursive: true }); await writeFile(join(f.source, "node_modules", "pkg", "index.js"), "prepared locally");
	const next = await refreshWorkerInputs(f.repo, f.source, state);
	assert.equal(await workerSourceFingerprint(f.source, next), before);
	assert.notEqual((await inspectWorkerInputs(f.source, next)).environmentKey, environment.environmentKey);
	await mkdir(join(f.source, "ignored")); await writeFile(join(f.source, "ignored", "unknown.txt"), "not blanket-excluded");
	assert.equal((await scanWorkerSource(f.source, next)).has("ignored/unknown.txt"), true);
	assert.notEqual(await workerSourceFingerprint(f.source, next), before);
	await chmod(join(f.source, "ignored"), 0o700);
	assert.equal((await scanWorkerSource(f.source, next)).get("ignored")?.mode, 0o700);
});

test("relative dependency links stay private, escapes and failed refresh preserve the prior tree", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.repo, "node_modules", ".bin")); await symlink("../pkg/index.js", join(f.repo, "node_modules", ".bin", "pkg"));
	const state = await prepareWorkerInputs(f.repo, f.source);
	assert.equal(await realpath(join(f.source, "node_modules/.bin/pkg")), join(f.source, "node_modules/pkg/index.js"));
	await symlink(join(f.repo, "a.txt"), join(f.repo, "node_modules", "bad"));
	await assert.rejects(refreshWorkerInputs(f.repo, f.source, state), { code: "worker_input_link_invalid" });
	assert.equal(await readFile(join(f.source, "node_modules/pkg/index.js"), "utf8"), "dependency");
	await writeFile(join(f.source, ".git", "commondir"), join(f.repo, ".git"));
	await assert.rejects(inspectWorkerInputs(f.source, state), { code: "worker_input_git_redirect" });
});

test("staged workspace link chains and source links to not-yet-copied dependencies resolve in the final private namespace", async (t) => {
	const f = await fixture(t, false);
	await mkdir(join(f.repo, "packages/pkg"), { recursive: true }); await writeFile(join(f.repo, "packages/pkg/bin.js"), "workspace package");
	await cp(join(f.repo, "packages"), join(f.source, "packages"), { recursive: true });
	await mkdir(join(f.repo, "node_modules/.bin"), { recursive: true });
	await symlink("../packages/pkg", join(f.repo, "node_modules/pkg"));
	await symlink("../pkg/bin.js", join(f.repo, "node_modules/.bin/pkg"));
	await mkdir(join(f.source, "vendor")); await symlink("../node_modules/pkg", join(f.source, "vendor/pkg"));
	const state = await prepareWorkerInputs(f.repo, f.source);
	assert.equal(await realpath(join(f.source, "node_modules/.bin/pkg")), join(f.source, "packages/pkg/bin.js"));
	assert.equal(await realpath(join(f.source, "vendor/pkg")), join(f.source, "packages/pkg"));
	assert.equal((await scanWorkerSource(f.source, state)).get("vendor/pkg")?.kind, "symlink");
	await writeFile(join(f.repo, "node_modules/extra.js"), "new dependency input");
	await refreshWorkerInputs(f.repo, f.source, state);
	assert.equal(await realpath(join(f.source, "node_modules/.bin/pkg")), join(f.source, "packages/pkg/bin.js"));
});

test("source root replacement and unsupported entries fail visibly", async (t) => {
	const f = await fixture(t, false); const state = await prepareWorkerInputs(f.repo, f.source);
	await exec("mkfifo", [join(f.source, "fifo")]);
	await assert.rejects(scanWorkerSource(f.source, state), { code: "worker_input_special_entry" });
	await rm(join(f.source, "fifo")); await rm(f.source, { recursive: true }); await symlink(f.repo, f.source);
	await assert.rejects(scanWorkerSource(f.source, state), { code: "worker_input_root_invalid" });
});
