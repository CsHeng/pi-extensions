import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { MANAGED_LIMITS } from "../extensions/subagents/session-contracts.ts";
import { WorkspaceError } from "../extensions/subagents/workspace.ts";
import { applyCandidate, freezeCandidate, prepareManagedWorkspace, syncManagedInputs } from "../extensions/subagents/candidates.ts";

async function setup(t: test.TestContext, files = ["file"]) {
	const base = await mkdtemp(join(tmpdir(), "managed-candidates-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const repo = join(base, "repo"); await mkdir(repo);
	await promisify(execFile)("git", ["init", "-q", repo]);
	const owner = { repo, parentSessionId: "parent", anchor: "entry", branch: ["entry"] };
	const graph = validateGraphStructure({ tasks: [{ id: "worker", role: "worker", objective: "work", scope: ["."], writePaths: files }] });
	if (!graph.ok) throw new Error("fixture");
	const store = new ManagedSessionStore(base);
	const record = (await store.allocate(owner, "create", graph.tasks)).records[0]!;
	await prepareManagedWorkspace(store, record);
	record.episode = 1;
	record.result = { id: "worker", role: "worker", status: "succeeded", reportComplete: true, output: "done", stderr: "", durationMs: 1, usage: emptyUsage(), changedPaths: [], convergence: "not-applicable" };
	return { repo, owner, store, record, source: join(store.path(record.handle), "source") };
}

test("unapplied continuation stays against B0; full apply advances baseline and repeated apply is inert", async (t) => {
	const { source, repo, store, record } = await setup(t);
	await writeFile(join(source, "file"), "C1");
	const first = await freezeCandidate(store, record); assert.ok(first);
	await syncManagedInputs(store, record);
	record.episode = 2; await writeFile(join(source, "file"), "C2");
	const second = await freezeCandidate(store, record); assert.ok(second);
	assert.equal(record.workspace?.parentBaseline.file?.kind, "absent");
	assert.equal((await applyCandidate(store, record, second.id)).status, "applied");
	assert.equal(await readFile(join(repo, "file"), "utf8"), "C2");
	assert.equal((await applyCandidate(store, record, second.id)).status, "applied");
	await syncManagedInputs(store, record);
	record.episode = 3; await writeFile(join(source, "file"), "C3");
	const third = await freezeCandidate(store, record); assert.ok(third);
	assert.equal((await applyCandidate(store, record, third.id)).status, "applied");
	assert.equal(await readFile(join(repo, "file"), "utf8"), "C3");
});

test("explicit apply creates nested files only on request and preserves mode on later modification", async (t) => {
	const { source, repo, store, record } = await setup(t, ["new/nested/file"]);
	await writeFile(join(source, "new/nested/file"), "first", { mode: 0o640 });
	const first = await freezeCandidate(store, record); assert.ok(first);
	await assert.rejects(lstat(join(repo, "new")), { code: "ENOENT" });
	assert.equal((await applyCandidate(store, record, first.id)).status, "applied");
	assert.equal((await lstat(join(repo, "new/nested/file"))).mode & 0o777, 0o640);
	record.episode++;
	await writeFile(join(source, "new/nested/file"), "second");
	const next = await freezeCandidate(store, record); assert.ok(next);
	assert.equal((await applyCandidate(store, record, next.id)).status, "applied");
	assert.equal(await readFile(join(repo, "new/nested/file"), "utf8"), "second");
	assert.equal((await lstat(join(repo, "new/nested/file"))).mode & 0o777, 0o640);
	await chmod(join(source, "new/nested/file"), 0o600);
	await assert.rejects(freezeCandidate(store, record), /unexpected_worker_change/);
});

for (const ancestor of [false, true]) test(`explicit candidate apply refuses ${ancestor ? "repository ancestor" : "new directory"} symlink replacement`, async (t) => {
	const { source, repo, store, record } = await setup(t, ["new/file"]);
	await writeFile(join(source, "new/file"), "candidate");
	const candidate = await freezeCandidate(store, record); assert.ok(candidate);
	const outside = await mkdtemp(join(tmpdir(), "managed-apply-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	if (ancestor) { await rename(repo, `${repo}-preserved`); await symlink(outside, repo); }
	else await symlink(outside, join(repo, "new"));
	await assert.rejects(applyCandidate(store, record, candidate.id), (error: unknown) => error instanceof WorkspaceError && error.code === "write_symlink");
	await assert.rejects(lstat(join(outside, "file")), { code: "ENOENT" });
	await assert.rejects(lstat(join(outside, "new")), { code: "ENOENT" });
});

test("an unchanged managed source has no candidate; undeclared changes still fail", async (t) => {
	const { source, repo, store, record } = await setup(t);
	assert.equal(await freezeCandidate(store, record), undefined);
	await assert.rejects(lstat(join(repo, "file")), { code: "ENOENT" });
	await writeFile(join(source, "undeclared"), "bad");
	await assert.rejects(freezeCandidate(store, record), /unexpected_worker_change/);
});

test("unknown source changes, stale frozen bytes and parent drift cannot apply", async (t) => {
	const { source, repo, store, record } = await setup(t);
	await writeFile(join(source, "unknown"), "no");
	await assert.rejects(freezeCandidate(store, record), /unexpected_worker_change/);
	await rm(join(source, "unknown")); await writeFile(join(source, "file"), "candidate");
	const candidate = await freezeCandidate(store, record); assert.ok(candidate);
	await writeFile(join(source, "file"), "later");
	await assert.rejects(applyCandidate(store, record, candidate.id), /candidate_changed/);
	await writeFile(join(source, "file"), "candidate"); await writeFile(join(repo, "file"), "parent");
	assert.equal((await applyCandidate(store, record, candidate.id)).status, "conflict");
	assert.equal(await readFile(join(repo, "file"), "utf8"), "parent");
});

test("frozen content cannot be swapped after validation and manifest state must match source", async (t) => {
	const { source, repo, store, record } = await setup(t);
	await writeFile(join(source, "file"), "verified");
	const candidate = await freezeCandidate(store, record); assert.ok(candidate);
	const directory = join(store.path(record.handle), candidate.id);
	const manifestPath = join(directory, "manifest.json");
	const original = await readFile(manifestPath, "utf8");
	const manifest = JSON.parse(original);
	manifest.files[0].state.mode = 0o777;
	await writeFile(manifestPath, JSON.stringify(manifest));
	await assert.rejects(applyCandidate(store, record, candidate.id), /candidate_invalid/);
	await writeFile(manifestPath, original);
	const save = store.save.bind(store);
	store.save = async (value) => {
		await save(value);
		if (value.candidate?.status === "applying") await writeFile(join(directory, "0"), "unchecked replacement");
	};
	assert.equal((await applyCandidate(store, record, candidate.id)).status, "applied");
	assert.equal(await readFile(join(repo, "file"), "utf8"), "verified");
});

test("runtime dependencies stay private, refresh preserves owned edits and frozen environment drift cannot apply", async (t) => {
	const { source, repo, store, record } = await setup(t);
	await writeFile(join(source, "file"), "candidate");
	await mkdir(join(source, "node_modules/pkg"), { recursive: true }); await writeFile(join(source, "node_modules/pkg/index.js"), "local dependency");
	const candidate = await freezeCandidate(store, record); assert.ok(candidate); assert.deepEqual(candidate.changedPaths, ["file"]);
	await writeFile(join(source, "node_modules/pkg/index.js"), "changed environment");
	await assert.rejects(applyCandidate(store, record, candidate.id), /candidate_changed/);
	await writeFile(join(repo, ".gitignore"), "node_modules/\n");
	await mkdir(join(repo, "node_modules/pkg"), { recursive: true }); await writeFile(join(repo, "node_modules/pkg/index.js"), "parent dependency");
	await syncManagedInputs(store, record);
	assert.equal(await readFile(join(source, "file"), "utf8"), "candidate");
	assert.equal(await readFile(join(source, "node_modules/pkg/index.js"), "utf8"), "parent dependency");
	const refreshed = await freezeCandidate(store, record); assert.ok(refreshed);
	assert.equal((await applyCandidate(store, record, refreshed.id)).status, "applied");
	assert.equal(await readFile(join(repo, "node_modules/pkg/index.js"), "utf8"), "parent dependency");
});

test("non-owned file/directory/link input transitions preserve owned edits and directory mode mutations are rejected", async (t) => {
	const { source, repo, store, record } = await setup(t);
	await writeFile(join(source, "file"), "owned"); await writeFile(join(repo, "input"), "first");
	await syncManagedInputs(store, record);
	await rm(join(repo, "input")); await mkdir(join(repo, "input")); await writeFile(join(repo, "input/nested"), "second");
	await syncManagedInputs(store, record);
	assert.equal(await readFile(join(source, "input/nested"), "utf8"), "second");
	await chmod(join(source, "input"), 0o755);
	await assert.rejects(freezeCandidate(store, record), /unexpected_worker_change/);
	await chmod(join(source, "input"), record.workspace!.baseline.input!.mode!);
	await rm(join(repo, "input"), { recursive: true }); await writeFile(join(repo, "target"), "third"); await symlink("target", join(repo, "input"));
	await syncManagedInputs(store, record);
	assert.equal(await readFile(join(source, "input"), "utf8"), "third");
	await rm(join(repo, "input")); await writeFile(join(repo, "input"), "fourth"); await syncManagedInputs(store, record);
	assert.equal(await readFile(join(source, "input"), "utf8"), "fourth"); assert.equal(await readFile(join(source, "file"), "utf8"), "owned");
});

test("candidate byte admission happens before creating an oversized frozen artifact", async (t) => {
	const { source, store, record } = await setup(t);
	await writeFile(join(source, "file"), ""); await truncate(join(source, "file"), MANAGED_LIMITS.maxCandidateBytes + 1);
	await assert.rejects(freezeCandidate(store, record), /candidate_limit/);
	assert.equal((await readdir(store.path(record.handle))).some((name) => name.startsWith("candidate_")), false);
});

test("managed source rejects an undeclared FIFO rather than treating it as absent", async (t) => {
	const { source, store, record } = await setup(t);
	await writeFile(join(source, "file"), "candidate");
	await promisify(execFile)("mkfifo", [join(source, "unknown-pipe")]);
	await assert.rejects(freezeCandidate(store, record), /unsupported filesystem/);
});

test("interrupted multi-file apply retains exact prefix and does not advance the complete baseline", async (t) => {
	const { source, repo, store, record, owner } = await setup(t, ["a", "b"]);
	await writeFile(join(source, "a"), "A"); await writeFile(join(source, "b"), "B");
	const candidate = await freezeCandidate(store, record); assert.ok(candidate);
	const save = store.save.bind(store);
	store.save = async (value) => {
		await save(value);
		if (value.candidate?.status === "applying" && value.candidate.appliedPaths.length === 1) await mkdir(join(repo, "b"));
	};
	await assert.rejects(applyCandidate(store, record, candidate.id));
	const persisted = await store.load(record.handle, owner);
	assert.equal(persisted.candidate?.status, "partial");
	assert.deepEqual(persisted.candidate?.appliedPaths, ["a"]);
	assert.equal(persisted.workspace?.parentBaseline.a?.kind, "absent");
	assert.equal(await readFile(join(repo, "a"), "utf8"), "A");
	await assert.rejects(applyCandidate(store, persisted, candidate.id), /recovery_required/);
});
