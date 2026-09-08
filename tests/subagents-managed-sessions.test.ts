import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fingerprint, ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { validateGraph } from "../extensions/subagents/graph.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { collectNativeObservation } from "../extensions/subagents/observability.ts";
import { MANAGED_LIMITS } from "../extensions/subagents/session-contracts.ts";

async function setup(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "managed-session-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const owner = { repo: base, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
	const graph = validateGraph({ tasks: [{ id: "worker", role: "worker", objective: "work", scope: ["."], writePaths: ["file"] }] });
	assert.equal(graph.ok, true); if (!graph.ok) throw new Error("fixture");
	const store = new ManagedSessionStore(base);
	return { base, owner, tasks: graph.tasks, store };
}

async function retainedBytes(directory: string): Promise<number> {
	let bytes = 0;
	for (const name of await readdir(directory)) {
		const file = join(directory, name); const info = await lstat(file); bytes += info.size;
		if (info.isDirectory()) bytes += await retainedBytes(file);
	}
	return bytes;
}

test("required admission reclaims only disposable observations instead of failing another episode", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const record = (await store.allocate(owner, "request", tasks)).records[0]!;
	const native = join(store.path(record.handle), "native.jsonl"); const registry = join(store.path(record.handle), "registry.json");
	const original = await readFile(registry);
	const source = join(store.path(record.handle), "source"); await mkdir(source);
	await writeFile(join(source, "observation_1.json"), "protected source");
	const value = collectNativeObservation("", { startLeaf: null, endLeaf: null, launched: false });
	assert.equal((await store.saveObservation(record.handle, 1, value)).available, true);
	const observation = join(store.path(record.handle), "observation_1.json");
	const padding = join(store.root, "required-padding"); await writeFile(padding, "");
	await truncate(padding, MANAGED_LIMITS.maxStoreBytes - await retainedBytes(store.root) - 64);
	await store.checkCapacity();
	await store.checkCapacity(0, 128);
	await assert.rejects(readFile(observation), { code: "ENOENT" });
	await writeFile(join(store.root, "later-required-data"), "x".repeat(128)); await store.checkCapacity();
	assert.equal(await readFile(join(source, "observation_1.json"), "utf8"), "protected source");
	assert.deepEqual(await readFile(registry), original); assert.equal((await readFile(native)).length, 0);
	assert.ok(await retainedBytes(store.root) <= MANAGED_LIMITS.maxStoreBytes);
	await assert.rejects(store.checkCapacity(0, MANAGED_LIMITS.maxStoreBytes), /managed_storage_limit/);
});

test("optional postflight yields to concurrent required growth", async (t) => {
	const { store, owner, tasks } = await setup(t);
	const record = (await store.allocate(owner, "request", tasks)).records[0]!;
	const padding = join(store.root, "required-padding"); await writeFile(padding, "");
	await truncate(padding, MANAGED_LIMITS.maxStoreBytes - await retainedBytes(store.root) - 1000);
	const write = store.write.bind(store);
	store.write = async (file, value) => {
		if (file.endsWith("observation_1.json")) await writeFile(join(store.root, "later-required-data"), "x".repeat(900));
		await write(file, value);
	};
	const observed = await store.saveObservation(record.handle, 1, collectNativeObservation("", { startLeaf: null, endLeaf: null, launched: false }));
	assert.equal(observed.available, false); assert.equal(observed.usage.cost, null);
	await store.checkCapacity(); assert.ok(await retainedBytes(store.root) <= MANAGED_LIMITS.maxStoreBytes);
	assert.equal((await readFile(join(store.root, "later-required-data"))).length, 900);
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
