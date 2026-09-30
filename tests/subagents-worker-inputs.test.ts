import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { captureGitInput, createGitTaskWorkspace, discardGitWorkspace, freezeGitCandidate } from "../extensions/subagents/git-workspace.ts";
import { inspectWorkerInputs, prepareWorkerInputs, refreshWorkerInputs } from "../extensions/subagents/worker-inputs.ts";
const exec = promisify(execFile);
async function fixture(t: TestContext) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "worker-inputs-")));
	const repo = join(directory, "repo"); await mkdir(repo);
	await exec("git", ["-C", repo, "init", "--quiet", "--template="]);
	await writeFile(join(repo, "a.txt"), "original");
	await writeFile(join(repo, ".gitignore"), "node_modules/\n.venv/\n");
	const workspace = await createGitTaskWorkspace(repo, join(directory, "source"), await captureGitInput(repo));
	t.after(async () => { try { await discardGitWorkspace(workspace); } finally { await rm(directory, { recursive: true, force: true }); } });
	return { directory, repo, source: workspace.path, workspace };
}

test("dispatch, inspect, refresh and freeze never traverse or copy ignored environments", async (t) => {
	const f = await fixture(t);
	for (const root of [f.repo, f.source]) {
		await mkdir(join(root, "node_modules/.pnpm"), { recursive: true });
		await symlink("../../outside-store", join(root, "node_modules/pkg"));
		await mkdir(join(root, ".venv"));
		await writeFile(join(root, ".venv/keep"), "project owned");
	}
	const touched: string[] = [];
	for (const method of ["readdir", "readFile", "cp", "readlink"] as const) {
		const original = fs[method];
		t.mock.method(fs, method, (...args: any[]) => {
			if (/node_modules|\.venv/.test(String(args[0]))) touched.push(`${method}:${args[0]}`);
			return (original as Function)(...args);
		});
	}
	const state = await prepareWorkerInputs(f.repo, f.source, f.workspace);
	await inspectWorkerInputs(f.source, state);
	await refreshWorkerInputs(f.repo, f.source, state);
	await writeFile(join(f.source, "bun.lock"), "ordinary source lockfile");
	const candidate = await freezeGitCandidate(f.workspace);
	assert.deepEqual(candidate.changedPaths, ["bun.lock"]);
	assert.deepEqual(touched, []);
	assert.equal(state.version, 2);
	assert.equal("dependencyKey" in state, false);
});

test("parent dependencies are not copied; local environments and legacy inert metadata survive refresh", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.repo, "node_modules")); await writeFile(join(f.repo, "node_modules/parent"), "not copied");
	const state = await prepareWorkerInputs(f.repo, f.source, f.workspace);
	await assert.rejects(lstat(join(f.source, "node_modules")), { code: "ENOENT" });
	await mkdir(join(f.source, "node_modules")); await writeFile(join(f.source, "node_modules/local"), "retained");
	const legacy = { version: 1 as const, dependencyRoots: ["node_modules" as const], dependencyKey: "a".repeat(64), parentDependencyKey: "b".repeat(64), gitWorkspace: { ...f.workspace, dependencyRoots: ["node_modules" as const] } };
	await inspectWorkerInputs(f.source, legacy);
	const next = await refreshWorkerInputs(f.repo, f.source, legacy);
	assert.equal(next.version, 2);
	assert.equal(await readFile(join(f.source, "node_modules/local"), "utf8"), "retained");
	assert.equal(state.gitWorkspace?.path, f.source);
});

test("worktree identity checks still reject root or Git administration replacement", async (t) => {
	const f = await fixture(t); const state = await prepareWorkerInputs(f.repo, f.source, f.workspace);
	const gitfile = await readFile(join(f.source, ".git"));
	await writeFile(join(f.source, ".git"), "gitdir: /nonexistent-worker-fixture\n");
	await assert.rejects(inspectWorkerInputs(f.source, state));
	await writeFile(join(f.source, ".git"), gitfile);
	await assert.rejects(inspectWorkerInputs(f.repo, state), { code: "managed_workspace_mismatch" });
});
