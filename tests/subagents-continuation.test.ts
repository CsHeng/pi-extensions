import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergeOwnedUsage } from "../extensions/subagents/observability.ts";
import type { ObservedRun } from "../extensions/subagents/observation-hooks.ts";
import { ContinuationService, defaultEnclosingCapability } from "../extensions/subagents/continuation.ts";
import { formatManagedContent } from "../extensions/subagents/render.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runChild } from "../extensions/subagents/runner.ts";
import { authorizePath } from "../extensions/subagents/path-policy.ts";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { getRole } from "../extensions/subagents/roles.ts";
import { prepareChildGuidance } from "../extensions/subagents/guidance-resources.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { CHILD_CAPABILITY_ENV, CHILD_MARKER_ENV, emptyUsage, emptyTaskTelemetry, type EffectiveRoute } from "../extensions/subagents/contracts.ts";

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
	const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: cwd }] }] });
	if (!graph.ok) throw new Error("fixture");
	for (const count of [1, 2, 3]) {
		const result = await runChild({
			task: graph.tasks[0]!, role: { ...getRole("worker"), tools: [...getRole("worker").tools, "bash"] }, route, cwd,
			guardExtensionPath: new URL("../extensions/subagents/worker-tools.ts", import.meta.url).pathname,
			managedWorkerScratch: scratch,
			capability: { version: 4, cwd, role: "worker", grants: [{ permission: "write", path: cwd }], roots: [] },
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
		assert.equal(result.observation?.commandCoverage, "complete", "command evidence describes execution, not filesystem freshness");
		assert.equal(result.observation?.commands[0]?.status, "succeeded");
		assert.equal(result.observation?.commands[0]?.sourceBeforeKey, null, "missing runtime input state is unavailable");
		assert.equal(result.observation?.timing?.complete, count !== 3, "done-only thinking has no measured endpoints");
		assert.ok(result.observation!.timing!.spans.localTool.length > 0);
		assert.equal(await readFile(join(cwd, "candidate.txt"), "utf8"), `candidate-${count}`);
	}
	const entries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(entries.filter((entry) => entry.message?.role === "user").length, 3);
});

async function preparedSource(store: { load: (handle: string, owner: { repo: string; parentSessionId: string; anchor: string; branch: string[] }) => Promise<{ roots: Array<{ inputs?: { gitWorkspace?: { path: string } } }> }> }, handle: string, repo: string) {
	const record = await store.load(handle, { repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] });
	const path = record.roots.find(root => root.inputs?.gitWorkspace)?.inputs?.gitWorkspace?.path;
	if (!path) throw new Error("missing prepared source");
	return path;
}
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
			invocation: options.invocation ?? (process.env.CSHENG_CONTINUATION_HOST_PI === "installed"
				? { command: "pi", args: ["-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] }
				: { command: process.execPath, args: [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname, "-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-context-files"] }),
			env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: join(base, "agent"), PI_OFFLINE: "1", ...options.env },
		});
	} };
	return { base, repo, store, ctx, dependencies, runs, service: new ContinuationService(dependencies), launches: () => launches,
		cancelOnBash: (controller: AbortController) => { cancellation = { controller, tool: "bash", pidFile: "descendant.pid" }; },
		cancelOnSearch: (controller: AbortController) => { cancellation = { controller, tool: "find", pidFile: "search.pid" }; },
	};
}

test("one native child writes two repositories and applies one bundle", async (t) => {
	const f = await serviceFixture(t);
	const other = join(f.base, "other");
	await mkdir(other);
	await promisify(execFile)("git", ["init", "-q", other]);
	const evidence = join(f.base, "spec.txt");
	await writeFile(evidence, "from-a|client-v2\n");
	await writeFile(join(f.repo, "api.cjs"), 'module.exports = () => "primary-old";\n');
	await writeFile(join(other, "client.cjs"), 'module.exports = () => require(require("node:path").join(process.env.API_ROOT, "api.cjs"))() + "|client-v1";\n');
	await writeFile(join(other, "check.cjs"), 'require("node:assert/strict").equal(require("./client.cjs")(), require("node:fs").readFileSync(process.env.SPEC_FILE, "utf8").trim()); console.log("dependency-verified");\n');
	const checkPrimary = () => promisify(execFile)("node", ["check.cjs"], { cwd: other, env: { ...process.env, API_ROOT: f.repo, SPEC_FILE: evidence } });
	await assert.rejects(checkPrimary());
	const created = await f.service.execute({ action: "create", requestId: "tworoot", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture two-root-fixture", access: [{ permission: "write", scope: [f.repo, other] }, { permission: "read", scope: evidence }] }] }, f.ctx);
	assert.equal(created.status, "succeeded", JSON.stringify(created.error ?? created.sessions[0]?.result?.error ?? created));
	const view = created.sessions[0]!;
	assert.equal(view.handle, "worker");
	assert.equal(view.candidate?.roots.length, 2, JSON.stringify({ output: view.result?.output, error: view.result?.error, changed: view.result?.changedPaths }));
	assert.equal(new Set(view.candidate?.changedPaths).size, view.candidate?.changedPaths.length);
	assert.equal(f.launches(), 1);
	assert.equal(await readFile(join(f.repo, "api.cjs"), "utf8"), 'module.exports = () => "primary-old";\n');
	await assert.rejects(checkPrimary(), "the primary roots stay unchanged before apply");
	const native = await readFile(join(f.store.path(view.handle), "native.jsonl"), "utf8");
	const checkedInChild = native.split("\n").filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.message?.role === "toolResult" && !entry.message.isError && entry.message.content?.some((part: { text?: string }) => part.text?.includes("dependency-verified")));
	assert.equal(checkedInChild, true, "the real child ran the consumer command against its prepared API root");
	const applied = await f.service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: view.candidate!.id }, f.ctx);
	assert.equal(applied.status, "succeeded", JSON.stringify(applied.error ?? applied.sessions[0]?.candidate));
	assert.match((await checkPrimary()).stdout, /dependency-verified/);
	assert.equal(await readFile(evidence, "utf8"), "from-a|client-v2\n");
	assert.deepEqual([JSON.parse(await readFile(join(f.repo, "package.json"), "utf8")).name, JSON.parse(await readFile(join(other, "package.json"), "utf8")).name], ["alpha", "beta"]);
	assert.equal((await f.service.execute({ action: "inspect", handle: view.handle }, f.ctx)).status, "succeeded");
});

test("typed subdelegation cannot widen enclosing grants while a contained task stays eligible", async (t) => {
	const f = await serviceFixture(t);
	const outside = join(f.base, "outside"); await mkdir(outside); await promisify(execFile)("git", ["init", "-q", outside]);
	// The invoking child owns a write grant only inside f.repo.
	const enclosing = { version: 4 as const, role: "worker" as const, cwd: f.repo, grants: [{ permission: "write" as const, path: f.repo }], roots: [] };
	let launches = 0;
	const service = new ContinuationService({ ...f.dependencies, enclosingCapability: async () => enclosing, runChild: async options => { launches++; return f.dependencies.runChild(options); } });
	const outsideTask = { action: "create", requestId: "nestedout", tasks: [{ id: "nested", role: "worker", objective: "x", access: [{ permission: "write", scope: outside }] }] };
	const denied = await service.execute(outsideTask, f.ctx);
	assert.equal(denied.status, "failed");
	assert.equal(denied.error?.code, "nested_access_denied");
	assert.equal(launches, 0, "an unrelated root is rejected before allocation or launch");
	const escalation = await service.execute({ action: "create", requestId: "nestedesc", tasks: [{ id: "nested2", role: "worker", objective: "x", access: [{ permission: "read", scope: f.repo }, { permission: "write", scope: outside }] }] }, f.ctx);
	assert.equal(escalation.error?.code, "nested_access_denied");
	assert.equal(launches, 0);
	const alias = join(f.repo, "outsidealias"); await symlink(outside, alias, "dir");
	for (const permission of ["read", "write"]) {
		const escaped = await service.execute({ action: "create", requestId: "alias" + permission, tasks: [{ id: "alias", role: "worker", objective: "x", access: [{ permission, scope: alias }] }] }, f.ctx);
		assert.equal(escaped.error?.code, "nested_access_denied", "a lexical descendant cannot delegate an external physical owner");
	}
	await unlink(alias);
	const readOnly = new ContinuationService({ ...f.dependencies, enclosingCapability: async () => ({ ...enclosing, grants: [{ permission: "read", path: f.repo }] }), runChild: async () => { launches++; throw new Error("stub_child"); } });
	const upgraded = await readOnly.execute({ action: "create", requestId: "upgrade", tasks: [{ id: "upgrade", role: "worker", objective: "x", access: [{ permission: "write", scope: f.repo }] }] }, f.ctx);
	assert.equal(upgraded.error?.code, "nested_access_denied");
	assert.equal(launches, 0);
	const contained = await service.execute({ action: "create", requestId: "nestedin", tasks: [{ id: "nested3", role: "worker", objective: "x", access: [{ permission: "write", scope: f.repo }] }] }, f.ctx);
	assert.notEqual(contained.error?.code, "nested_access_denied", JSON.stringify(contained.error));
	assert.equal(launches, 1, "a grant inside the enclosing range remains eligible");
	const child = contained.sessions[0]!; enclosing.grants = [];
	const requests = [
		{ action: "continue", episodes: [{ handle: child.handle, requestId: "later", expectedEpisode: child.episode, message: "continue" }] },
		{ action: "refresh", handle: child.handle, expectedEpisode: child.episode },
		{ action: "apply", handle: child.handle, expectedEpisode: child.episode, candidateId: "Candidate" },
	];
	for (const request of requests) assert.equal((await service.execute(request, f.ctx)).error?.code, "nested_access_denied");
	assert.equal(launches, 1, "continuation does not retain an obsolete broader grant");
	assert.equal((await service.execute({ action: "close", handle: child.handle, expectedEpisode: child.episode, disposition: "discard" }, f.ctx)).status, "succeeded", "owned resource release remains available after narrowing");
});

test("known enclosing capability survives cwd differences and packet failures fail closed", async t => {
	const base = await mkdtemp(join(tmpdir(), "subagent-enclosing-"));
	const path = join(base, "capability.json");
	const previous = [process.env[CHILD_MARKER_ENV], process.env[CHILD_CAPABILITY_ENV]];
	t.after(async () => {
		for (const [index, key] of [CHILD_MARKER_ENV, CHILD_CAPABILITY_ENV].entries()) {
			const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(base, { recursive: true, force: true });
	});
	process.env[CHILD_MARKER_ENV] = "1"; process.env[CHILD_CAPABILITY_ENV] = path;
	await assert.rejects(defaultEnclosingCapability(), { code: "enclosing_capability_unavailable" });
	const cap = { version: 4, role: "worker", cwd: base, grants: [{ permission: "read", path: base }], roots: [] };
	await writeFile(path, JSON.stringify(cap), { mode: 0o600 });
	assert.notEqual(base, process.cwd());
	assert.deepEqual((await defaultEnclosingCapability())?.grants, cap.grants, "cwd is not an authority discriminator");
	await writeFile(path, JSON.stringify({ ...cap, version: 3 }));
	await assert.rejects(defaultEnclosingCapability(), { code: "enclosing_capability_unavailable" });
	delete process.env[CHILD_MARKER_ENV];
	assert.equal(await defaultEnclosingCapability(), undefined);
});

test("default launcher admission rejects a missing CLI before allocating or accepting an episode", async t => {
	const f = await serviceFixture(t);
	const native = new ContinuationService({ ...f.dependencies, runChild });
	const script = process.argv[1];
	try {
		process.argv[1] = join(f.base, "removed-cli.js");
		const denied = await native.execute({ action: "create", requestId: "nolauncher", tasks: [{ id: "read", role: "explorer", objective: "scan", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
		assert.equal(denied.error?.code, "launcher_unavailable");
		assert.equal(denied.requestTelemetry?.launchedChildren, 0);
		await assert.rejects(lstat(f.store.root), { code: "ENOENT" });
		if (script === undefined) delete process.argv[1]; else process.argv[1] = script;
		const first = await f.service.execute({ action: "create", requestId: "customlauncher", tasks: [{ id: "read", role: "explorer", objective: "scan", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
		assert.equal(first.status, "succeeded", JSON.stringify(first.error));
		process.argv[1] = join(f.base, "removed-cli.js");
		const continued = await native.execute({ action: "continue", episodes: [{ handle: first.sessions[0]!.handle, expectedEpisode: 1, requestId: "nonextlaunch", message: "continue" }] }, f.ctx);
		assert.equal(continued.error?.code, "launcher_unavailable");
		assert.equal(continued.sessions[0]!.episode, 1);
		assert.equal(continued.sessions[0]!.state, "idle");
		assert.equal(f.launches(), 1);
	} finally {
		if (script === undefined) delete process.argv[1]; else process.argv[1] = script;
		await native.shutdown(); await f.service.shutdown();
	}
});

test("replaced or removed external roots reject continuation before consuming an episode or launching", async (t) => {
	for (const change of ["replace", "remove"]) {
		const f = await serviceFixture(t);
		const root = join(f.base, "external.txt");
		await writeFile(root, "original");
		const task = { id: "readroot", role: "explorer", objective: "scan", access: [{ permission: "read", scope: f.repo }, { permission: "read", scope: root }] };
		const first = await f.service.execute({ action: "create", requestId: `root${change}`, tasks: [task] }, f.ctx);
		assert.equal(first.status, "succeeded");
		const handle = first.sessions[0]!.handle;
		await rename(root, `${root}.old`);
		if (change === "replace") await writeFile(root, "replacement");
		const failed = await f.service.execute({ action: "continue", episodes: [{ handle, expectedEpisode: 1, requestId: "invalidroot", message: "continue" }] }, f.ctx);
		assert.equal(failed.error?.code, "capability_invalidated");
		assert.equal(failed.sessions[0]?.episode, 1);
		assert.equal(failed.sessions[0]?.state, "idle");
		assert.equal(f.launches(), 1);
		if (change === "replace") {
			const fresh = await f.service.execute({ action: "create", requestId: "verifiednewroot", tasks: [{ ...task, id: "readroot2" }] }, f.ctx);
			assert.equal(fresh.status, "succeeded");
			assert.equal(f.launches(), 2);
		}
		await f.service.shutdown();
	}
});

test("explicit close releases a slot and retained-history warnings do not block new work", async (t) => {
	const f = await serviceFixture(t);
	const owner = { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] };
	const graph = validateGraphStructure({ tasks: Array.from({ length: MANAGED_LIMITS.maxSessions }, (_, index) => ({ id: `scan${index}`, role: "explorer", objective: "scan", access: [{ permission: "read", scope: f.repo }] })) });
	if (!graph.ok) throw new Error("fixture");
	const records = (await f.store.allocate(owner, "slots", graph.tasks)).records;
	await assert.rejects(f.store.allocate(owner, "overflow", [graph.tasks[0]!]), /session_limit/);
	const close = { action: "close", handle: records[0]!.handle, expectedEpisode: 0, disposition: "retain" };
	assert.equal((await f.service.execute(close, f.ctx)).status, "succeeded");
	assert.equal((await f.store.allocate(owner, "newslot", [{ ...graph.tasks[0]!, id: "scannew" }])).fresh, true);
	assert.equal((await f.service.execute({ ...close, disposition: "discard" }, f.ctx)).status, "succeeded");
	Object.defineProperty(f.store, "storageWarning", { get() { throw new Error("global scan forbidden"); } });
	const native = join(f.store.path(records[1]!.handle), "native.jsonl");
	await writeFile(native, "retained-required-evidence");
	assert.equal((await f.service.execute({ ...close, handle: records[1]!.handle, disposition: "discard" }, f.ctx)).status, "succeeded");
	assert.equal(await readFile(native, "utf8"), "retained-required-evidence");
	const admitted = await f.service.execute({ action: "create", requestId: "historyfull", tasks: [{ id: "new", role: "explorer", objective: "scan", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
	assert.equal(admitted.status, "succeeded", JSON.stringify(admitted.error ?? admitted.sessions[0]?.result?.error));
	assert.equal(admitted.warnings, undefined);
	assert.equal(admitted.requestTelemetry?.launchedChildren, 1);
	assert.equal(f.launches(), 1);
});

const createWorker = (repo: string) => ({ action: "create", requestId: "createworker", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: repo }] }] });

test("normal and replay actions avoid global inventory while close still releases owned work", async (t) => {
	const f = await serviceFixture(t);
	Object.defineProperty(f.store, "storageWarning", { get() { throw new Error("global scan forbidden"); } });
	const first = await f.service.execute(createWorker(f.repo), f.ctx);
	assert.equal(first.status, "succeeded"); assert.equal(first.warnings, undefined);
	const handle = first.sessions[0]!.handle;
	const replay = await new ContinuationService(f.dependencies).execute(createWorker(f.repo), f.ctx);
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
	const episode = await failing.execute(createWorker(f.repo), f.ctx);
	assert.equal(episode.status, "failed");
	assert.equal(episode.sessions[0]!.requestError?.code, "managed_operation_failed");
	assert.equal(episode.sessions[0]!.requestError?.detail, "ENOENT");
	assert.equal(episode.sessions[0]!.state, "interrupted", "an untyped child failure still commits the interrupted episode");
	const request = await new ContinuationService({ ...f.dependencies, loadConfig: async () => { throw errnoError("EACCES", "EACCES: permission denied, open '/tmp/secret/routes.json'"); } }).execute({ ...createWorker(f.repo), requestId: "createworkerconfig" }, f.ctx);
	assert.equal(request.status, "failed");
	assert.equal(request.error?.code, "managed_operation_failed");
	assert.equal(request.error?.detail, "EACCES");
	for (const response of [episode, request]) {
		assert.doesNotMatch(JSON.stringify(response), /\/tmp\/secret|lstat|permission denied/);
	}
});

test("managed service keeps fixed inputs, replays inertly, restores history and explicitly refreshes before repair/review", async (t) => {
	const f = await serviceFixture(t);
	const first = await f.service.execute(createWorker(f.repo), f.ctx);
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
	assertReplay(await f.service.execute(createWorker(f.repo), f.ctx), first);
	assert.equal(f.runs.length, beforeReplay, "cached create is not a new execution wave");
	assert.equal(f.runs[0]!.telemetry.timing?.children[0]?.taskId, first.sessions[0]!.result!.observation!.ownerSessionId);
	assertReplay(await f.service.execute({ ...createWorker(f.repo), tasks: createWorker(f.repo).tasks.map((task) => ({ access: task.access, objective: task.objective, inputs: [], role: task.role, id: task.id })) }, f.ctx), first);
	assert.equal(await readFile(join(f.store.path(handle), "native.jsonl"), "utf8"), before);
	assert.equal(f.launches(), 2);
	const apply = { action: "apply", handle, expectedEpisode: 2, candidateId: second.sessions[0]!.candidate!.id };
	assert.equal((await f.service.execute(apply, f.ctx)).status, "succeeded");
	assert.equal((await f.service.execute(apply, f.ctx)).status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-2");
	const reviewer = await f.service.execute({ action: "create", requestId: "review", tasks: [{ id: "reviewer", role: "reviewer", objective: "host-reviewer-fixture", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
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
	const source = await preparedSource(f.store, handle, f.repo);
	const close = { action: "close", handle, expectedEpisode: 3, disposition: "discard" };
	assert.equal((await restored.execute(close, f.ctx)).status, "succeeded");
	assert.equal((await restored.execute(close, f.ctx)).status, "succeeded");
	await assert.rejects(readFile(join(source, "candidate.txt")), { code: "ENOENT" });
	const calls = f.launches();
	assertReplay(await restored.execute(next, f.ctx), second);
	assert.equal((await restored.execute({ action: "continue", episodes: [{ handle, requestId: "afterclose", expectedEpisode: 3, message: "host-worker-fixture" }] }, f.ctx)).status, "failed");
	assert.equal(f.launches(), calls);
});

test("native workers prepare their own dependencies and preserve Git ownership despite parent overrides", async (t) => {
	const f = await serviceFixture(t);
	await writeFile(join(f.repo, ".gitignore"), "node_modules/\n");
	await mkdir(join(f.repo, "node_modules/pkg"), { recursive: true });
	await writeFile(join(f.repo, "node_modules/pkg/index.js"), 'module.exports = "dependency-1"');
	const config = await readFile(join(f.repo, ".git/config"));
	const service = new ContinuationService({ ...f.dependencies, runChild: (options) => f.dependencies.runChild({ ...options, env: { GIT_DIR: join(f.repo, ".git"), GIT_WORK_TREE: f.repo } }) });
	const initial = await service.execute({ ...createWorker(f.repo), tasks: createWorker(f.repo).tasks.map((task) => ({ ...task, objective: `${task.objective} host-inputs-fixture` })) }, f.ctx);
	assert.equal(initial.status, "succeeded"); const first = initial.sessions[0]!;
	assert.ok(first.candidate);
	const observation = first.result!.observation!;
	assert.equal(observation.available, true);
	assert.equal(observation.commandCoverage, "complete");
	assert.deepEqual(new Set(observation.toolNames), new Set(["read", "grep", "find", "ls", "git_read", "edit", "write", "bash"]));
	assert.match(observation.capabilityKey!, /^[a-f0-9]{64}$/);
	for (const command of observation.commands) {
		assert.equal(command.sourceBeforeKey, null);
		assert.equal(command.sourceAfterKey, null);
		assert.equal(command.environmentBeforeKey, undefined);
		assert.equal(command.environmentAfterKey, undefined);
	}
	const source = await preparedSource(f.store, first.handle, f.repo);
	assert.equal((await promisify(execFile)("git", ["-C", source, "show", ":candidate.txt"])).stdout, "local-dependency");
	const firstEntries = (await readFile(join(f.store.path(first.handle), "native.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const bash = firstEntries.filter((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "bash");
	assert.equal(bash.length, 1); assert.equal(bash[0].message.isError, false);
	assert.equal(await readFile(join(await preparedSource(f.store, first.handle, f.repo), "candidate.txt"), "utf8"), "local-dependency");
	await writeFile(join(f.repo, "node_modules/pkg/index.js"), 'module.exports = "dependency-2"');
	assert.equal((await service.execute({ action: "refresh", handle: first.handle, expectedEpisode: 1 }, f.ctx)).status, "succeeded");
	const next = await service.execute({ action: "continue", episodes: [{ handle: first.handle, requestId: "next", expectedEpisode: 1, message: "host-worker-fixture host-inputs-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded"); assert.ok(next.sessions[0]!.candidate);
	assert.equal(await readFile(join(await preparedSource(f.store, first.handle, f.repo), "candidate.txt"), "utf8"), "local-dependency");
	await assert.rejects(readFile(join(f.repo, "candidate.txt")), { code: "ENOENT" });
	await assert.rejects(readFile(join(f.repo, ".git/index")), { code: "ENOENT" });
	assert.deepEqual(await readFile(join(f.repo, ".git/config")), config);
});

test("managed finalization succeeds beyond the former native-history byte budget", async (t) => {
 const f = await serviceFixture(t);
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => {
  const header = { type: "session", version: 3, id: "large-history", cwd: options.cwd, timestamp: new Date().toISOString() };
  const lines = [JSON.stringify(header)];
  for (let index = 0; index < 40; index++) lines.push(JSON.stringify({ type: "custom", customType: "synthetic-history", id: `bulk-${index}`, parentId: index ? `bulk-${index - 1}` : null, timestamp: header.timestamp, data: "x".repeat(900_000) }));
  await writeFile(options.diagnosticSession.path, lines.join("\n") + "\n");
  return f.dependencies.runChild(options);
 } });
 const result = await service.execute(createWorker(f.repo), f.ctx);
 assert.equal(result.status, "succeeded", JSON.stringify(result));
 assert.equal(result.sessions[0]!.result!.workerToolsSettled, true);
 assert.ok(result.sessions[0]!.candidate, "large auxiliary history cannot invalidate a completed source candidate");
 assert.equal(result.sessions[0]!.result!.observation?.available, false, "bounded optional observation may remain unavailable");
 const file = join(f.store.path(result.sessions[0]!.handle), "native.jsonl");
 assert.ok((await lstat(file)).size > 32 * 1024 * 1024);
 assert.equal((await f.store.nativeRevision(result.sessions[0]!.handle)).sessionId, "large-history");
});

test("managed cancellation drains an actual bash process group before returning", async (t) => {
	const f = await serviceFixture(t);
	const controller = new AbortController(); f.cancelOnBash(controller);
	const result = await f.service.execute({ ...createWorker(f.repo), tasks: [{ ...createWorker(f.repo).tasks[0], objective: "host-worker-fixture cancel-fixture" }] }, f.ctx, controller.signal);
	assert.equal(result.status, "aborted", JSON.stringify(result));
	const handle = result.sessions[0]!.handle;
	assert.equal(result.sessions[0]!.result?.workerToolsSettled, true, JSON.stringify(result));
	const pid = Number(await readFile(join(f.store.path(handle), "scratch", "descendant.pid"), "utf8"));
	await assertProcessStopped(pid);
	await assert.rejects(readFile(join(await preparedSource(f.store, handle, f.repo), "orphan.txt")), { code: "ENOENT" });
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
	const result = await service.execute({ ...createWorker(f.repo), tasks: [{ ...createWorker(f.repo).tasks[0], objective: "host-worker-fixture host-search-fixture" }] }, f.ctx, controller.signal);
	assert.equal(result.status, "aborted", JSON.stringify(result));
	const pid = Number(await readFile(join(f.store.path(result.sessions[0]!.handle), "scratch", "search.pid"), "utf8"));
	await assertProcessStopped(pid);
});

test("completed create and continue replay without execution configuration; new episodes still require routes", async (t) => {
	const f = await serviceFixture(t);
	const first = await f.service.execute(createWorker(f.repo), f.ctx);
	const request = { action: "continue", episodes: [{ handle: first.sessions[0]!.handle, requestId: "repair", expectedEpisode: 1, message: "host-worker-fixture" }] };
	const second = await f.service.execute(request, f.ctx);
	assert.equal(second.status, "succeeded");
	const unavailable = new ContinuationService({ ...f.dependencies, loadConfig: async () => ({ diagnostic: { code: "invalid_route_config", message: "fixture" } }) });
	assertReplay(await unavailable.execute(createWorker(f.repo), f.ctx), first);
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
		if (options.task.id === "fail" || options.task.id === "blockedfail") return { id: options.task.id, role: "explorer", status: "failed", output: "", stderr: "", usage: emptyUsage(), durationMs: 0, changedPaths: [], convergence: "not-applicable", telemetry: emptyTaskTelemetry(), error: { code: "fixture_failure", message: "fixture" } };
		return f.dependencies.runChild(options);
	} });
	for (const dependent of [false, true]) {
		const fail = dependent ? "blockedfail" : "fail";
		const other = dependent ? "blockedother" : "other";
		const request = { action: "create", requestId: dependent ? "blocked" : "partial", tasks: [
			{ id: fail, role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] },
			{ id: other, role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }], ...(dependent ? { dependsOn: [fail] } : {}) },
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
 const response = await service.execute({ action: "create", requestId: "nostart", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
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
 const result = await service.execute({ action: "create", requestId: "nostartsave", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
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
 const request = { action: "create", requestId: "nativefault", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] }] };
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
 const failed = await service.execute(createWorker(f.repo), f.ctx);
 assert.equal(failed.status, "failed");
 const view = failed.sessions[0]!;
 assert.equal(view.result?.output, "worker executed"); assert.equal(view.result?.usage.input, 37);
 assert.equal(view.result?.executionStatus, "succeeded"); assert.equal(view.result?.finalization?.stage, "candidate-freeze");
 assert.equal(view.candidate, undefined);
 assert.equal((await service.execute(createWorker(f.repo), f.ctx)).status, "failed"); assert.equal(calls, 1);
});

test("repeated post-freeze save failures cannot expose a worker candidate", async (t) => {
 const f = await serviceFixture(t); let childDone = false; let calls = 0; let candidateId: string | undefined;
 const save = f.store.save.bind(f.store);
 f.store.save = async record => { if (childDone) { candidateId ??= record.candidate?.id; throw new Error("persistent disk failure"); } return save(record); };
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); childDone = true; return result; } });
 const response = await service.execute(createWorker(f.repo), f.ctx);
 assert.equal(response.status, "failed"); assert.equal(response.error?.code, "result_persistence_failed");
 const view = response.sessions[0]!;
 assert.ok(candidateId); assert.equal(view.candidate, undefined);
 assert.equal(view.result?.executionStatus, "succeeded"); assert.equal(view.result?.finalization?.stage, "result-save");
 const apply = await service.execute({ action: "apply", handle: view.handle, expectedEpisode: 1, candidateId }, f.ctx);
 assert.notEqual(apply.status, "succeeded"); assert.equal(calls, 1);
 assert.notEqual((await service.execute(createWorker(f.repo), f.ctx)).status, "succeeded"); assert.equal(calls, 1);
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
 const result = await service.execute(createWorker(f.repo), f.ctx);
 assert.equal(result.status, "failed"); assert.equal(result.error?.code, "result_persistence_failed"); assert.ok(candidateId);
 assert.equal(result.sessions[0]?.result?.executionStatus, "succeeded"); assert.equal(result.sessions[0]?.candidate, undefined);
 f.store.save = save;
 const handle = result.sessions[0]!.handle;
 const inspected = await service.execute({ action: "inspect", handle }, f.ctx);
 assert.equal(inspected.sessions[0]?.candidate, undefined); assert.equal(inspected.sessions[0]?.result?.status, "failed");
 const apply = await service.execute({ action: "apply", handle, expectedEpisode: 1, candidateId }, f.ctx);
 assert.notEqual(apply.status, "succeeded");
 assert.notEqual((await service.execute(createWorker(f.repo), f.ctx)).status, "succeeded"); assert.equal(calls, 1);
 assert.equal((await service.execute({ action: "close", handle, expectedEpisode: 1, disposition: "retain" }, f.ctx)).status, "succeeded");
 assert.equal((await service.execute({ action: "inspect", handle }, f.ctx)).sessions[0]?.state, "closed");
 assert.equal((await service.execute({ action: "close", handle, expectedEpisode: 1, disposition: "discard" }, f.ctx)).status, "succeeded");
 assert.equal((await f.store.list({ repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] })).some(view => view.handle === handle), false);
});

test("required result-save failure retains child facts and replays failed without a second child", async (t) => {
 const f = await serviceFixture(t);
 const save = f.store.save.bind(f.store); let injected = false; let calls = 0;
 f.store.save = async record => { if (!injected && record.result?.status === "succeeded") { injected = true; throw new Error("write failed"); } return save(record); };
 const child = f.dependencies.runChild;
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { calls++; const result = await child(options); return { ...result, status: "succeeded", output: "retained child", usage: { ...result.usage, input: 23 }, durationMs: 17 }; } });
 const request = { action: "create", requestId: "savefault", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] }] };
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
 const request = { action: "create", requestId: "persistentfault", tasks: [{ id: "scan", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] }] };
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
	const initial = await f.service.execute(createWorker(f.repo), f.ctx);
	assert.equal(initial.status, "succeeded");
	const view = initial.sessions[0]!;
	assert.ok(view.candidate);
	assert.equal(view.result?.observation?.available, false);
	assert.equal(view.result?.observation?.usage.cost, null);
	assert.doesNotMatch(await readFile(join(f.store.path(view.handle), "registry.json"), "utf8"), /"observation":/);
	assertReplay(await new ContinuationService(f.dependencies).execute(createWorker(f.repo), f.ctx), initial);
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
	const initial = await service.execute({ ...createWorker(f.repo), tasks: createWorker(f.repo).tasks.map((task) => ({ ...task, objective: `${task.objective} private-continuity-fixture` })) }, f.ctx);
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
	assert.equal(await readFile(join(await preparedSource(f.store, handle, f.repo), "candidate.txt"), "utf8"), "candidate-1");
	const source = await preparedSource(f.store, handle, f.repo);
	const rootIdentity = await lstat(source); const dependencyIdentity = await lstat(join(source, "node_modules/fixture-state"));
	const next = await service.execute({ action: "continue", episodes: [{ handle, requestId: "aftercompaction", expectedEpisode: 1, message: "host-worker-fixture after-child-compaction-fixture" }] }, f.ctx);
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
	const initial = await f.service.execute(createWorker(f.repo), f.ctx);
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
	const mismatched = await restored.execute({ ...request, episodes: request.episodes.map(episode => ({ ...episode, requestId: "changednative" })) }, f.ctx);
	assert.equal(mismatched.sessions[0]!.requestError?.code, "native_leaf_mismatch");
	assert.equal(await readFile(native, "utf8"), changed);
	assert.equal(f.launches(), 1);
});

test("create cancellation with queued tasks has an exact inert terminal replay", async (t) => {
	const f = await serviceFixture(t);
	const service = new ContinuationService({ ...f.dependencies, loadConfig: async () => ({ config: { ...defaultConfig(), maxConcurrency: 1 } }) });
	const controller = new AbortController(); f.cancelOnBash(controller);
	const request = { ...createWorker(f.repo), tasks: [{ ...createWorker(f.repo).tasks[0], objective: "host-worker-fixture cancel-fixture" }, { id: "queued", role: "explorer", objective: "inspect", access: [{ permission: "read", scope: f.repo }] }] };
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
	const first = await service.execute(createWorker(f.repo), f.ctx);
	assert.equal(first.status, "succeeded");
	assert.equal(first.requestTelemetry?.configurationEpoch, "config-one");
	assert.equal(first.requestTelemetry?.launchedChildren, 1);
	assert.deepEqual(first.sessions[0]?.execution?.provenance, { available: true, extensionEpoch: "extension", configurationEpoch: "config-one" });
	assert.equal(first.sessions[0]?.execution?.inheritSkills, true);
	assert.ok(first.sessions[0]?.route?.model);
	epoch = "config-two"; inheritSkills = false;
	const replay = await service.execute(createWorker(f.repo), f.ctx);
	assertReplay(replay, first);
	assert.equal(reads, 1);
	const handle = first.sessions[0]!.handle;
	const next = await service.execute({ action: "continue", episodes: [{ handle, requestId: "newepoch", expectedEpisode: 1, message: "host-worker-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded");
	assert.equal(next.requestTelemetry?.configurationEpoch, "config-two");
	assert.deepEqual(next.sessions[0]?.execution?.provenance, { available: true, extensionEpoch: "extension", configurationEpoch: "config-two" });
	assert.equal(next.sessions[0]?.execution?.inheritSkills, false);
	const historical = await service.execute(createWorker(f.repo), f.ctx);
	assertReplay(historical, first);
	assert.equal(reads, 2);
});

test("one origin independently owns sibling worker targets, inputs, apply, refresh and cleanup", async t => {
 const f = await serviceFixture(t); const targets = [join(f.base, "left"), join(f.base, "right")]; const roots: string[] = [];
 await writeFile(join(f.repo, "origin-only.txt"), "parent");
 for (const target of targets) { await mkdir(target); await promisify(execFile)("git", ["init", "-q", target]); await writeFile(join(target, "dirty.txt"), target); }
 const service = new ContinuationService({ ...f.dependencies, runChild: async options => { roots.push(options.sourceRoot!); return f.dependencies.runChild(options); } });
 const created = await service.execute({ action: "create", requestId: "siblings", tasks: targets.map((repository, i) => ({ id: `worker${i}`, role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: repository }] })) }, f.ctx);
 assert.equal(created.status, "succeeded", JSON.stringify(created)); assert.deepEqual(new Set(roots), new Set(targets));
 const records = await Promise.all(created.sessions.map(view => f.store.load(view.handle, { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] })));
 assert.notEqual(records[0]!.roots[0]!.input!.commit, records[1]!.roots[0]!.input!.commit);
 for (const [i, view] of created.sessions.entries()) {
  const record = records[i]!; assert.equal(record.owner.repo, f.repo); assert.equal(record.roots[0]!.source, targets[i]); assert.equal(record.roots[0]!.inputs?.gitWorkspace?.repo, targets[i]);
  assert.equal(await readFile(join(record.roots[0]!.inputs!.gitWorkspace!.path, "dirty.txt"), "utf8"), targets[i]);
  await assert.rejects(readFile(join(record.roots[0]!.inputs!.gitWorkspace!.path, "origin-only.txt")), { code: "ENOENT" });
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
 const refreshed = await f.store.load(first.handle, { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] });
 assert.equal(await readFile(join(refreshed.roots[0]!.inputs!.gitWorkspace!.path, "later.txt"), "utf8"), "new target input");
 const other = await f.store.load(second.handle, { repo: f.repo, parentSessionId: "parent", anchor: "anchor", branch: ["anchor"] });
 await assert.rejects(readFile(join(other.roots[0]!.inputs!.gitWorkspace!.path, "later.txt")), { code: "ENOENT" });
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
 const result = await service.execute({ action: "create", requestId: "nestedguidance", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: target }] }] }, ctx);
 assert.equal(result.status, "succeeded", JSON.stringify(result)); assert.equal(catalogCalls, 0); assert.equal(checked, true);
 assert.equal((await service.execute({ action: "close", handle: result.sessions[0]!.handle, expectedEpisode: 1, disposition: "discard" }, ctx)).status, "succeeded");
});

test("retargeted repository alias cannot redirect an accepted worker or delete another target", async t => {
 const f = await serviceFixture(t); const other = join(f.base, "other"); await mkdir(other); await promisify(execFile)("git", ["init", "-q", other]);
 const alias = join(f.base, "alias"); await symlink(f.repo, alias);
 const first = await f.service.execute({ action: "create", requestId: "pinned", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: alias }] }] }, f.ctx);
 assert.equal(first.status, "succeeded", JSON.stringify(first)); const view = first.sessions[0]!; const launches = f.launches();
 await unlink(alias); await symlink(other, alias);
 for (const request of [
  { action: "apply", handle: view.handle, expectedEpisode: 1, candidateId: view.candidate!.id },
  { action: "refresh", handle: view.handle, expectedEpisode: 1 },
  { action: "continue", episodes: [{ handle: view.handle, requestId: "wrongtarget", expectedEpisode: 1, message: "host-worker-fixture" }] },
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
	const first = await f.service.execute({ action: "create", requestId: "explore", tasks: [{ id: "explorer", role: "explorer", objective: "host-explorer-fixture", access: [{ permission: "read", scope: [f.repo, external] }] }] }, f.ctx);
	assert.equal(first.status, "succeeded", JSON.stringify(first));
	assert.equal(first.sessions[0]!.result!.observation?.available, true);
	assert.match(first.sessions[0]!.result!.output, /external-bytes/);
	assert.ok(first.sessions[0]!.result!.observation!.toolNames?.includes("read"));
	assert.ok(first.sessions[0]!.result!.observation!.toolNames?.includes("git_read"));
	assert.equal(first.sessions[0]!.result!.observation!.toolNames?.includes("edit"), false);
	const handle = first.sessions[0]!.handle;
	const native = join(f.store.path(handle), "native.jsonl");
	assert.equal((await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "user").length, 1);
	const next = await f.service.execute({ action: "continue", episodes: [{ handle, requestId: "exploreagain", expectedEpisode: 1, message: "host-explorer-fixture" }] }, f.ctx);
	assert.equal(next.status, "succeeded", JSON.stringify(next));
	assert.match(next.sessions[0]!.result!.output, /users=2/);
	assert.match(next.sessions[0]!.result!.output, /external-bytes/);
	assert.equal(next.sessions[0]!.result!.observation!.ownerSessionId, first.sessions[0]!.result!.observation!.ownerSessionId);
	assert.equal((await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.message?.role === "user").length, 2);
});

test("same-create report-only DAG hides unapplied worker candidates from a dependent reviewer", async (t) => {
	const f = await serviceFixture(t);
	const created = await f.service.execute({ action: "create", requestId: "reportonly", tasks: [
		{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: f.repo }] },
		{ id: "reviewer", role: "reviewer", objective: "host-reviewer-fixture", access: [{ permission: "read", scope: f.repo }], dependsOn: ["worker"] },
	] }, f.ctx);
	assert.equal(created.status, "succeeded", JSON.stringify(created));
	const worker = created.sessions[0]!;
	const review = created.sessions[1]!;
	assert.equal(worker.role, "worker");
	assert.equal(review.role, "reviewer");
	assert.ok(worker.candidate);
	assert.equal(await readFile(join(await preparedSource(f.store, worker.handle, f.repo), "candidate.txt"), "utf8"), "candidate-1");
	await assert.rejects(readFile(join(f.repo, "candidate.txt")), { code: "ENOENT" });
	assert.match(await readFile(join(f.store.path(review.handle), "native.jsonl"), "utf8"), /Predecessor worker \(succeeded\)/);
	assert.doesNotMatch(review.result!.output, /candidate-1/);
	const apply = await f.service.execute({ action: "apply", handle: worker.handle, expectedEpisode: 1, candidateId: worker.candidate!.id }, f.ctx);
	assert.equal(apply.status, "succeeded");
	assert.equal(await readFile(join(f.repo, "candidate.txt"), "utf8"), "candidate-1");
	const later = await f.service.execute({ action: "create", requestId: "reviewafterapply", tasks: [{ id: "reviewer2", role: "reviewer", objective: "host-reviewer-fixture", access: [{ permission: "read", scope: f.repo }] }] }, f.ctx);
	assert.equal(later.status, "succeeded", JSON.stringify(later));
	assert.notEqual(later.sessions[0]!.handle, review.handle);
	assert.match(later.sessions[0]!.result!.output, /candidate-1/);
});

test("same-repository partial write and read grants bind the prepared read and isolate it from the source", async (t) => {
	const f = await serviceFixture(t);
	await writeFile(join(f.repo, "z.ts"), "source-z\n");
	await promisify(execFile)("git", ["-C", f.repo, "add", "--", "z.ts"]);
	await promisify(execFile)("git", ["-C", f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
	let captured: Parameters<typeof runChild>[0] | undefined;
	const service = new ContinuationService({ ...f.dependencies, runChild: async options => { captured = options; return f.dependencies.runChild(options); } });
	const created = await service.execute({ action: "create", requestId: "partialrw", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: join(f.repo, "candidate.txt") }, { permission: "read", scope: join(f.repo, "z.ts") }] }] }, f.ctx);
	assert.equal(created.status, "succeeded", JSON.stringify(created.error ?? created.sessions[0]?.result?.error ?? created));
	assert.ok(captured);
	const grants = captured.capability.grants;
	const readGrant = grants.find(grant => grant.permission === "read" && grant.path.endsWith("z.ts"));
	const writeGrant = grants.find(grant => grant.permission === "write" && grant.path.endsWith("candidate.txt"));
	assert.ok(readGrant && writeGrant, JSON.stringify(grants));
	const prepared = captured.cwd;
	assert.equal(readGrant.path, join(prepared, "z.ts"));
	assert.equal(writeGrant.pin, undefined, "a writable selector is not pinned to a mutable leaf");
	assert.ok(writeGrant.anchor, JSON.stringify(writeGrant));
	assert.equal(writeGrant.anchor.path, prepared);
	assert.equal(readGrant.anchor, undefined);
	const capabilityReadRoot = captured.capability.roots.find(root => root.permission === "read" && root.source === f.repo);
	assert.equal(capabilityReadRoot?.path, prepared, "an auxiliary same-repo read root advertises the prepared mapping");
	const taskReadRoot = captured.task.roots?.find(root => root.permission === "read");
	assert.equal(taskReadRoot?.path, prepared);
	const preparedIdentity = await lstat(readGrant.path);
	const sourceIdentity = await lstat(join(f.repo, "z.ts"));
	assert.ok(readGrant.pin, JSON.stringify(readGrant));
	assert.equal(readGrant.pin.ino, preparedIdentity.ino, "the prepared read is pinned to its own identity");
	assert.notEqual(readGrant.pin.ino, sourceIdentity.ino, "the source-checkout inode is never projected onto the prepared read");
	assert.equal((await authorizePath(captured.capability, "read", readGrant.path)).allowed, true);
	assert.equal((await authorizePath(captured.capability, "write", readGrant.path)).allowed, false);
	assert.equal((await authorizePath(captured.capability, "write", join(prepared, "sibling.ts"))).allowed, false);
	assert.equal((await authorizePath(captured.capability, "write", writeGrant.path)).allowed, true);
	assert.equal(await readFile(readGrant.path, "utf8"), "source-z\n");
	await writeFile(join(f.repo, "z.ts"), "edited-source\n");
	assert.equal(await readFile(readGrant.path, "utf8"), "source-z\n", "a later source edit does not change the isolated prepared bytes");
	const view = created.sessions[0]!;
	assert.ok(view.candidate);
	assert.equal(await readFile(join(await preparedSource(f.store, view.handle, f.repo), "candidate.txt"), "utf8"), "candidate-1");
	// An authorized writable leaf can be deleted and recreated without invalidating the capability.
	await rm(writeGrant.path);
	assert.equal((await authorizePath(captured.capability, "write", writeGrant.path)).allowed, true);
	await writeFile(writeGrant.path, "candidate-1");
	assert.equal((await authorizePath(captured.capability, "write", writeGrant.path)).allowed, true);
});

test("a same-repository auxiliary read root reuses the prepared mapping and one guidance pass", async (t) => {
	const f = await serviceFixture(t);
	const skillDir = join(f.repo, ".agents", "skills", "guide");
	await mkdir(skillDir, { recursive: true });
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: guide\ndescription: Fixture guide.\n---\n# Guide\n");
	await writeFile(join(f.repo, "z.ts"), "source-z\n");
	await promisify(execFile)("git", ["-C", f.repo, "add", "--", "."]);
	await promisify(execFile)("git", ["-C", f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
	const parentSkills = loadSkills({ cwd: f.repo, agentDir: join(f.base, "agent"), includeDefaults: false, skillPaths: [skillDir] }).skills
		.map(skill => ({ ...skill, sourceInfo: { ...skill.sourceInfo, scope: "project" as const } }));
	let captured: Parameters<typeof runChild>[0] | undefined;
	const service = new ContinuationService({ ...f.dependencies, getParentSkills: () => parentSkills, runChild: async options => { captured = options; return f.dependencies.runChild(options); } });
	const created = await service.execute({ action: "create", requestId: "auxread", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: join(f.repo, "candidate.txt") }, { permission: "read", scope: join(f.repo, "z.ts") }] }] }, f.ctx);
	assert.equal(created.status, "succeeded", JSON.stringify(created.error ?? created.sessions[0]?.result?.error ?? created));
	assert.ok(captured);
	const prepared = captured.cwd;
	const capabilityReadRoot = captured.capability.roots.find(root => root.permission === "read" && root.source === f.repo);
	assert.equal(capabilityReadRoot?.path, prepared, "capability roots use the prepared mapping");
	const taskReadRoot = captured.task.roots?.find(root => root.permission === "read");
	assert.equal(taskReadRoot?.path, prepared, "task roots use the prepared mapping");
	const preparedSkill = join(prepared, ".agents", "skills", "guide");
	const liveSkill = join(f.repo, ".agents", "skills", "guide");
	const skillPaths = captured.preparedGuidance?.skillPaths ?? [];
	assert.ok(skillPaths.includes(preparedSkill), `prepared catalog missing: ${JSON.stringify(skillPaths)}`);
	assert.ok(skillPaths.every(path => path !== liveSkill), `live source catalog leaked: ${JSON.stringify(skillPaths)}`);
	assert.ok((captured.preparedGuidance?.contextFiles ?? []).every(file => !file.path.startsWith(f.repo)), "live source context leaked");
});

test("a two-root native worker keeps the captured primary catalog and discovers the secondary catalog", async (t) => {
	const f = await serviceFixture(t);
	const other = join(f.base, "other"); await mkdir(other); await promisify(execFile)("git", ["init", "-q", other]);
	const primary = join(f.repo, ".agents", "skills", "primary-guide");
	const decoy = join(f.repo, ".agents", "skills", "origin-decoy");
	const secondary = join(other, ".agents", "skills", "secondary-guide");
	for (const [path, name] of [[primary, "primary-guide"], [decoy, "origin-decoy"], [secondary, "secondary-guide"]] as const) {
		await mkdir(path, { recursive: true });
		await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n# ${name}\nFixture guidance.\n`);
	}
	for (const repo of [f.repo, other]) {
		await promisify(execFile)("git", ["-C", repo, "add", "--", "."]);
		await promisify(execFile)("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
	}
	const parentSkills = loadSkills({ cwd: f.repo, agentDir: join(f.base, "agent"), includeDefaults: false, skillPaths: [primary] }).skills
		.map(skill => ({ ...skill, sourceInfo: { ...skill.sourceInfo, scope: "project" as const } }));
	let captured: Parameters<typeof runChild>[0] | undefined;
	const service = new ContinuationService({ ...f.dependencies, getParentSkills: () => parentSkills, runChild: async options => { captured = options; return f.dependencies.runChild(options); } });
	const result = await service.execute({ action: "create", requestId: "tworootcatalog", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", access: [{ permission: "write", scope: [f.repo, other] }] }] }, f.ctx);
	assert.equal(result.status, "succeeded", JSON.stringify(result.error ?? result.sessions[0]?.result?.error ?? result));
	assert.ok(captured);
	const skillPaths = captured.preparedGuidance?.skillPaths ?? [];
	assert.ok(skillPaths.some(path => path.includes("primary-guide")), `captured primary catalog missing: ${JSON.stringify(skillPaths)}`);
	assert.ok(skillPaths.some(path => path.includes("secondary-guide")), `secondary catalog missing: ${JSON.stringify(skillPaths)}`);
	assert.ok(skillPaths.every(path => !path.includes("origin-decoy")), `origin catalog leaked: ${JSON.stringify(skillPaths)}`);
});
