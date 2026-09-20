import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContinuationService } from "../extensions/subagents/continuation.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import type { SessionActionResult } from "../extensions/subagents/session-contracts.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { emptyUsage, type TaskResult } from "../extensions/subagents/contracts.ts";
import type { ChildRunOptions } from "../extensions/subagents/runner.ts";
import type { SubagentExecutionEvent } from "../extensions/shared/subagent-execution.ts";
const git = promisify(execFile);
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(t: test.TestContext, runner: (options: ChildRunOptions) => Promise<void>, concurrency = 2) {
	const base = await mkdtemp(join(tmpdir(), "subagent-v3-")); const repo = join(base, "repo"); await mkdir(repo);
	await git("git", ["init", "-q", repo]); await writeFile(join(repo, "base.txt"), "dirty parent\n");
	const model = { provider: "fixture", id: "fixture", reasoning: false };
	const ctx = { mode: "tui", cwd: repo, isProjectTrusted: () => true, model, thinkingLevel: "off", scopedModels: [], modelRegistry: { getAll: () => [model], getAvailable: () => [model] }, sessionManager: { getSessionId: () => "parent", getLeafId: () => "anchor", getBranch: () => [{ id: "anchor" }] } } as unknown as ExtensionContext;
	const store = new ManagedSessionStore(base); const events: SubagentExecutionEvent[] = []; const wakes: SubagentExecutionEvent[] = [];
	const config = defaultConfig(); config.maxConcurrency = concurrency;
	const service = new ContinuationService({ store, loadConfig: async () => ({ config }), onExecution: event => { events.push(event); }, onWake: values => { wakes.push(...values); }, runChild: async options => {
		options.onChildStarted?.();
		try { await runner(options); } finally { options.onChildSettled?.(); }
		return { id: options.task.id, role: options.task.role, status: "succeeded", output: "report", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applied", reportComplete: true, workerToolsSettled: true } satisfies TaskResult;
	} });
	t.after(async () => { await service.shutdown(); for (const view of await service.contextIndex(ctx)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, ctx); await rm(base, { recursive: true, force: true }); });
	return { repo, ctx, store, service, events, wakes };
}
const task = (id: string) => ({ id, role: "worker" as const, objective: "change source", scope: ["."], writePaths: [] });

test("v3 receipts precede completion, early apply leaves sibling active, fixed input and explicit refresh reuse worktree", async t => {
	const slow = gate(); const started = gate(); const paths: string[] = [];
	t.after(() => slow.release());
	const f = await fixture(t, async options => {
		if (options.task.id === "fast") paths.push(options.cwd);
		if (options.task.id === "slow") { started.release(); await slow.promise; }
		assert.equal(await readFile(join(options.cwd, "base.txt"), "utf8"), options.prompt === "repair" ? "new parent\n" : "dirty parent\n");
		await writeFile(join(options.cwd, `${options.task.id}.txt`), options.prompt === "repair" ? "repair\n" : "first\n");
	});
	const receipt = await f.service.execute({ action: "create", requestId: "batch", tasks: [task("fast"), task("slow")] }, f.ctx, undefined, undefined, "submission-call");
	assert.equal(receipt.status, "accepted", JSON.stringify(receipt)); assert.equal(receipt.schemaVersion, 3);
	await started.promise;
	await writeFile(join(f.repo, "base.txt"), "new parent\n");
	for (let attempt = 0; !f.events.some(event => event.kind === "task-terminal" && event.sessions[0]?.result?.id === "fast"); attempt++) { assert.ok(attempt < 500); await new Promise(resolve => setTimeout(resolve, 5)); }
	const early = f.events.find(event => event.kind === "task-terminal" && event.sessions[0]?.result?.id === "fast")!;
	assert.equal(early.toolCallId, "submission-call"); assert.ok(early.sessions[0]!.candidate);
	const view = early.sessions[0]!;
	const apply = await f.service.execute({ action: "apply", handle: view.handle, expectedEpisode: view.episode, candidateId: view.candidate!.id }, f.ctx);
	assert.equal(apply.status, "succeeded", JSON.stringify(apply)); assert.equal(await readFile(join(f.repo, "base.txt"), "utf8"), "new parent\n");
	assert.equal((await f.service.execute({ action: "inspect", runId: receipt.runId }, f.ctx)).status, "accepted");
	assert.equal((await f.service.execute({ action: "refresh", handle: view.handle, expectedEpisode: view.episode }, f.ctx)).status, "succeeded");
	const repair = await f.service.execute({ action: "continue", mode: "foreground", episodes: [{ handle: view.handle, requestId: "repair", expectedEpisode: view.episode, message: "repair" }] }, f.ctx);
	assert.equal(repair.status, "succeeded", JSON.stringify(repair)); assert.equal(repair.sessions[0]!.episode, 2); assert.equal(paths[0], paths[1]);
	slow.release();
	const joined = await f.service.execute({ action: "join", runId: receipt.runId }, f.ctx);
	assert.equal(joined.status, "succeeded", JSON.stringify(joined)); assert.equal(joined.sessions[0]!.episode, 1, "a late sibling does not rebind the original run to the repair episode"); assert.ok(f.wakes.length);
});

test("shared capacity fixes queued input before receipt and cancellation of a queued task does not wait for a sibling", async t => {
	const hold = gate(); const active = gate(); let launched = 0;
	t.after(() => hold.release());
	const f = await fixture(t, async options => { launched++; active.release(); if (options.task.id === "one") await hold.promise; else assert.equal(await readFile(join(options.cwd, "base.txt"), "utf8"), "dirty parent\n"); }, 1);
	const first = await f.service.execute({ action: "create", requestId: "one", tasks: [task("one")] }, f.ctx); await active.promise;
	const second = await f.service.execute({ action: "create", requestId: "two", tasks: [task("two")] }, f.ctx);
	assert.equal(second.status, "accepted", JSON.stringify(second));
	assert.equal((await f.service.execute({ action: "cancel", runId: second.runId, taskId: "two" }, f.ctx)).cancelOutcome, "accepted");
	const joined = await f.service.execute({ action: "join", runId: second.runId }, f.ctx);
	assert.equal(joined.sessions[0]!.result?.status, "aborted"); assert.equal(launched, 1);
	hold.release(); await f.service.execute({ action: "join", runId: first.runId }, f.ctx);
	await writeFile(join(f.repo, "base.txt"), "changed after cancelled admission\n");
	const resumed = await f.service.execute({ action: "continue", mode: "foreground", episodes: [{ handle: joined.sessions[0]!.handle, expectedEpisode: 1, requestId: "resume", message: "continue pinned input" }] }, f.ctx);
	assert.equal(resumed.status, "succeeded", JSON.stringify(resumed)); assert.equal(launched, 2);
});

test("continuation reserves the freshly locked record after a concurrent explicit refresh", async t => {
	const f = await fixture(t, async options => { if (options.prompt === "repair") assert.equal(await readFile(join(options.cwd, "base.txt"), "utf8"), "refreshed\n"); });
	const created = await f.service.execute({ action: "create", mode: "foreground", requestId: "one", tasks: [task("one")] }, f.ctx);
	const view = created.sessions[0]!; const entered = gate(), proceed = gate(); t.after(() => proceed.release());
	const lock = f.store.withSession.bind(f.store); let pause = true;
	f.store.withSession = async (handle, owner, action) => { if (pause) { pause = false; entered.release(); await proceed.promise; } return lock(handle, owner, action); };
	const continuation = f.service.execute({ action: "continue", mode: "foreground", episodes: [{ handle: view.handle, expectedEpisode: 1, requestId: "repair", message: "repair" }] }, f.ctx);
	await entered.promise; await writeFile(join(f.repo, "base.txt"), "refreshed\n");
	const refreshed = await f.service.execute({ action: "refresh", handle: view.handle, expectedEpisode: 1 }, f.ctx); assert.equal(refreshed.status, "succeeded", JSON.stringify(refreshed));
	proceed.release(); const result = await continuation; assert.equal(result.status, "succeeded", JSON.stringify(result));
});

test("continuation rechecks recovery state after a concurrent uncertain apply and never republishes an older episode", async t => {
	let launches = 0;
	const f = await fixture(t, async options => { launches++; await writeFile(join(options.cwd, "new.txt"), "candidate\n"); });
	const created = await f.service.execute({ action: "create", mode: "foreground", requestId: "one", tasks: [task("one")] }, f.ctx);
	const view = created.sessions[0]!; const eventCount = f.events.length;
	const entered = gate(), proceed = gate(); t.after(() => proceed.release()); const lock = f.store.withSession.bind(f.store); let pause = true;
	f.store.withSession = async (handle, owner, action) => { if (pause) { pause = false; entered.release(); await proceed.promise; } return lock(handle, owner, action); };
	const continuation = f.service.execute({ action: "continue", mode: "foreground", episodes: [{ handle: view.handle, expectedEpisode: 1, requestId: "repair", message: "repair" }] }, f.ctx);
	await entered.promise; const save = f.store.save.bind(f.store); let fail = true;
	f.store.save = async record => { if (fail && record.candidate?.status === "applied") { fail = false; throw new Error("synthetic persistence failure"); } return save(record); };
	const applied = await f.service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: view.candidate!.id }, f.ctx); assert.equal(applied.status, "failed");
	proceed.release(); const result = await continuation; assert.equal(result.error?.code, "candidate_recovery_required"); assert.equal(launches, 1); assert.equal(f.events.length, eventCount);
	const inspected = await f.service.execute({ action: "inspect", handle: view.handle }, f.ctx); assert.equal(inspected.sessions[0]?.candidate?.status, "unknown");
});

test("same-process batch completions await the root writer instead of treating it as unknown", async t => {
	const f = await fixture(t, async () => {});
	const owner = { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] };
	const graph = validateGraphStructure({ tasks: [task("one")] }); if (!graph.ok) throw new Error("fixture");
	const make = async (id: string): Promise<SessionActionResult> => ({ schemaVersion: 3, action: "create", status: "succeeded", sessions: (await f.store.allocate(owner, id, graph.tasks)).records.map(record => f.store.view(record)) });
	const a = await make("a"), b = await make("b");
	const entered = gate(), proceed = gate(); t.after(() => proceed.release()); const write = f.store.write.bind(f.store); let pause = true, secondDone = false;
	f.store.write = async (file, value) => { if (pause && file.startsWith(join(f.store.root, "request_"))) { pause = false; entered.release(); await proceed.promise; } return write(file, value); };
	const first = f.store.completeBatch(owner, "a", a); await entered.promise;
	const second = f.store.completeBatch(owner, "b", b).then(() => { secondDone = true; });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(secondDone, false); proceed.release(); await Promise.all([first, second]); assert.equal(secondDone, true);
});
