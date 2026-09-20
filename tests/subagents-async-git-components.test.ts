import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionExecutionSupervisor, type ExecutionEvent } from "../extensions/subagents/session-supervisor.ts";
import { captureGitInput, createGitTaskWorkspace, freezeGitCandidate, applyGitCandidate, refreshGitInputs, discardGitWorkspace, type GitTaskWorkspace, type GitCandidate } from "../extensions/subagents/git-workspace.ts";
const exec = promisify(execFile);
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function git(repo: string, ...args: string[]) { return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { timeout: 10_000, env: { PATH: process.env.PATH, HOME: "/nonexistent", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" } })).stdout.trim(); }
async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "csheng-components-")); const repo = join(directory, "repo"); await mkdir(repo);
	t.after(() => rm(directory, { recursive: true, force: true }));
	await git(repo, "init", "-q", "--template="); await writeFile(join(repo, "fast.ts"), "base fast\n"); await writeFile(join(repo, "slow.ts"), "base slow\n");
	await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "base"); return { directory, repo };
}

test("component integration: dirty input, two async writers, early apply, repair reuse, and owned close", { timeout: 15_000 }, async t => {
	const f = await fixture(t); await writeFile(join(f.repo, "plan.md"), "approved dirty plan\n"); await git(f.repo, "add", "plan.md");
	await writeFile(join(f.repo, "plan.md"), "approved dirty plan plus local notes\n");
	const index = await readFile(join(f.repo, ".git/index")); const head = await git(f.repo, "rev-parse", "HEAD");
	const started = { fast: deferred(), slow: deferred() }; const release = { fast: deferred(), slow: deferred() }; const fastTerminal = deferred<GitCandidate>();
	const workspaces = new Map<string, GitTaskWorkspace>(); const events: ExecutionEvent[] = [];
	const s = new SessionExecutionSupervisor({ repository: f.repo, sessionId: "test-session", branchAnchor: "test-anchor" }, { concurrency: 2, roles: { worker: 2, reviewer: 1, explorer: 1 } }, {
		onEvent: event => { events.push(event); if (event.task?.taskId === "fast" && event.task.phase === "completed") fastTerminal.resolve(event.task.result as GitCandidate); },
	});
	t.after(async () => { release.fast.resolve(); release.slow.resolve(); await s.shutdown(); });
	const receipt = await s.submit({ requestId: "batch", requestKey: "batch-input", prepare: () => captureGitInput(f.repo), execute: async (input, context) => Promise.all([
		...(["fast", "slow"] as const).map(id => context.runTask({ id, role: "worker" }, async () => {
			const workspace = await createGitTaskWorkspace(f.repo, join(f.directory, id), input); workspaces.set(id, workspace);
			assert.equal(await readFile(join(workspace.path, "plan.md"), "utf8"), "approved dirty plan plus local notes\n");
			started[id].resolve(); await release[id].promise;
			await writeFile(join(workspace.path, `${id}.ts`), `implemented ${id}\n`); return freezeGitCandidate(workspace);
		})),
	]) });
	assert.equal(receipt.kind, "submission"); await Promise.all([started.fast.promise, started.slow.promise]);
	await writeFile(join(f.repo, "main-local.txt"), "parent progressed while children ran\n");
	release.fast.resolve(); const fastCandidate = await fastTerminal.promise;
	assert.deepEqual(fastCandidate.changedPaths, ["fast.ts"]); assert.equal(s.inspect(receipt.runId)[0]!.phase, "running");
	const fastWorkspace = workspaces.get("fast")!;
	assert.equal((await applyGitCandidate(fastWorkspace, fastCandidate)).status, "applied");
	assert.equal(await readFile(join(f.repo, "slow.ts"), "utf8"), "base slow\n");
	// A later episode reuses the same workspace after explicitly refreshing new integrated inputs.
	const repair = await s.submit({ requestId: "repair", requestKey: "repair-fast", prepare: async () => fastWorkspace, execute: async (workspace, context) => context.runTask({ id: "fast-repair", role: "worker", resourceLocks: [workspace.id] }, async () => {
		assert.equal((await refreshGitInputs(workspace)).status, "refreshed");
		assert.equal(await readFile(join(workspace.path, "main-local.txt"), "utf8"), "parent progressed while children ran\n");
		await writeFile(join(workspace.path, "fast.ts"), "implemented fast\nrepair detail\n"); return freezeGitCandidate(workspace);
	}) });
	const repaired = await s.join(repair.runId); assert.equal(repaired.phase, "completed");
	assert.equal((await applyGitCandidate(fastWorkspace, repaired.result as GitCandidate)).status, "applied");
	release.slow.resolve(); const batch = await s.join(receipt.runId); assert.equal(batch.phase, "completed");
	const slowCandidate = batch.tasks.find(task => task.taskId === "slow")!.result as GitCandidate;
	assert.equal((await applyGitCandidate(workspaces.get("slow")!, slowCandidate)).status, "applied");
	assert.equal(await readFile(join(f.repo, "fast.ts"), "utf8"), "implemented fast\nrepair detail\n");
	assert.equal(await readFile(join(f.repo, "slow.ts"), "utf8"), "implemented slow\n");
	assert.equal(await readFile(join(f.repo, "main-local.txt"), "utf8"), "parent progressed while children ran\n");
	assert.deepEqual(await readFile(join(f.repo, ".git/index")), index); assert.equal(await git(f.repo, "rev-parse", "HEAD"), head);
	assert.ok(events.some(event => event.kind === "task-terminal"));
	for (const workspace of workspaces.values()) await discardGitWorkspace(workspace);
	assert.equal(await git(f.repo, "for-each-ref", "--format=%(refname)", "refs/csheng/subagents/"), "");
});

test("component integration: queued execution keeps its admitted input instead of recapturing later edits", { timeout: 15_000 }, async t => {
	const f = await fixture(t); const firstEnd = deferred(); const firstStart = deferred(); let w: GitTaskWorkspace | undefined;
	const s = new SessionExecutionSupervisor({ repository: f.repo, sessionId: "session", branchAnchor: null }, { concurrency: 1, roles: { worker: 1, reviewer: 1, explorer: 1 } });
	t.after(async () => { firstEnd.resolve(); await s.shutdown(); });
	const a = await s.submit({ requestId: "occupy", requestKey: "occupy", prepare: async () => undefined, execute: async (_, ctx) => ctx.runTask({ id: "occupy", role: "worker" }, async () => { firstStart.resolve(); await firstEnd.promise; }) });
	await firstStart.promise; await writeFile(join(f.repo, "plan.md"), "admitted\n");
	const b = await s.submit({ requestId: "queued", requestKey: "queued", prepare: () => captureGitInput(f.repo), execute: async (input, ctx) => ctx.runTask({ id: "queued", role: "worker" }, async () => { w = await createGitTaskWorkspace(f.repo, join(f.directory, "queued"), input); return readFile(join(w.path, "plan.md"), "utf8"); }) });
	await writeFile(join(f.repo, "plan.md"), "later parent revision\n"); firstEnd.resolve(); await s.join(a.runId);
	assert.equal((await s.join(b.runId)).result, "admitted\n"); assert.equal(await readFile(join(f.repo, "plan.md"), "utf8"), "later parent revision\n");
	await discardGitWorkspace(w!);
});

test("component integration: cancellation retains unaccepted work until an explicit discard", { timeout: 15_000 }, async t => {
	const f = await fixture(t); const started = deferred(); let workspace: GitTaskWorkspace | undefined; let wakes = 0;
	const s = new SessionExecutionSupervisor({ repository: f.repo, sessionId: "session", branchAnchor: null }, { concurrency: 1, roles: { worker: 1, reviewer: 1, explorer: 1 } }, { onWake: () => { wakes++; } });
	t.after(() => s.shutdown());
	const receipt = await s.submit({ requestId: "one", requestKey: "one", prepare: () => captureGitInput(f.repo), execute: async (input, ctx) => ctx.runTask({ id: "one", role: "worker" }, async signal => {
		workspace = await createGitTaskWorkspace(f.repo, join(f.directory, "cancelled"), input); await writeFile(join(workspace.path, "partial.txt"), "retain for diagnosis\n"); started.resolve();
		await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
	}) });
	await started.promise; s.cancel(receipt.runId); assert.equal((await s.join(receipt.runId)).phase, "cancelled");
	assert.equal(await readFile(join(workspace!.path, "partial.txt"), "utf8"), "retain for diagnosis\n");
	await assert.rejects(stat(join(f.repo, "partial.txt")), { code: "ENOENT" }); assert.equal(wakes, 0);
	await discardGitWorkspace(workspace!); await assert.rejects(stat(workspace!.path), { code: "ENOENT" });
});