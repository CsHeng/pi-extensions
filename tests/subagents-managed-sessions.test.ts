import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fingerprint, ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { collectNativeObservation } from "../extensions/subagents/observability.ts";
import { MANAGED_LIMITS } from "../extensions/subagents/session-contracts.ts";

async function setup(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "managed-session-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const owner = { repo: base, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
	const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", scope: ["."], writePaths: ["file"] }] });
	assert.equal(graph.ok, true); if (!graph.ok) throw new Error("fixture");
	const store = new ManagedSessionStore(base);
	return { base, owner, tasks: graph.tasks, store };
}

test("hard workspace and parsing bounds remain independent of global estimates", () => {
	assert.equal(MANAGED_LIMITS.maxWorkspaceBytes, 8 * 1024 ** 3);
	assert.equal(MANAGED_LIMITS.maxEntries, 100_000);
	assert.equal(MANAGED_LIMITS.maxSessions, 10);
	assert.equal(MANAGED_LIMITS.maxNativeBytes, 32 * 1024 ** 2);
	assert.equal(MANAGED_LIMITS.maxRegistryBytes, 2 * 1024 ** 2);
	assert.equal(MANAGED_LIMITS.maxCandidateBytes, 64 * 1024 ** 2);
});

test("required source above the previous root byte cap is admitted without deletion", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const record = (await store.allocate(owner, "request", tasks)).records[0]!;
	const registry = await readFile(join(store.path(record.handle), "registry.json"));
	const padding = join(store.path(record.handle), "required-source");
	await writeFile(padding, "");
	await truncate(padding, 600 * 1024 ** 2); // Sparse metadata fixture, not a 600 MiB allocation.
	assert.equal((await lstat(padding)).size, 600 * 1024 ** 2);
	assert.deepEqual(await readFile(join(store.path(record.handle), "registry.json")), registry);
});

test("above-threshold storage warns without blocking allocation or deleting any evidence", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const record = (await store.allocate(owner, "request", tasks)).records[0]!;
	const native = join(store.path(record.handle), "native.jsonl"); const registry = join(store.path(record.handle), "registry.json");
	const original = await readFile(registry);
	const padding = join(store.root, "required-padding"); await writeFile(padding, "");
	await truncate(padding, MANAGED_LIMITS.maxWorkspaceBytes + 1); // Sparse file; no 8 GiB allocation.
	const value = collectNativeObservation("", { startLeaf: null, endLeaf: null, launched: false });
	assert.equal((await store.saveObservation(record.handle, 1, value)).available, true);
	const observation = join(store.path(record.handle), "observation_1.json");
	const observed = await readFile(observation);
	assert.equal((await store.allocate(owner, "another", tasks)).fresh, true);
	await store.completeBatch(owner, "request", { schemaVersion: 2, action: "create", status: "succeeded", sessions: [store.view(record)] });
	assert.deepEqual(await readFile(observation), observed);
	assert.deepEqual(await readFile(registry), original);
	assert.equal((await readFile(native)).length, 0);
	assert.equal((await lstat(padding)).size, MANAGED_LIMITS.maxWorkspaceBytes + 1);
});

test("concurrent writes and subtree removal do not turn advisory scans into errors", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const record = (await store.allocate(owner, "request", tasks)).records[0]!;
	const directory = store.path(record.handle);
	const scratch = join(directory, "scratch");
	const write = store.write.bind(store);
	// Best-effort stress coverage, not an exact-size or deterministic interleaving oracle.
	const peer = (async () => {
		for (let round = 0; round < 20; round++) {
			await write(join(directory, "peer.json"), { round, pad: "x".repeat(2_000) });
			await mkdir(scratch, { recursive: true });
			await writeFile(join(scratch, "file"), "x");
			await rm(scratch, { recursive: true, force: true });
		}
	})();
	const settled = await Promise.allSettled([peer]);
	assert.ok(settled.every((result) => result.status === "fulfilled"));
});

test("native validation classifies malformed history without exposing its contents", async (t) => {
 const { store, owner, tasks } = await setup(t);
 const record = (await store.allocate(owner, "invalid-native", tasks)).records[0]!;
 await writeFile(join(store.path(record.handle), "native.jsonl"), "{invalid secret payload}\n");
 await assert.rejects(store.nativeRevision(record.handle), (error: unknown) => error instanceof Error && "code" in error && error.code === "managed_native_invalid" && "detail" in error && error.detail === "parse" && !error.message.includes("secret"));
});

test("managed allocation is idempotent and rejects request or parent-branch drift", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const first = await store.allocate(owner, "request", tasks);
	const second = await store.allocate(owner, "request", tasks);
	assert.equal(first.fresh, true); assert.equal(second.fresh, false);
	assert.equal(first.records[0]?.handle, second.records[0]?.handle);
	await assert.rejects(store.allocate(owner, "request", [{ ...tasks[0]!, objective: "different" }]), /request_id_conflict/);
	const handle = first.records[0]!.handle;
	await assert.rejects(store.load(handle, { ...owner, parentSessionId: "fork" }), /owner_mismatch/);
	await assert.rejects(store.load(handle, { ...owner, anchor: "other", branch: ["other"] }), /owner_mismatch/);
	assert.equal((await store.list(owner)).length, 1);
	assert.deepEqual(await store.nativeRevision(handle), { sessionId: null, leaf: null });
});

test("dotted task result ids stay readable and falsy replay files never create duplicate sessions", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const dottedTasks = [{ ...tasks[0]!, id: "review.store" }];
	const record = (await store.allocate(owner, "request", dottedTasks)).records[0]!;
	record.result = { id: "review.store", role: "worker", status: "succeeded", output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable", reportComplete: true };
	await store.save(record);
	assert.equal((await store.load(record.handle, owner)).result?.id, "review.store");
	const file = join(store.root, `request_${fingerprint([owner.repo, owner.parentSessionId, "request"])}.json`);
	for (const value of [null, false, 0, ""]) {
		await writeFile(file, JSON.stringify(value));
		await assert.rejects(store.allocate(owner, "request", dottedTasks), /registry_invalid/);
		assert.equal((await store.list(owner)).length, 1);
	}
});

test("registry lock spans the mutation and unknown stale writers are not reclaimed", async (t) => {
	const { store, base, owner, tasks } = await setup(t);
	const handle = (await store.allocate(owner, "request", tasks)).records[0]!.handle;
	const peer = new ManagedSessionStore(base);
	await store.withSession(handle, owner, async (record) => {
		await assert.rejects(peer.withSession(handle, owner, async () => {}), /writer_busy_or_unknown/);
		const module = new URL("../extensions/subagents/managed-sessions.ts", import.meta.url).href;
		const script = `import { ManagedSessionStore } from ${JSON.stringify(module)}; const store = new ManagedSessionStore(process.argv[1]); try { await store.withSession(process.argv[2], JSON.parse(process.argv[3]), async () => {}); process.exitCode = 1; } catch (error) { console.log(error.code); }`;
		const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, base, handle, JSON.stringify(owner)], { timeout: 10_000, env: { PATH: process.env.PATH, HOME: base, PI_OFFLINE: "1" } });
		assert.match(result.stdout, /managed_writer_busy_or_unknown/);
		record.state = "interrupted"; await store.save(record);
	});
	assert.equal((await peer.load(handle, owner)).state, "interrupted");
	await writeFile(join(store.path(handle), ".writer-lock"), "unknown", { mode: 0o600 });
	await assert.rejects(store.withSession(handle, owner, async () => {}), /writer_busy_or_unknown/);
	assert.equal(await readFile(join(store.path(handle), ".writer-lock"), "utf8"), "unknown");
});

test("retained sessions count across sibling branches and corrupted replay identities fail closed", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const allocated = await store.allocate(owner, "batch", Array.from({ length: 10 }, (_, index) => ({ ...tasks[0]!, id: `task-${index}` })));
	await assert.rejects(store.allocate({ ...owner, anchor: "sibling", branch: ["sibling"] }, "another", tasks), /session_limit/);
	const file = join(store.root, `request_${fingerprint([owner.repo, owner.parentSessionId, "batch"])}.json`);
	const request = JSON.parse(await readFile(file, "utf8"));
	await writeFile(file, JSON.stringify({ ...request, handles: [] }));
	await assert.rejects(store.allocate(owner, "batch", Array.from({ length: 10 }, (_, index) => ({ ...tasks[0]!, id: `task-${index}` }))), /registry_invalid/);
	const record = allocated.records[0]!;
	(record as any).candidate = { id: "candidate", episode: 1, status: "unrecognized", changedPaths: ["file"], appliedPaths: [] };
	await store.save(record);
	await assert.rejects(store.load(record.handle, owner), /registry_invalid/);
});

test("closing frees a logical slot without deleting retained native evidence", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const records = (await store.allocate(owner, "full", Array.from({ length: MANAGED_LIMITS.maxSessions }, (_, index) => ({ ...tasks[0]!, id: `task-${index}` })))).records;
	await assert.rejects(store.allocate(owner, "overflow", tasks), /session_limit/);
	const record = records[0]!; record.state = "closed"; record.retained = true;
	await store.save(record);
	assert.equal((await store.allocate(owner, "new", tasks)).fresh, true);
	assert.equal((await store.list(owner)).length, MANAGED_LIMITS.maxSessions);
	assert.equal((await store.load(record.handle, owner)).state, "closed");
	assert.deepEqual(await store.nativeRevision(record.handle), { sessionId: null, leaf: null });
});

test("native inspection is bounded read-only parsing and does not repair a partial tail", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const handle = (await store.allocate(owner, "request", tasks)).records[0]!.handle;
	const file = join(store.path(handle), "native.jsonl");
	const valid = `${JSON.stringify({ type: "session", version: 3, id: "native" })}\n${JSON.stringify({ type: "message", id: "leaf", parentId: null, message: { role: "user", content: "input" } })}\n`;
	await writeFile(file, valid);
	assert.deepEqual(await store.nativeRevision(handle), { sessionId: "native", leaf: "leaf" });
	for (const entry of [{ type: "message", message: { role: "user" } }, { type: "message", id: "next", parentId: "missing", message: { role: "user" } }]) {
		await writeFile(file, `${valid}${JSON.stringify(entry)}\n`);
		await assert.rejects(store.nativeRevision(handle), /native_invalid/);
	}
	await writeFile(file, `${valid}{`);
	await assert.rejects(store.nativeRevision(handle), /incomplete/);
	assert.equal(await readFile(file, "utf8"), `${valid}{`);
});

test("inventory enumerates retained closed, off-branch and legacy history without writing or weakening mutation checks", async (t) => {
	const { store, base, owner, tasks } = await setup(t);
	const outcome = (record: { task: { id: string } }, status: "succeeded" | "failed" | "aborted", reportComplete = false) =>
		({ id: record.task.id, role: "worker" as const, status, output: "done", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" as const, ...(reportComplete ? { reportComplete } : {}) });
	const batchA = (await store.allocate(owner, "batch-a", Array.from({ length: 6 }, (_, index) => ({ ...tasks[0]!, id: `a-${index}` })))).records;
	const closed = batchA[0]!, legacy = batchA[1]!, runner = batchA[2]!, queued = batchA[3]!, idle = batchA[4]!, interrupted = batchA[5]!;
	await store.withSession(closed.handle, owner, async record => { record.state = "closed"; record.retained = true; await store.save(record); });
	await store.withSession(legacy.handle, owner, async record => {
		record.episode = 1; record.state = "closed"; record.retained = true;
		record.requests.push({ id: "legacy-run", fingerprint: fingerprint("legacy"), episode: 1, state: "complete" });
		record.result = outcome(record, "succeeded", true);
		await store.save(record);
	});
	const legacyFile = join(store.path(legacy.handle), "registry.json");
	await writeFile(legacyFile, JSON.stringify({ ...JSON.parse(await readFile(legacyFile, "utf8")), version: 2 }), { mode: 0o600 });
	await store.withSession(runner.handle, owner, async record => {
		record.state = "running"; record.episode = 2;
		record.requests.push({ id: "run-1", fingerprint: fingerprint("one"), episode: 1, state: "complete" }, { id: "run-2", fingerprint: fingerprint("two"), episode: 2, state: "running" });
		record.result = outcome(record, "succeeded", true);
		await store.save(record);
	});
	for (const episode of [1, 2]) assert.equal((await store.saveObservation(runner.handle, episode, collectNativeObservation("", { startLeaf: null, endLeaf: null, launched: false }))).available, true);
	await store.beginFinalization(runner.handle, 2);
	await store.withSession(queued.handle, owner, async record => {
		record.state = "queued"; record.episode = 1;
		record.requests.push({ id: "queue-run", fingerprint: fingerprint("queued"), episode: 1, state: "running" });
		await store.save(record);
	});
	await store.withSession(interrupted.handle, owner, async record => { record.state = "interrupted"; await store.save(record); });
	const batchB = (await store.allocate(owner, "batch-b", Array.from({ length: 4 }, (_, index) => ({ ...tasks[0]!, id: `b-${index}` })))).records;
	const unprovable = batchB[0]!, duplicate = batchB[1]!, failed = batchB[2]!, fresh = batchB[3]!;
	await store.withSession(unprovable.handle, owner, async record => {
		record.episode = 3;
		record.requests.push({ id: "u-1", fingerprint: fingerprint("u1"), episode: 1, state: "complete" }, { id: "u-2", fingerprint: fingerprint("u2"), episode: 2, state: "complete" });
		await store.save(record);
	});
	await store.withSession(duplicate.handle, owner, async record => {
		record.episode = 1;
		record.requests.push({ id: "d-1", fingerprint: fingerprint("d1"), episode: 1, state: "complete" }, { id: "d-2", fingerprint: fingerprint("d2"), episode: 1, state: "complete" });
		await store.save(record);
	});
	await store.withSession(failed.handle, owner, async record => {
		record.episode = 1;
		record.requests.push({ id: "f-1", fingerprint: fingerprint("f1"), episode: 1, state: "complete" });
		record.result = outcome(record, "failed");
		await store.save(record);
	});
	const offOwner = { ...owner, anchor: "feature-x", branch: ["feature-x"] };
	const offBranch = (await store.allocate(offOwner, "batch-off", [{ ...tasks[0]!, id: "off-0" }])).records[0]!;
	await store.withSession(offBranch.handle, offOwner, async record => {
		record.episode = 1;
		record.requests.push({ id: "o-1", fingerprint: fingerprint("o1"), episode: 1, state: "complete" });
		record.result = outcome(record, "aborted", true);
		await store.save(record);
	});
	const foreign = (await store.allocate({ repo: base, parentSessionId: "foreign-parent", anchor: "f", branch: ["f"] }, "foreign", [{ ...tasks[0]!, id: "f-0" }])).records[0]!;
	const otherRepo = (await store.allocate({ repo: join(base, "elsewhere"), parentSessionId: "parent", anchor: "f2", branch: ["f2"] }, "other-repo", [{ ...tasks[0]!, id: "o-0" }])).records[0]!;
	// The active list keeps its exact branch-filtered open-session semantics before any corruption exists.
	const active = (await store.list(owner)).map((view) => view.handle).sort();
	const retained = [closed, legacy, runner, queued, idle, interrupted, unprovable, duplicate, failed, fresh, offBranch].map((record) => record.handle);
	assert.deepEqual(active, retained.filter((handle) => handle !== closed.handle && handle !== legacy.handle && handle !== offBranch.handle).sort());
	await mkdir(join(store.root, "session_corrupt0001"), { mode: 0o700 });
	await writeFile(join(store.root, "session_corrupt0001", "registry.json"), "{corrupt", { mode: 0o600 });
	await mkdir(join(store.root, "session_badmode002"), { mode: 0o700 });
	await writeFile(join(store.root, "session_badmode002", "registry.json"), "{}", { mode: 0o644 });
	await writeFile(join(store.path(fresh.handle), "observation_999.json"), "{}", { mode: 0o600 });
	const walk = async (directory: string, files = new Map<string, { bytes: Buffer; mtimeMs: number }>()) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path, files);
			else if (entry.isFile()) { const info = await lstat(path); files.set(path, { bytes: await readFile(path), mtimeMs: info.mtimeMs }); }
		}
		return files;
	};
	const before = await walk(store.root);
	const inventory = await store.inventory(owner);
	const after = await walk(store.root);
	assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
	for (const [path, value] of before) { assert.deepEqual(after.get(path)?.bytes, value.bytes, path); assert.equal(after.get(path)?.mtimeMs, value.mtimeMs, path); }
	assert.equal(inventory.available, true);
	if (!inventory.available) throw new Error("fixture");
	assert.equal(inventory.complete, false);
	assert.equal(inventory.problems.unreadableRecords, 2);
	assert.equal(inventory.summary.agents, 11);
	const handles = inventory.entries.map((entry) => entry.handle);
	assert.deepEqual(handles, [...handles].sort());
	assert.equal(handles.includes(foreign.handle), false);
	assert.equal(handles.includes(otherRepo.handle), false);
	assert.equal(handles.includes("session_corrupt0001"), false);
	assert.equal(handles.includes("session_badmode002"), false);
	const byHandle = new Map(inventory.entries.map((entry) => [entry.handle, entry]));
	assert.deepEqual(byHandle.get(closed.handle), { handle: closed.handle, role: "worker", route: null, state: "closed", episode: 0, latestOutcome: "unknown", acceptedEpisodes: 0, onCurrentBranch: true, legacy: false, reportComplete: false, retained: true, usageEvidence: { episodes: [] } });
	const legacyView = byHandle.get(legacy.handle)!;
	assert.equal(legacyView.legacy, true); assert.equal(legacyView.state, "closed"); assert.equal(legacyView.acceptedEpisodes, 1); assert.equal(legacyView.latestOutcome, "succeeded"); assert.equal(legacyView.reportComplete, true); assert.equal(legacyView.retained, true);
	const runnerView = byHandle.get(runner.handle)!;
	assert.equal(runnerView.state, "interrupted"); assert.equal(runnerView.latestOutcome, "failed"); assert.equal(runnerView.acceptedEpisodes, 2); assert.deepEqual(runnerView.usageEvidence, { episodes: [1, 2] }); assert.equal(runnerView.reportComplete, true);
	const queuedView = byHandle.get(queued.handle)!;
	assert.equal(queuedView.state, "queued"); assert.equal(queuedView.latestOutcome, "unknown"); assert.equal(queuedView.acceptedEpisodes, 1); assert.equal(queuedView.episode, 1);
	assert.equal(byHandle.get(idle.handle)!.state, "idle"); assert.equal(byHandle.get(idle.handle)!.acceptedEpisodes, 0);
	assert.equal(byHandle.get(interrupted.handle)!.state, "interrupted"); assert.equal(byHandle.get(interrupted.handle)!.acceptedEpisodes, 0);
	assert.equal(byHandle.get(unprovable.handle)!.acceptedEpisodes, null);
	assert.equal(byHandle.get(unprovable.handle)!.episode, 3);
	assert.equal(byHandle.get(duplicate.handle)!.acceptedEpisodes, 1);
	const failedView = byHandle.get(failed.handle)!;
	assert.equal(failedView.latestOutcome, "failed"); assert.equal(failedView.reportComplete, false); assert.equal(failedView.acceptedEpisodes, 1);
	assert.equal(byHandle.get(fresh.handle)!.episode, 0); assert.deepEqual(byHandle.get(fresh.handle)!.usageEvidence, { episodes: [] });
	const offView = byHandle.get(offBranch.handle)!;
	assert.equal(offView.onCurrentBranch, false); assert.equal(offView.latestOutcome, "aborted"); assert.equal(offView.acceptedEpisodes, 1); assert.equal(offView.reportComplete, true);
	assert.equal(inventory.summary.acceptedEpisodes, null);
	assert.deepEqual(inventory.summary.states, { idle: 6, queued: 1, running: 0, interrupted: 2, closed: 2 });
	// The read widening never broadens the mutation predicate.
	await assert.rejects(store.load(offBranch.handle, owner), /owner_mismatch/);
	await assert.rejects(store.load(foreign.handle, owner), /owner_mismatch/);
	await assert.rejects(store.withSession(offBranch.handle, owner, async () => {}), /owner_mismatch/);
	assert.equal((await store.load(legacy.handle, owner)).version, 2);
});

test("inventory treats missing storage as empty and invalid storage as unavailable without creating it", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "managed-inventory-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const owner = { repo: base, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
	const store = new ManagedSessionStore(base);
	assert.deepEqual(await store.inventory(owner), { available: true, entries: [], complete: true, problems: { unreadableRecords: 0 }, summary: { agents: 0, acceptedEpisodes: 0, states: { idle: 0, queued: 0, running: 0, interrupted: 0, closed: 0 } } });
	await assert.rejects(lstat(store.root), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
	const linked = new ManagedSessionStore(join(base, "linked"));
	await mkdir(join(base, "linked"), { mode: 0o700 });
	await mkdir(join(base, "real"), { mode: 0o700 });
	await symlink(join(base, "real"), linked.root);
	assert.deepEqual(await linked.inventory(owner), { available: false, reason: "managed_storage_invalid" });
});
