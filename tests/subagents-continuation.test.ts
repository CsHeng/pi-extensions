import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergeOwnedUsage } from "../extensions/subagents/observability.ts";
import type { ObservedRun } from "../extensions/subagents/observation-hooks.ts";
import { ContinuationService } from "../extensions/subagents/continuation.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runChild } from "../extensions/subagents/runner.ts";
import { getRole } from "../extensions/subagents/roles.ts";
import { validateGraph } from "../extensions/subagents/graph.ts";
import { emptyUsage, emptyTaskTelemetry, type EffectiveRoute } from "../extensions/subagents/contracts.ts";

import { ManagedError, MANAGED_LIMITS, type SessionActionResult } from "../extensions/subagents/session-contracts.ts";

function assertReplay(actual: SessionActionResult, expected: SessionActionResult) {
	const { requestTelemetry: current, ...core } = actual;
	const { requestTelemetry: previous, ...prior } = expected;
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
	const graph = validateGraph({ tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", scope: ["."], writePaths: ["candidate.txt"] }] });
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

test("explicit close releases a slot but cannot reclaim mandatory-history capacity", async (t) => {
	const f = await serviceFixture(t);
	const owner = { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] };
	const graph = validateGraph({ tasks: Array.from({ length: MANAGED_LIMITS.maxSessions }, (_, index) => ({ id: `scan-${index}`, role: "explorer", objective: "scan", scope: ["."] })) });
	if (!graph.ok) throw new Error("fixture");
	const records = (await f.store.allocate(owner, "slots", graph.tasks)).records;
	await assert.rejects(f.store.allocate(owner, "overflow", [graph.tasks[0]!]), /session_limit/);
	const close = { action: "close", handle: records[0]!.handle, expectedEpisode: 0, disposition: "retain" };
	assert.equal((await f.service.execute(close, f.ctx)).status, "succeeded");
	assert.equal((await f.store.allocate(owner, "new-slot", [graph.tasks[0]!])).fresh, true);
	assert.equal((await f.service.execute({ ...close, disposition: "discard" }, f.ctx)).error?.code, "close_disposition_conflict");
	// Budget exhaustion is injected here; sparse-file/entry admission is tested by the store suite.
	f.store.checkCapacity = async () => { throw new ManagedError("managed_storage_limit"); };
	const native = join(f.store.path(records[1]!.handle), "native.jsonl");
	await writeFile(native, "retained-required-evidence");
	assert.equal((await f.service.execute({ ...close, handle: records[1]!.handle, disposition: "discard" }, f.ctx)).status, "succeeded");
	assert.equal(await readFile(native, "utf8"), "retained-required-evidence");
	const refused = await f.service.execute({ action: "create", requestId: "history-full", tasks: [{ id: "new", role: "explorer", objective: "scan", scope: ["."] }] }, f.ctx);
	assert.equal(refused.error?.code, "managed_storage_limit");
	assert.equal(refused.requestTelemetry?.launchedChildren, 0);
	assert.equal(f.launches(), 0);
});

const createWorker = { action: "create", requestId: "create-worker", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", scope: ["."], writePaths: ["candidate.txt"] }] };

test("managed service keeps B0 through C1/C2, replays inertly, restores on a new service and continues a reviewer on actual new bytes", async (t) => {
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
	const third = await restored.execute({ action: "continue", episodes: [{ handle, requestId: "again", expectedEpisode: 2, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(third.status, "succeeded", JSON.stringify(third));
	assert.match(third.sessions[0]!.result!.output, /users=3/);
	assert.equal((await restored.execute({ action: "apply", handle, expectedEpisode: 3, candidateId: third.sessions[0]!.candidate!.id }, f.ctx)).status, "succeeded");
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
	const mismatched = await restored.execute(request, f.ctx);
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
	let epoch = "config-one", reads = 0;
	const service = new ContinuationService({ ...f.dependencies,
		loadConfig: async () => { reads++; return { config: defaultConfig(), source: { packageBytes: Buffer.from("fixture") } }; },
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
	assert.ok(first.sessions[0]?.route?.model);
	epoch = "config-two";
	const replay = await service.execute(createWorker, f.ctx);
	assertReplay(replay, first);
	assert.equal(reads, 1);
	const handle = first.sessions[0]!.handle;
	const next = await service.execute({ action: "continue", episodes: [{ handle, requestId: "new-epoch", expectedEpisode: 1, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded");
	assert.equal(next.requestTelemetry?.configurationEpoch, "config-two");
	assert.deepEqual(next.sessions[0]?.execution?.provenance, { available: true, extensionEpoch: "extension", configurationEpoch: "config-two" });
	const historical = await service.execute(createWorker, f.ctx);
	assertReplay(historical, first);
	assert.equal(reads, 2);
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
	assert.deepEqual(new Set(first.sessions[0]!.result!.observation!.toolNames), new Set(["read", "grep", "find", "ls"]));
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
