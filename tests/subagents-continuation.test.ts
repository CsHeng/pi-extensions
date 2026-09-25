import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergeOwnedUsage } from "../extensions/subagents/observability.ts";
import type { ObservedRun } from "../extensions/subagents/observation-hooks.ts";
import { ContinuationService } from "../extensions/subagents/continuation.ts";
import { formatManagedContent } from "../extensions/subagents/render.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runChild } from "../extensions/subagents/runner.ts";
import { getRole } from "../extensions/subagents/roles.ts";
import { prepareChildGuidance } from "../extensions/subagents/guidance-resources.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { emptyUsage, emptyTaskTelemetry, type EffectiveRoute } from "../extensions/subagents/contracts.ts";

import { ManagedError, MANAGED_LIMITS, MANAGED_STORAGE_WARNINGS, type SessionActionResult } from "../extensions/subagents/session-contracts.ts";

function assertReplay(actual: SessionActionResult, expected: SessionActionResult) {
	// Advice describes current storage, not the replayed execution.
	const { requestTelemetry: current, warnings: currentWarnings, ...core } = actual;
	const { requestTelemetry: previous, warnings: previousWarnings, ...prior } = expected;
	assert.deepEqual(core, prior);
	assert.equal(current?.launchedChildren, 0);
	assert.notEqual(current?.invocationId, previous?.invocationId);
	assert.equal(current?.configurationEpoch, null, "replay does not resolve current routes");
}

const route: EffectiveRoute = { provider: "subagent-fixture", model: "fixture", thinking: "off", source: "parent", candidateIndex: 0, executionProfileApplied: false, reasoningProfileApplied: false, profileFallbacks: [] };

test("real native worker reopens one history and edits the same state with host bash", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "managed-native-worker-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "source"); const scratch = join(base, "scratch");
	await mkdir(cwd); await mkdir(scratch);
	const path = join(base, "native.jsonl"); await writeFile(path, "", { mode: 0o600 });
	const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", scope: ["."], writePaths: ["candidate.txt"] }] });
	if (!graph.ok) throw new Error("fixture");
	for (const count of [1, 2, 3]) {
		const result = await runChild({
			task: graph.tasks[0]!, role: { ...getRole("worker"), tools: [...getRole("worker").tools, "bash"] }, route, cwd,
			guardExtensionPath: new URL("../extensions/subagents/worker-tools.ts", import.meta.url).pathname,
			managedWorkerScratch: scratch,
			capability: { version: 2, root: cwd, role: "worker", readRoots: [cwd], writePaths: [join(cwd, "candidate.txt")], externalReadRoots: [] },
			prompt: `host-worker-fixture${count === 3 ? " done-only-thinking-fixture" : ""}`, approveProject: false,
			diagnosticSession: { path, ref: "managed/native", async removeUnused() {} },
			invocation: { command: process.execPath, args: [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
			env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: join(base, "agent"), PI_OFFLINE: "1" },
		});
		assert.equal(result.status, "succeeded", `${result.error?.code}: ${result.stderr}`);
		assert.equal(result.reportComplete, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(result.observation?.available, true);
		assert.equal(result.observation?.entries.length, 2, "native usage is this episode, not all retained history");
		assert.equal(result.observation?.usage.input, result.usage.input);
		assert.equal(result.observation?.commandCoverage, "partial", "standalone fixture has no source/environment endpoint evidence");
		assert.equal(result.observation?.commands[0]?.status, "succeeded");
		assert.equal(result.observation?.commands[0]?.sourceBeforeKey, null, "missing runtime input state is unavailable");
		assert.equal(result.observation?.timing?.complete, count !== 3, "done-only thinking has no measured endpoints");
		assert.ok(result.observation!.timing!.spans.localTool.length > 0);
		assert.equal(await readFile(join(cwd, "candidate.txt"), "utf8"), `candidate-${count}`);
	}
	const entries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(entries.filter((entry) => entry.message?.role === "user").length, 3);
});

async function serviceFixture(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "managed-service-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const repo = join(base, "repo"); await mkdir(repo);
	await promisify(execFile)("git", ["init", "-q", repo]);
	const store = new ManagedSessionStore(base);
	const model = { provider: "subagent-fixture", id: "fixture", reasoning: false };
	const ctx = { cwd: repo, isProjectTrusted: () => true, model, thinkingLevel: "off", scopedModels: [], modelRegistry: { getAll: () => [model], getAvailable: () => [model] }, sessionManager: { getSessionId: () => "parent", getLeafId: () => "anchor", getBranch: () => [{ id: "anchor" }] } } as unknown as ExtensionContext;
	let launches = 0;
	const runs: ObservedRun[] = [];
	let cancellation: { controller: AbortController; tool: string; pidFile: string } | undefined;
	const dependencies = { store, onRun: (run: ObservedRun) => { runs.push(run); }, loadConfig: async () => ({ config: defaultConfig() }), runChild: async (options: Parameters<typeof runChild>[0]) => {
		launches++;
		return runChild({ ...options,
			onActivity(activity) {
				if (cancellation && activity.activeTools.includes(cancellation.tool)) {
					const current = cancellation; cancellation = undefined;
					void (async () => {
						try {
							for (let attempt = 0; attempt < 200; attempt++) {
								try { await readFile(join(options.managedWorkerScratch!, current.pidFile)); return; }
								catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
								await new Promise((resolve) => setTimeout(resolve, 10));
							}
						} finally { current.controller.abort(); }
					})();
				}
			},
			invocation: options.invocation ?? { command: process.execPath, args: [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] },
			env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: join(base, "agent"), PI_OFFLINE: "1", ...options.env },
		});
	} };
	return { base, repo, store, ctx, dependencies, runs, service: new ContinuationService(dependencies), launches: () => launches,
		cancelOnBash: (controller: AbortController) => { cancellation = { controller, tool: "bash", pidFile: "descendant.pid" }; },
		cancelOnSearch: (controller: AbortController) => { cancellation = { controller, tool: "find", pidFile: "search.pid" }; },
	};
}

test("explicit close releases a slot and retained-history warnings do not block new work", async (t) => {
	const f = await serviceFixture(t);
	const owner = { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] };
	const graph = validateGraphStructure({ tasks: Array.from({ length: MANAGED_LIMITS.maxSessions }, (_, index) => ({ id: `scan-${index}`, role: "explorer", objective: "scan", scope: ["."] })) });
	if (!graph.ok) throw new Error("fixture");
	const records = (await f.store.allocate(owner, "slots", graph.tasks)).records;
	await assert.rejects(f.store.allocate(owner, "overflow", [graph.tasks[0]!]), /session_limit/);
	const close = { action: "close", handle: records[0]!.handle, expectedEpisode: 0, disposition: "retain" };
	assert.equal((await f.service.execute(close, f.ctx)).status, "succeeded");
	assert.equal((await f.store.allocate(owner, "new-slot", [graph.tasks[0]!])).fresh, true);
	assert.equal((await f.service.execute({ ...close, disposition: "discard" }, f.ctx)).error?.code, "close_disposition_conflict");
	Object.defineProperty(f.store, "storageWarning", { get() { throw new Error("global scan forbidden"); } });
	const native = join(f.store.path(records[1]!.handle), "native.jsonl");
	await writeFile(native, "retained-required-evidence");
	assert.equal((await f.service.execute({ ...close, handle: records[1]!.handle, disposition: "discard" }, f.ctx)).status, "succeeded");
	assert.equal(await readFile(native, "utf8"), "retained-required-evidence");
	const admitted = await f.service.execute({ action: "create", requestId: "history-full", tasks: [{ id: "new", role: "explorer", objective: "scan", scope: ["."] }] }, f.ctx);
	assert.equal(admitted.status, "succeeded");
	assert.equal(admitted.warnings, undefined);
	assert.equal(admitted.requestTelemetry?.launchedChildren, 1);
	assert.equal(f.launches(), 1);
});

const createWorker = { action: "create", requestId: "create-worker", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", scope: ["."], writePaths: ["candidate.txt"] }] };

test("normal and replay actions avoid global inventory while close still releases owned work", async (t) => {
	const f = await serviceFixture(t);
	Object.defineProperty(f.store, "storageWarning", { get() { throw new Error("global scan forbidden"); } });
	const first = await f.service.execute(createWorker, f.ctx);
	assert.equal(first.status, "succeeded"); assert.equal(first.warnings, undefined);
	const handle = first.sessions[0]!.handle;
	const replay = await new ContinuationService(f.dependencies).execute(createWorker, f.ctx);
	assertReplay(replay, first); assert.equal(f.launches(), 1);
	const continued = await f.service.execute({ action: "continue", episodes: [{ handle, requestId: "next", expectedEpisode: 1, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(continued.status, "succeeded"); assert.equal(continued.warnings, undefined);
	const applied = await f.service.execute({ action: "apply", handle, expectedEpisode: 2, candidateId: continued.sessions[0]!.candidate!.id }, f.ctx);
	assert.equal(applied.status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-2");
	const closed = await f.service.execute({ action: "close", handle, expectedEpisode: 2, disposition: "discard" }, f.ctx);
	assert.equal(closed.status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-2");
	assert.equal((await f.service.execute({ action: "inspect", handle }, f.ctx)).status, "succeeded");
});

function errnoError(code: string, message: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

test("an untyped failure keeps its managed code and a bounded, path-free cause", async (t) => {
	const f = await serviceFixture(t);
	const failing = new ContinuationService({ ...f.dependencies, runChild: async () => { throw errnoError("ENOENT", "ENOENT: no such file or directory, lstat '/tmp/secret/native.jsonl'"); } });
	const episode = await failing.execute(createWorker, f.ctx);
	assert.equal(episode.status, "failed");
	assert.equal(episode.sessions[0]!.requestError?.code, "managed_operation_failed");
	assert.equal(episode.sessions[0]!.requestError?.detail, "ENOENT");
	assert.equal(episode.sessions[0]!.state, "interrupted", "an untyped child failure still commits the interrupted episode");
	const request = await new ContinuationService({ ...f.dependencies, loadConfig: async () => { throw errnoError("EACCES", "EACCES: permission denied, open '/tmp/secret/routes.json'"); } }).execute({ ...createWorker, requestId: "create-worker-config" }, f.ctx);
	assert.equal(request.status, "failed");
	assert.equal(request.error?.code, "managed_operation_failed");
	assert.equal(request.error?.detail, "EACCES");
	for (const response of [episode, request]) {
		assert.doesNotMatch(JSON.stringify(response), /\/tmp\/secret|lstat|permission denied/);
	}
});

test("managed service keeps fixed inputs, replays inertly, restores history and explicitly refreshes before repair/review", async (t) => {
	const f = await serviceFixture(t);
	const first = await f.service.execute(createWorker, f.ctx);
	assert.equal(first.status, "succeeded", JSON.stringify(first));
	const handle = first.sessions[0]!.handle;
	assert.ok(first.sessions[0]!.candidate);
	const stale = await f.service.execute({ action: "continue", episodes: [{ handle, requestId: "stale", expectedEpisode: 0, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(stale.status, "failed");
	assert.equal(stale.sessions[0]!.requestError?.code, "stale_episode");
	assert.equal(f.launches(), 1);
	const next = { action: "continue", episodes: [{ handle, requestId: "repair", expectedEpisode: 1, message: "host-worker-fixture" }] };
	const second = await f.service.execute(next, f.ctx);
	assert.equal(second.status, "succeeded", JSON.stringify(second));
	await assert.rejects(readFile(join(f.repo, "candidate.txt")), { code: "ENOENT" });
	const before = await readFile(join(f.store.path(handle), "native.jsonl"), "utf8");
	assertReplay(await f.service.execute(next, f.ctx), second);
	const beforeReplay = f.runs.length;
	assertReplay(await f.service.execute(createWorker, f.ctx), first);
	assert.equal(f.runs.length, beforeReplay, "cached create is not a new execution wave");
	assert.equal(f.runs[0]!.telemetry.timing?.children[0]?.taskId, first.sessions[0]!.result!.observation!.ownerSessionId);
	assertReplay(await f.service.execute({ ...createWorker, tasks: createWorker.tasks.map((task) => ({ scope: task.scope, objective: task.objective, writePaths: task.writePaths, inputs: [], role: task.role, id: task.id })) }, f.ctx), first);
	assert.equal(await readFile(join(f.store.path(handle), "native.jsonl"), "utf8"), before);
	assert.equal(f.launches(), 2);
	const apply = { action: "apply", handle, expectedEpisode: 2, candidateId: second.sessions[0]!.candidate!.id };
	assert.equal((await f.service.execute(apply, f.ctx)).status, "succeeded");
	assert.equal((await f.service.execute(apply, f.ctx)).status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-2");
	const reviewer = await f.service.execute({ action: "create", requestId: "review", tasks: [{ id: "reviewer", role: "reviewer", objective: "host-reviewer-fixture", scope: ["."] }] }, f.ctx);
	assert.equal(reviewer.status, "succeeded", JSON.stringify(reviewer));
	assert.match(reviewer.sessions[0]!.result!.output, /candidate-2/);
	const restored = new ContinuationService(f.dependencies);
	assert.equal((await restored.execute({ action: "refresh", handle, expectedEpisode: 2 }, f.ctx)).status, "succeeded");
	const third = await restored.execute({ action: "continue", episodes: [{ handle, requestId: "again", expectedEpisode: 2, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(third.status, "succeeded", JSON.stringify(third));
	assert.match(third.sessions[0]!.result!.output, /users=3/);
	assert.equal((await restored.execute({ action: "apply", handle, expectedEpisode: 3, candidateId: third.sessions[0]!.candidate!.id }, f.ctx)).status, "succeeded");
	assert.equal((await restored.execute({ action: "refresh", handle: reviewer.sessions[0]!.handle, expectedEpisode: 1 }, f.ctx)).status, "succeeded");
	const reviewAgain = await restored.execute({ action: "continue", episodes: [{ handle: reviewer.sessions[0]!.handle, requestId: "rereview", expectedEpisode: 1, message: "host-reviewer-fixture" }] }, f.ctx);
	assert.equal(reviewAgain.status, "succeeded", JSON.stringify(reviewAgain));
	assert.match(reviewAgain.sessions[0]!.result!.output, /users=2.*candidate-3/);
	const close = { action: "close", handle, expectedEpisode: 3, disposition: "discard" };
	assert.equal((await restored.execute(close, f.ctx)).status, "succeeded");
	assert.equal((await restored.execute(close, f.ctx)).status, "succeeded");
	await assert.rejects(readFile(join(f.store.path(handle), "source", "candidate.txt")), { code: "ENOENT" });
	const calls = f.launches();
	assertReplay(await restored.execute(next, f.ctx), second);
	assert.equal((await restored.execute({ action: "continue", episodes: [{ handle, requestId: "after-close", expectedEpisode: 3, message: "host-worker-fixture" }] }, f.ctx)).status, "failed");
	assert.equal(f.launches(), calls);
});

test("native worker commands reuse private dependencies and Git despite inherited parent Git overrides", async (t) => {
	const f = await serviceFixture(t);
	await writeFile(join(f.repo, ".gitignore"), "node_modules/\n");
	await mkdir(join(f.repo, "node_modules/pkg"), { recursive: true });
	await writeFile(join(f.repo, "node_modules/pkg/index.js"), 'module.exports = "dependency-1"');
	const config = await readFile(join(f.repo, ".git/config"));
	const service = new ContinuationService({ ...f.dependencies, runChild: (options) => f.dependencies.runChild({ ...options, env: { GIT_DIR: join(f.repo, ".git"), GIT_WORK_TREE: f.repo } }) });
	const initial = await service.execute({ ...createWorker, tasks: createWorker.tasks.map((task) => ({ ...task, objective: `${task.objective} host-inputs-fixture` })) }, f.ctx);
	assert.equal(initial.status, "succeeded"); const first = initial.sessions[0]!;
	assert.ok(first.candidate);
	const observation = first.result!.observation!;
	assert.equal(observation.available, true);
	assert.equal(observation.commandCoverage, "complete");
	assert.deepEqual(new Set(observation.toolNames), new Set(["read", "grep", "find", "ls", "edit", "write", "bash"]));
	assert.match(observation.capabilityKey!, /^[a-f0-9]{64}$/);
	for (const command of observation.commands) {
		for (const key of [command.sourceBeforeKey, command.sourceAfterKey, command.environmentBeforeKey, command.environmentAfterKey]) assert.match(key!, /^[a-f0-9]{64}$/);
	}
	const source = join(f.store.path(first.handle), "source");
	assert.equal((await promisify(execFile)("git", ["-C", source, "show", ":candidate.txt"])).stdout, "dependency-1");
	const firstEntries = (await readFile(join(f.store.path(first.handle), "native.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const bash = firstEntries.filter((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "bash");
	assert.equal(bash.length, 1); assert.equal(bash[0].message.isError, false);
	assert.equal(await readFile(join(f.store.path(first.handle), "source/candidate.txt"), "utf8"), "dependency-1");
	await writeFile(join(f.repo, "node_modules/pkg/index.js"), 'module.exports = "dependency-2"');
	assert.equal((await service.execute({ action: "refresh", handle: first.handle, expectedEpisode: 1 }, f.ctx)).status, "succeeded");
	const next = await service.execute({ action: "continue", episodes: [{ handle: first.handle, requestId: "next", expectedEpisode: 1, message: "host-worker-fixture host-inputs-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded"); assert.ok(next.sessions[0]!.candidate);
	assert.equal(await readFile(join(f.store.path(first.handle), "source/candidate.txt"), "utf8"), "dependency-2");
	await assert.rejects(readFile(join(f.repo, "candidate.txt")), { code: "ENOENT" });
	await assert.rejects(readFile(join(f.repo, ".git/index")), { code: "ENOENT" });
	assert.deepEqual(await readFile(join(f.repo, ".git/config")), config);
});

test("managed cancellation drains an actual bash process group before returning", async (t) => {
	const f = await serviceFixture(t);
	const controller = new AbortController(); f.cancelOnBash(controller);
	const result = await f.service.execute({ ...createWorker, tasks: [{ ...createWorker.tasks[0], objective: "host-worker-fixture cancel-fixture" }] }, f.ctx, controller.signal);
	assert.equal(result.status, "aborted", JSON.stringify(result));
	const handle = result.sessions[0]!.handle;
	assert.equal(result.sessions[0]!.result?.workerToolsSettled, true, JSON.stringify(result));
	const pid = Number(await readFile(join(f.store.path(handle), "scratch", "descendant.pid"), "utf8"));
	await assertProcessStopped(pid);
	await assert.rejects(readFile(join(f.store.path(handle), "source", "orphan.txt")), { code: "ENOENT" });
});

async function assertProcessStopped(pid: number): Promise<void> {
	assert.ok(Number.isInteger(pid) && pid > 1);
	if (process.platform === "linux") {
		try { assert.match(await readFile(`/proc/${pid}/stat`, "utf8"), /\) [ZX] /); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	} else assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("forced managed stop terminates an ordinary native search subprocess beyond the drain grace", async (t) => {
	const f = await serviceFixture(t);
	const bin = join(f.base, "agent", "bin"); await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "fd"), `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR, 'search.pid'), String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
	const service = new ContinuationService({ ...f.dependencies, runChild: (options) => f.dependencies.runChild({ ...options, killGraceMs: 100 }) });
	const controller = new AbortController(); f.cancelOnSearch(controller);
	const result = await service.execute({ ...createWorker, tasks: [{ ...createWorker.tasks[0], objective: "host-worker-fixture host-search-fixture" }] }, f.ctx, controller.signal);
	assert.equal(result.status, "aborted", JSON.stringify(result));
	const pid = Number(await readFile(join(f.store.path(result.sessions[0]!.handle), "scratch", "search.pid"), "utf8"));
	await assertProcessStopped(pid);
});

test("completed create and continue replay without execution configuration; new episodes still require routes", async (t) => {
	const f = await serviceFixture(t);
	const first = await f.service.execute(createWorker, f.ctx);
	const request = { action: "continue", episodes: [{ handle: first.sessions[0]!.handle, requestId: "repair", expectedEpisode: 1, message: "host-worker-fixture" }] };
	const second = await f.service.execute(request, f.ctx);
	assert.equal(second.status, "succeeded");
	const unavailable = new ContinuationService({ ...f.dependencies, loadConfig: async () => ({ diagnostic: { code: "invalid_route_config", message: "fixture" } }) });
	assertReplay(await unavailable.execute(createWorker, f.ctx), first);
	assertReplay(await unavailable.execute(request, f.ctx), second);
	const fresh = await unavailable.execute({ action: "continue", episodes: [{ ...request.episodes[0], requestId: "new", expectedEpisode: 2 }] }, f.ctx);
	assert.equal(fresh.error?.code, "invalid_route_config");
	assert.equal(f.launches(), 2);
});

test("create replay preserves partial and dependency-blocked terminal responses including non-launches", async (t) => {
	const f = await serviceFixture(t);
	let calls = 0;
	const service = new ContinuationService({ ...f.dependencies, runChild: async (options) => {
		calls++;
		if (options.task.id === "fail") return { id: "fail", role: "explorer", status: "failed", output: "", stderr: "", usage: emptyUsage(), durationMs: 0, changedPaths: [], convergence: "not-applicable", telemetry: emptyTaskTelemetry(), error: { code: "fixture_failure", message: "fixture" } };
		return f.dependencies.runChild(options);
	} });
	for (const dependent of [false, true]) {
		const request = { action: "create", requestId: dependent ? "blocked" : "partial", tasks: [
			{ id: "fail", role: "explorer", objective: "inspect", scope: ["."] },
			{ id: "other", role: "explorer", objective: "inspect", scope: ["."], ...(dependent ? { dependsOn: ["fail"] } : {}) },
		] };
		const response = await service.execute(request, f.ctx);
		assert.equal(response.status, dependent ? "failed" : "partial", JSON.stringify(response));
		if (dependent) assert.equal(response.sessions[1]!.requestError?.code, "dependency_failed");
		const before = calls;
		assertReplay(await service.execute(request, f.ctx), response);
		assert.equal(calls, before);
	}
});

test("known spawn non-start is not presented as a completed zero-duration execution", async (t) => {
 const f = await serviceFixture(t);
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => ({ id: options.task.id, role: "explorer", status: "failed", output: "", stderr: "", usage: emptyUsage(), durationMs: 0, changedPaths: [], convergence: "not-applicable", telemetry: { ...emptyTaskTelemetry(), childStarted: false }, error: { code: "spawn_failure", message: "not started" } }) });
 const response = await service.execute({ action: "create", requestId: "no-start", tasks: [{ id: "scan", role: "explorer", objective: "inspect", scope: ["."] }] }, f.ctx);
 assert.equal(response.sessions[0]?.result?.executionStatus, "not-started");
 assert.equal(JSON.parse(formatManagedContent(response)).sessions[0].result.durationMs, null);
});

test("non-start remains non-start through a result-save failure", async (t) => {
 const f = await serviceFixture(t); let returned = false;
 const save = f.store.save.bind(f.store);
 f.store.save = async record => { if (returned && record.result) throw new Error("disk failure"); return save(record); };
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => {
  returned = true; return { id: options.task.id, role: "explorer", status: "failed", output: "", stderr: "", usage: emptyUsage(), durationMs: 0,
   changedPaths: [], convergence: "not-applicable", telemetry: { ...emptyTaskTelemetry(), childStarted: false }, error: { code: "spawn_failure", message: "not started" } };
 } });
 const result = await service.execute({ action: "create", requestId: "no-start-save", tasks: [{ id: "scan", role: "explorer", objective: "inspect", scope: ["."] }] }, f.ctx);
 assert.equal(result.sessions[0]?.result?.executionStatus, "not-started");
 assert.equal(result.sessions[0]?.result?.finalization?.stage, "result-save");
 assert.equal(JSON.parse(formatManagedContent(result)).sessions[0].result.durationMs, null);
});

test("post-child native validation failure retains execution evidence and cannot replay or apply", async (t) => {
 const f = await serviceFixture(t);
 const nativeRevision = f.store.nativeRevision.bind(f.store);
 let childDone = false;
 f.store.nativeRevision = async (handle) => { const revision = await nativeRevision(handle); if (childDone) throw new Error("native fixture invalid"); return revision; };
 let calls = 0;
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); childDone = true; return { ...result, output: "executed before validation", usage: { ...result.usage, input: 41 }, durationMs: 19, status: "succeeded" }; } });
 const request = { action: "create", requestId: "native-fault", tasks: [{ id: "scan", role: "explorer", objective: "inspect", scope: ["."] }] };
 const failed = await service.execute(request, f.ctx);
 assert.equal(failed.status, "failed");
 const view = failed.sessions[0]!;
 assert.equal(view.result?.output, "executed before validation");
 assert.equal(view.result?.usage.input, 41); assert.equal(view.result?.durationMs, 19);
 assert.equal(view.result?.executionStatus, "succeeded");
 assert.deepEqual(view.result?.finalization, { status: "failed", stage: "native-validation", code: "managed_operation_failed", reason: "unclassified" });
 assert.equal(view.candidate, undefined);
 const replay = await service.execute(request, f.ctx); assert.equal(replay.status, "failed"); assert.equal(calls, 1);
 assert.notEqual((await service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: "missing" }, f.ctx)).status, "succeeded");
});

test("candidate freeze failure preserves child facts and never exposes an applicable candidate", async (t) => {
 const f = await serviceFixture(t); let calls = 0;
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => {
  calls++; const result = await child(options);
  await rm(join(options.cwd, ".git"), { recursive: true, force: true });
  return { ...result, status: "succeeded", reportComplete: true, workerToolsSettled: true, output: "worker executed", usage: { ...result.usage, input: 37 }, durationMs: 29 };
 } });
 const failed = await service.execute(createWorker, f.ctx);
 assert.equal(failed.status, "failed");
 const view = failed.sessions[0]!;
 assert.equal(view.result?.output, "worker executed"); assert.equal(view.result?.usage.input, 37);
 assert.equal(view.result?.executionStatus, "succeeded"); assert.equal(view.result?.finalization?.stage, "candidate-freeze");
 assert.equal(view.candidate, undefined);
 assert.equal((await service.execute(createWorker, f.ctx)).status, "failed"); assert.equal(calls, 1);
});

test("repeated post-freeze save failures cannot expose a worker candidate", async (t) => {
 const f = await serviceFixture(t); let childDone = false; let calls = 0; let candidateId: string | undefined;
 const save = f.store.save.bind(f.store);
 f.store.save = async record => { if (childDone) { candidateId ??= record.candidate?.id; throw new Error("persistent disk failure"); } return save(record); };
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); childDone = true; return result; } });
 const response = await service.execute(createWorker, f.ctx);
 assert.equal(response.status, "failed"); assert.equal(response.error?.code, "result_persistence_failed");
 const view = response.sessions[0]!;
 assert.ok(candidateId); assert.equal(view.candidate, undefined);
 assert.equal(view.result?.executionStatus, "succeeded"); assert.equal(view.result?.finalization?.stage, "result-save");
 const apply = await service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId }, f.ctx);
 assert.notEqual(apply.status, "succeeded"); assert.equal(calls, 1);
 assert.notEqual((await service.execute(createWorker, f.ctx)).status, "succeeded"); assert.equal(calls, 1);
});

test("post-rename save error leaves a durable fence against the actual worker candidate", async (t) => {
 const f = await serviceFixture(t); let childDone = false; let candidateId: string | undefined; let calls = 0;
 const save = f.store.save.bind(f.store);
 f.store.save = async record => {
  if (!childDone) return save(record);
  if (record.candidate && record.result?.status === "succeeded") {
   candidateId = record.candidate.id; await save(record); throw new Error("fsync failed after rename");
  }
  throw new Error("recovery save failed");
 };
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); childDone = true; return result; } });
 const result = await service.execute(createWorker, f.ctx);
 assert.equal(result.status, "failed"); assert.equal(result.error?.code, "result_persistence_failed"); assert.ok(candidateId);
 assert.equal(result.sessions[0]?.result?.executionStatus, "succeeded"); assert.equal(result.sessions[0]?.candidate, undefined);
 f.store.save = save;
 const handle = result.sessions[0]!.handle;
 const inspected = await service.execute({ action: "inspect", handle }, f.ctx);
 assert.equal(inspected.sessions[0]?.candidate, undefined); assert.equal(inspected.sessions[0]?.result?.status, "failed");
 const apply = await service.execute({ action: "apply", handle, expectedEpisode: 1, candidateId }, f.ctx);
 assert.notEqual(apply.status, "succeeded");
 assert.notEqual((await service.execute(createWorker, f.ctx)).status, "succeeded"); assert.equal(calls, 1);
 assert.equal((await service.execute({ action: "close", handle, expectedEpisode: 1, disposition: "retain" }, f.ctx)).status, "succeeded");
 assert.equal((await service.execute({ action: "inspect", handle }, f.ctx)).sessions[0]?.state, "closed");
 assert.equal((await service.execute({ action: "close", handle, expectedEpisode: 1, disposition: "discard" }, f.ctx)).error?.code, "close_disposition_conflict");
 assert.equal((await f.store.list({ repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] })).some(view => view.handle === handle), false);
});

test("required result-save failure retains child facts and replays failed without a second child", async (t) => {
 const f = await serviceFixture(t);
 const save = f.store.save.bind(f.store); let injected = false; let calls = 0;
 f.store.save = async record => { if (!injected && record.result?.status === "succeeded") { injected = true; throw new Error("write failed"); } return save(record); };
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); return { ...result, status: "succeeded", output: "retained child", usage: { ...result.usage, input: 23 }, durationMs: 17 }; } });
 const request = { action: "create", requestId: "save-fault", tasks: [{ id: "scan", role: "explorer", objective: "inspect", scope: ["."] }] };
 const first = await service.execute(request, f.ctx);
 assert.equal(first.status, "failed"); assert.equal(first.sessions[0]?.result?.output, "retained child");
 assert.equal(first.sessions[0]?.result?.usage.input, 23); assert.equal(first.sessions[0]?.result?.durationMs, 17);
 assert.equal(first.sessions[0]?.result?.finalization?.stage, "result-save");
 assert.equal((await service.execute(request, f.ctx)).status, "failed"); assert.equal(calls, 1);
});

test("repeated required save failures keep volatile child evidence but fence replay and apply", async (t) => {
 const f = await serviceFixture(t); let childDone = false; let calls = 0;
 const save = f.store.save.bind(f.store);
 f.store.save = async record => { if (childDone) throw new Error("persistent disk failure"); return save(record); };
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); childDone = true; return { ...result, status: "succeeded", output: "retained despite storage", usage: { ...result.usage, input: 83 }, durationMs: 21 }; } });
 const request = { action: "create", requestId: "persistent-fault", tasks: [{ id: "scan", role: "explorer", objective: "inspect", scope: ["."] }] };
 const first = await service.execute(request, f.ctx);
 assert.equal(first.status, "failed"); assert.equal(first.error?.code, "result_persistence_failed");
 assert.equal(first.sessions[0]?.result?.output, "retained despite storage"); assert.equal(first.sessions[0]?.result?.usage.input, 83);
 assert.equal(first.sessions[0]?.result?.finalization?.stage, "result-save");
 assert.notEqual((await service.execute(request, f.ctx)).status, "succeeded"); assert.equal(calls, 1);
 assert.notEqual((await service.execute({ action: "apply", handle: first.sessions[0]!.handle, expectedEpisode: 1, candidateId: "missing" }, f.ctx)).status, "succeeded");
});

test("optional observation persistence failure leaves the required candidate and replay intact", async (t) => {
	const f = await serviceFixture(t);
	const write = f.store.write.bind(f.store);
	f.store.write = async (file, value) => {
		if (/observation_\d+\.json$/.test(file)) throw new Error("optional storage unavailable");
		return write(file, value);
	};
	const initial = await f.service.execute(createWorker, f.ctx);
	assert.equal(initial.status, "succeeded");
	const view = initial.sessions[0]!;
	assert.ok(view.candidate);
	assert.equal(view.result?.observation?.available, false);
	assert.equal(view.result?.observation?.usage.cost, null);
	assert.doesNotMatch(await readFile(join(f.store.path(view.handle), "registry.json"), "utf8"), /"observation":/);
	assertReplay(await new ContinuationService(f.dependencies).execute(createWorker, f.ctx), initial);
	assert.equal(f.launches(), 1);
	const applied = await f.service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: view.candidate!.id }, f.ctx);
	assert.equal(applied.status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-1");
});

for (const installed of [false, true]) test(`managed ${installed ? "installed" : "development"} worker retains its actual source and history after child compaction`, async (t) => {
	const f = await serviceFixture(t);
	await mkdir(join(f.base, "agent"), { recursive: true });
	await writeFile(join(f.base, "agent", "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 8 } }));
	let first = true;
	const service = new ContinuationService({ ...f.dependencies, runChild: (options) => {
		const current = first; first = false;
		return f.dependencies.runChild({ ...options, ...(installed ? { invocation: { command: "pi", args: ["-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] } } : {}), env: current ? { CSHENG_NATIVE_COMPACTION_MODE: "threshold" } : {} });
	} });
	const initial = await service.execute({ ...createWorker, tasks: createWorker.tasks.map((task) => ({ ...task, objective: `${task.objective} private-continuity-fixture` })) }, f.ctx);
	assert.equal(initial.status, "succeeded", JSON.stringify(initial));
	const handle = initial.sessions[0]!.handle;
	const native = join(f.store.path(handle), "native.jsonl");
	const compacted = (await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(compacted.filter((entry) => entry.type === "compaction").length, 1);
	const observed = initial.sessions[0]!.result!.observation!;
	assert.equal(observed.available, true);
	assert.equal(observed.entries.filter((row) => row.kind === "compaction").length, 1);
	assert.equal(observed.timing?.complete, true);
	assert.equal(observed.timing?.spans.compaction.length, 1);
	assert.equal(await readFile(join(f.store.path(handle), "source", "candidate.txt"), "utf8"), "candidate-1");
	const source = join(f.store.path(handle), "source");
	const rootIdentity = await lstat(source); const dependencyIdentity = await lstat(join(source, "node_modules/fixture-state"));
	const next = await service.execute({ action: "continue", episodes: [{ handle, requestId: "after-compaction", expectedEpisode: 1, message: "host-worker-fixture after-child-compaction-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded", JSON.stringify(next));
	assert.equal(await readFile(join(source, "candidate.txt"), "utf8"), "candidate-1|continued");
	const later = next.sessions[0]!.result!.observation!;
	assert.equal(later.available, true);
	assert.equal(later.entries.filter((row) => row.kind === "compaction").length, 0);
	assert.equal(later.ownerSessionId, observed.ownerSessionId);
	assert.notEqual(later.timing?.clockKey, observed.timing?.clockKey, "a new process is a new clock domain");
	assert.equal(mergeOwnedUsage([observed, later, observed]).entries.length, observed.entries.length + later.entries.length);
	assert.equal((await lstat(source)).ino, rootIdentity.ino);
	assert.equal((await lstat(join(source, "node_modules/fixture-state"))).ino, dependencyIdentity.ino);
	assert.equal((await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "user").length, 2);
});

test("cold running state, revoked trust and a changed native leaf never replay or append an input", async (t) => {
	const f = await serviceFixture(t);
	const initial = await f.service.execute(createWorker, f.ctx);
	const handle = initial.sessions[0]!.handle;
	const owner = { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] };
	const record = await f.store.load(handle, owner);
	const native = join(f.store.path(handle), "native.jsonl");
	const request = { action: "continue", episodes: [{ handle, requestId: "next", expectedEpisode: 1, message: "host-worker-fixture" }] };
	const restored = new ContinuationService(f.dependencies);
	record.state = "running"; await f.store.save(record);
	const before = await readFile(native, "utf8");
	const running = await restored.execute(request, f.ctx);
	assert.equal(running.sessions[0]!.requestError?.code, "session_not_idle");
	assert.equal(await readFile(native, "utf8"), before);
	assert.equal((await restored.execute(request, { ...f.ctx, isProjectTrusted: () => false })).error?.code, "project_trust_required");
	record.state = "idle"; await f.store.save(record);
	const changed = `${before}${JSON.stringify({ type: "custom", id: "extra", parentId: record.nativeLeaf, customType: "fixture", data: {} })}\n`;
	await writeFile(native, changed);
	const mismatched = await restored.execute({ ...request, episodes: request.episodes.map(episode => ({ ...episode, requestId: "changed-native" })) }, f.ctx);
	assert.equal(mismatched.sessions[0]!.requestError?.code, "native_leaf_mismatch");
	assert.equal(await readFile(native, "utf8"), changed);
	assert.equal(f.launches(), 1);
});

test("create cancellation with queued tasks has an exact inert terminal replay", async (t) => {
	const f = await serviceFixture(t);
	const service = new ContinuationService({ ...f.dependencies, loadConfig: async () => ({ config: { ...defaultConfig(), maxConcurrency: 1 } }) });
	const controller = new AbortController(); f.cancelOnBash(controller);
	const request = { ...createWorker, tasks: [{ ...createWorker.tasks[0], objective: "host-worker-fixture cancel-fixture" }, { id: "queued", role: "explorer", objective: "inspect", scope: ["."] }] };
	const response = await service.execute(request, f.ctx, controller.signal);
	assert.equal(response.status, "aborted", JSON.stringify(response));
	assert.equal(response.sessions[1]!.requestError?.code, "aborted");
	assert.equal(f.launches(), 1);
	const replay = await service.execute(request, f.ctx);
	assertReplay(replay, response);
	assert.equal(replay.requestTelemetry?.replayedEpisodes, 1, "queued task never had an episode");
	assert.equal(f.launches(), 1);
});

test("episode provenance and actual route survive config changes and fresh replay envelopes", async (t) => {
	const f = await serviceFixture(t);
	let epoch = "config-one", reads = 0, inheritSkills = true;
	const service = new ContinuationService({ ...f.dependencies,
		loadConfig: async () => { reads++; const config = defaultConfig(); config.roles.worker.inheritSkills = inheritSkills; return { config, source: { packageBytes: Buffer.from("fixture") } }; },
		provenance: {
			observeExtension: async () => ({ available: true, extensionEpoch: "extension", configurationEpoch: epoch }),
			observeConfiguration: async () => ({ available: true, extensionEpoch: "extension", configurationEpoch: epoch }),
		},
	});
	const first = await service.execute(createWorker, f.ctx);
	assert.equal(first.status, "succeeded");
	assert.equal(first.requestTelemetry?.configurationEpoch, "config-one");
	assert.equal(first.requestTelemetry?.launchedChildren, 1);
	assert.deepEqual(first.sessions[0]?.execution?.provenance, { available: true, extensionEpoch: "extension", configurationEpoch: "config-one" });
	assert.equal(first.sessions[0]?.execution?.inheritSkills, true);
	assert.ok(first.sessions[0]?.route?.model);
	epoch = "config-two"; inheritSkills = false;
	const replay = await service.execute(createWorker, f.ctx);
	assertReplay(replay, first);
	assert.equal(reads, 1);
	const handle = first.sessions[0]!.handle;
	const next = await service.execute({ action: "continue", episodes: [{ handle, requestId: "new-epoch", expectedEpisode: 1, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded");
	assert.equal(next.requestTelemetry?.configurationEpoch, "config-two");
	assert.deepEqual(next.sessions[0]?.execution?.provenance, { available: true, extensionEpoch: "extension", configurationEpoch: "config-two" });
	assert.equal(next.sessions[0]?.execution?.inheritSkills, false);
	const historical = await service.execute(createWorker, f.ctx);
	assertReplay(historical, first);
	assert.equal(reads, 2);
});

test("one origin independently owns sibling worker targets, inputs, apply, refresh and cleanup", async t => {
 const f = await serviceFixture(t); const targets = [join(f.base, "left"), join(f.base, "right")]; const roots: string[] = [];
 await writeFile(join(f.repo, "origin-only.txt"), "parent");
 for (const target of targets) { await mkdir(target); await promisify(execFile)("git", ["init", "-q", target]); await writeFile(join(target, "dirty.txt"), target); }
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { roots.push(options.sourceRoot!); return f.dependencies.runChild(options); } });
 const created = await service.execute({ action: "create", requestId: "siblings", tasks: targets.map((repository, i) => ({ id: `worker-${i}`, role: "worker", objective: "host-worker-fixture", repository, scope: ["."] })) }, f.ctx);
 assert.equal(created.status, "succeeded", JSON.stringify(created)); assert.deepEqual(new Set(roots), new Set(targets));
 const records = await Promise.all(created.sessions.map(view => f.store.load(view.handle, { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] })));
 assert.notEqual(records[0]!.input!.commit, records[1]!.input!.commit);
 for (const [i, view] of created.sessions.entries()) {
  const record = records[i]!; assert.equal(record.owner.repo, f.repo); assert.equal(record.repositoryTarget!.root, targets[i]); assert.equal(record.workspace!.inputs.gitWorkspace!.repo, targets[i]);
  assert.equal(await readFile(join(f.store.path(view.handle), "source", "dirty.txt"), "utf8"), targets[i]);
  await assert.rejects(readFile(join(f.store.path(view.handle), "source", "origin-only.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(targets[i]!, "candidate.txt")), { code: "ENOENT" });
  const wrongOwner = await service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: view.candidate!.id }, { ...f.ctx, cwd: targets[i]! });
  assert.equal(wrongOwner.status, "failed");
 }
 const first = created.sessions[0]!; const second = created.sessions[1]!;
 assert.equal((await service.execute({ action: "apply", handle: first.handle, expectedEpisode: 1, candidateId: first.candidate!.id }, f.ctx)).status, "succeeded");
 assert.equal(await readFile(join(targets[0]!, "candidate.txt"), "utf8"), "candidate-1");
 await assert.rejects(readFile(join(targets[1]!, "candidate.txt")), { code: "ENOENT" });
 await assert.rejects(readFile(join(f.repo, "candidate.txt")), { code: "ENOENT" });
 await writeFile(join(targets[0]!, "later.txt"), "new target input");
 assert.equal((await service.execute({ action: "refresh", handle: first.handle, expectedEpisode: 1 }, f.ctx)).status, "succeeded");
 assert.equal(await readFile(join(f.store.path(first.handle), "source", "later.txt"), "utf8"), "new target input");
 await assert.rejects(readFile(join(f.store.path(second.handle), "source", "later.txt")), { code: "ENOENT" });
 assert.equal((await service.execute({ action: "continue", episodes: [{ handle: first.handle, requestId: "again", expectedEpisode: 1, message: "host-worker-fixture" }] }, f.ctx)).status, "succeeded");
 for (const [i, view] of created.sessions.entries()) {
  assert.equal((await service.execute({ action: "close", handle: view.handle, expectedEpisode: i === 0 ? 2 : 1, disposition: "discard" }, f.ctx)).status, "succeeded");
  assert.equal((await promisify(execFile)("git", ["-C", targets[i]!, "for-each-ref", "refs/csheng/subagents/"])).stdout, "");
  assert.equal((await promisify(execFile)("git", ["-C", targets[i]!, "worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)?.length, 1);
  assert.equal(await readFile(join(targets[i]!, "dirty.txt"), "utf8"), targets[i]);
 }
 assert.equal(await readFile(join(f.repo, "origin-only.txt"), "utf8"), "parent");
});

test("a target containing the origin repository discovers target skills instead of reusing the origin catalog", async t => {
 const f = await serviceFixture(t); const target = join(f.base, "target"), origin = join(target, "nested"); await mkdir(target); await rename(f.repo, origin); await promisify(execFile)("git", ["init", "-q", target]);
 await writeFile(join(target, ".gitignore"), "nested/\n");
 for (const [root, name] of [[target, "target-only"], [origin, "origin-only"]]) { const path = join(root!, ".agents", "skills", name!); await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nFixture guidance.\n`); }
 let catalogCalls = 0, checked = false;
 const service = new ContinuationService({ ...f.dependencies, getParentSkills: () => { catalogCalls++; return []; }, runChild: async options => {
  assert.equal(options.parentSkills, undefined); assert.equal(options.projectSkills, undefined);
  const guidance = await prepareChildGuidance(options.sourceRoot!, options.cwd, true, join(f.base, "empty-agent"), f.base, options.parentSkills, options.projectSkills);
  assert.ok(guidance.skillPaths.some(path => path.endsWith("/target-only"))); assert.ok(guidance.skillPaths.every(path => !path.endsWith("/origin-only"))); checked = true;
  return f.dependencies.runChild(options);
 } });
 const ctx = { ...f.ctx, cwd: origin };
 const result = await service.execute({ action: "create", requestId: "nested-guidance", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", repository: target, scope: ["."] }] }, ctx);
 assert.equal(result.status, "succeeded", JSON.stringify(result)); assert.equal(catalogCalls, 0); assert.equal(checked, true);
 assert.equal((await service.execute({ action: "close", handle: result.sessions[0]!.handle, expectedEpisode: 1, disposition: "discard" }, ctx)).status, "succeeded");
});

test("retargeted repository alias cannot redirect an accepted worker or delete another target", async t => {
 const f = await serviceFixture(t); const other = join(f.base, "other"); await mkdir(other); await promisify(execFile)("git", ["init", "-q", other]);
 const alias = join(f.base, "alias"); await symlink(f.repo, alias);
 const first = await f.service.execute({ action: "create", requestId: "pinned", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", repository: alias, scope: ["."] }] }, f.ctx);
 assert.equal(first.status, "succeeded", JSON.stringify(first)); const view = first.sessions[0]!; const launches = f.launches();
 await unlink(alias); await symlink(other, alias);
 for (const request of [
  { action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: view.candidate!.id },
  { action: "refresh", handle: view.handle, expectedEpisode: 1 },
  { action: "continue", episodes: [{ handle: view.handle, requestId: "wrong-target", expectedEpisode: 1, message: "host-worker-fixture" }] },
  { action: "close", handle: view.handle, expectedEpisode: 1, disposition: "discard" },
 ] as const) { const result = await f.service.execute(request, f.ctx); assert.equal(result.status, "failed", JSON.stringify(result)); assert.equal(result.error?.code, "task_repository_changed"); }
 assert.equal(f.launches(), launches); await assert.rejects(readFile(join(other, "candidate.txt")), { code: "ENOENT" });
 await unlink(alias); await symlink(f.repo, alias);
 assert.equal((await f.service.execute({ action: "close", handle: view.handle, expectedEpisode: 1, disposition: "discard" }, f.ctx)).status, "succeeded");
 assert.equal((await promisify(execFile)("git", ["-C", f.repo, "for-each-ref", "refs/csheng/subagents/"])).stdout, "");
});

test("native explorer create/continue reads an explicit external Git file without shell", async (t) => {
	const f = await serviceFixture(t);
	const sibling = join(f.base, "sibling"); await mkdir(sibling);
	await promisify(execFile)("git", ["init", "-q", sibling]);
	const external = join(sibling, "external.txt");
	await writeFile(external, "external-bytes");
	const first = await f.service.execute({ action: "create", requestId: "explore", tasks: [{ id: "explorer", role: "explorer", objective: "host-explorer-fixture", scope: ["."], externalReadRoots: [external] }] }, f.ctx);
	assert.equal(first.status, "succeeded", JSON.stringify(first));
	assert.equal(first.sessions[0]!.result!.observation?.available, true);
	assert.match(first.sessions[0]!.result!.output, /external-bytes/);
	assert.deepEqual(new Set(first.sessions[0]!.result!.observation!.toolNames), new Set(["read", "grep", "find", "ls", "git_read"]));
	const handle = first.sessions[0]!.handle;
	const native = join(f.store.path(handle), "native.jsonl");
	assert.equal((await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "user").length, 1);
	const next = await f.service.execute({ action: "continue", episodes: [{ handle, requestId: "explore-again", expectedEpisode: 1, message: "host-explorer-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded", JSON.stringify(next));
	assert.match(next.sessions[0]!.result!.output, /users=2/);
	assert.match(next.sessions[0]!.result!.output, /external-bytes/);
	assert.equal(next.sessions[0]!.result!.observation!.ownerSessionId, first.sessions[0]!.result!.observation!.ownerSessionId);
	assert.equal((await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "user").length, 2);
});

test("same-create report-only DAG hides unapplied worker candidates from a dependent reviewer", async (t) => {
	const f = await serviceFixture(t);
	const created = await f.service.execute({ action: "create", requestId: "report-only", tasks: [
		{ id: "worker", role: "worker", objective: "host-worker-fixture", scope: ["."], writePaths: ["candidate.txt"] },
		{ id: "reviewer", role: "reviewer", objective: "host-reviewer-fixture", scope: ["."], dependsOn: ["worker"] },
	] }, f.ctx);
	assert.equal(created.status, "succeeded", JSON.stringify(created));
	const worker = created.sessions[0]!;
	const review = created.sessions[1]!;
	assert.equal(worker.role, "worker");
	assert.equal(review.role, "reviewer");
	assert.ok(worker.candidate);
	assert.equal(await readFile(join(f.store.path(worker.handle), "source", "candidate.txt"), "utf8"), "candidate-1");
	await assert.rejects(readFile(join(f.repo, "candidate.txt")), { code: "ENOENT" });
	assert.match(await readFile(join(f.store.path(review.handle), "native.jsonl"), "utf8"), /Predecessor worker \(succeeded\)/);
	assert.doesNotMatch(review.result!.output, /candidate-1/);
	const apply = await f.service.execute({ action: "apply", handle: worker.handle, expectedEpisode: 1, candidateId: worker.candidate!.id }, f.ctx);
	assert.equal(apply.status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-1");
	const later = await f.service.execute({ action: "create", requestId: "review-after-apply", tasks: [{ id: "reviewer", role: "reviewer", objective: "host-reviewer-fixture", scope: ["."] }] }, f.ctx);
	assert.equal(later.status, "succeeded", JSON.stringify(later));
	assert.notEqual(later.sessions[0]!.handle, review.handle);
	assert.match(later.sessions[0]!.result!.output, /candidate-1/);
});
