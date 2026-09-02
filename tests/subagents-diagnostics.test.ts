import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, open, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HARD_LIMITS } from "../extensions/subagents/contracts.ts";
import { DiagnosticError, DiagnosticStore, renderDiagnosticInspection, safeSegment } from "../extensions/subagents/diagnostics.ts";

async function fixture(t: test.TestContext) {
	const agentDir = await mkdtemp(join(tmpdir(), "subagent-diagnostics-"));
	await chmod(agentDir, 0o700);
	t.after(async () => rm(agentDir, { recursive: true, force: true }));
	return { agentDir, store: new DiagnosticStore(agentDir) };
}

test("read-only discovery does not create an absent diagnostic root", async (t) => {
	const { store } = await fixture(t);
	assert.deepEqual(await store.discover(), []);
	await assert.rejects(lstat(store.root), /ENOENT/);
	await assert.rejects(store.inspect("parent/run/task.jsonl"), /does not exist/);
	await assert.rejects(lstat(store.root), /ENOENT/);
});

test("allocates private parent/run/task hierarchy with safe references", async (t) => {
	const { store } = await fixture(t);
	const run = await store.allocateRun("parent/session", "run-1");
	const task = await run.createTask("scan");
	assert.match(run.parentSegment, /^id-[a-f0-9]{32}$/);
	assert.equal(task.ref, `subagent-sessions/${run.parentSegment}/run-1/scan.jsonl`);
	assert.equal((await lstat(store.root)).mode & 0o077, 0);
	assert.equal((await lstat(run.path)).mode & 0o077, 0);
	assert.equal((await lstat(task.path)).mode & 0o077, 0);
	await assert.rejects(run.createTask("scan"), (error: unknown) => error instanceof DiagnosticError && error.code === "diagnostic_session_unavailable");
	assert.equal(await readFile(task.path, "utf8"), "");
	await run.settle();
});

test("active and stale-active runs reserve the total-root ceiling", async (t) => {
	const { store } = await fixture(t);
	const first = await store.allocateRun("parent", "one");
	const second = await store.allocateRun("parent", "two");
	await assert.rejects(store.allocateRun("parent", "three"), (error: unknown) => error instanceof DiagnosticError && error.code === "diagnostic_storage_unavailable");
	await first.settle();
	const third = await store.allocateRun("parent", "three");
	const discovered = await store.discover();
	assert.ok(discovered.some((scope) => scope.ref.endsWith("/two") && scope.staleActive));
	assert.ok(discovered.length <= HARD_LIMITS.maxDiagnosticScopes);
	await second.settle();
	await third.settle();
});

test("unsafe existing root and symlink ancestors fail closed", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "subagent-diagnostics-unsafe-"));
	t.after(async () => rm(agentDir, { recursive: true, force: true }));
	const root = join(agentDir, "subagent-sessions");
	await mkdir(root, { mode: 0o755 });
	const store = new DiagnosticStore(agentDir);
	await assert.rejects(store.allocateRun("parent", "run"), /permissions are not private/);
	await rm(root, { recursive: true });
	const target = await mkdtemp(join(tmpdir(), "subagent-diagnostics-target-"));
	t.after(async () => rm(target, { recursive: true, force: true }));
	await symlink(target, root);
	await assert.rejects(store.allocateRun("parent", "run"), /not a private directory/);
});

test("retention prunes expired then oldest settled runs without touching active runs", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "subagent-diagnostics-retention-"));
	await chmod(agentDir, 0o700);
	t.after(async () => rm(agentDir, { recursive: true, force: true }));
	let now = Date.now();
	const store = new DiagnosticStore(agentDir, { now: () => now });

	const expired = await store.allocateRun("parent", "expired");
	const expiredTask = await expired.createTask("task");
	await expired.settle();
	const oldSeconds = (now - HARD_LIMITS.diagnosticRetentionMs - 1_000) / 1_000;
	await utimes(expiredTask.path, oldSeconds, oldSeconds);
	await utimes(expired.path, oldSeconds, oldSeconds);
	const active = await store.allocateRun("parent", "active");
	await assert.rejects(lstat(expired.path), /ENOENT/);
	await lstat(active.path);
	await active.settle();

	const oldest = await store.allocateRun("parent", "oldest");
	const oldestTask = await oldest.createTask("task");
	let handle = await open(oldestTask.path, "r+");
	await handle.truncate(200 * 1024 * 1024);
	await handle.close();
	await oldest.settle();
	now += 1_000;
	const newer = await store.allocateRun("parent", "newer");
	const newerTask = await newer.createTask("task");
	handle = await open(newerTask.path, "r+");
	await handle.truncate(200 * 1024 * 1024);
	await handle.close();
	await newer.settle();
	const admitted = await store.allocateRun("parent", "admitted");
	await assert.rejects(lstat(oldest.path), /ENOENT/);
	await lstat(newer.path);
	await admitted.settle();
});

test("limit checks never truncate retained bytes", async (t) => {
	const { store } = await fixture(t);
	const run = await store.allocateRun("parent", "run");
	const task = await run.createTask("large");
	const handle = await open(task.path, "r+");
	await handle.truncate(HARD_LIMITS.diagnosticChildBytes + 1);
	await handle.close();
	assert.deepEqual(await run.checkLimits(task.path), { ok: false, code: "diagnostic_session_limit", scope: "child" });
	assert.equal((await lstat(task.path)).size, HARD_LIMITS.diagnosticChildBytes + 1);
	await run.settle();
});

test("inspector streams metadata only and leaves session bytes unchanged", async (t) => {
	const { store } = await fixture(t);
	const run = await store.allocateRun("parent", "run");
	const task = await run.createTask("scan");
	const secret = "SENSITIVE-PROMPT-AND-RESULT";
	const bytes = [
		JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/secret/path" }),
		JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: secret } }),
		JSON.stringify({ type: "message", id: "2", parentId: "1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: secret } }], stopReason: "toolUse", model: secret } }),
		JSON.stringify({ type: "message", id: "3", parentId: "2", timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolName: "read", content: secret, isError: false } }),
		JSON.stringify({ type: "message", id: "4", parentId: "3", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: secret }], stopReason: "stop", model: secret } }),
	].join("\n") + "\n";
	await writeFile(task.path, bytes, { mode: 0o600 });
	const before = await readFile(task.path);
	const inspection = await store.inspect(task.ref);
	const rendered = renderDiagnosticInspection(inspection);
	assert.equal(inspection.transcriptComplete, true);
	assert.deepEqual(inspection.entries.map((entry) => entry.role).filter(Boolean), ["user", "assistant", "toolResult", "assistant"]);
	assert.deepEqual(inspection.entries[3]?.toolResultError, false);
	assert.deepEqual(inspection.entries[3]?.toolNames, ["read"]);
	assert.match(rendered, /tools=read/);
	assert.doesNotMatch(JSON.stringify(inspection.entries), new RegExp(secret));
	assert.doesNotMatch(rendered, new RegExp(secret));
	assert.ok(Buffer.byteLength(rendered, "utf8") <= HARD_LIMITS.maxDiagnosticRenderBytes);
	assert.deepEqual(await readFile(task.path), before);

	const invalidTranscripts = [
		`${JSON.stringify({ type: "session", version: 3 })}\n{malformed}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "stop" } })}\n`,
		`${JSON.stringify({ type: "session", version: 3 })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
		`${JSON.stringify({ type: "session", version: 3 })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "pending" } })}\n`,
		`${JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "stop" } })}\n`,
	];
	for (const invalid of invalidTranscripts) {
		await writeFile(task.path, invalid, { mode: 0o600 });
		assert.equal((await store.inspect(task.ref)).transcriptComplete, false);
	}
	await run.settle();
});

test("discovery and timeline enforce exact item bounds", async (t) => {
	const { store } = await fixture(t);
	let latestTaskRef = "";
	for (let index = 0; index < HARD_LIMITS.maxDiagnosticScopes + 3; index += 1) {
		const run = await store.allocateRun("parent", `run-${index}`);
		const task = await run.createTask("scan");
		latestTaskRef = task.ref;
		if (index === HARD_LIMITS.maxDiagnosticScopes + 2) {
			const lines = [JSON.stringify({ type: "session", version: 3 })];
			for (let entry = 0; entry < HARD_LIMITS.maxDiagnosticTimelineEntries + 5; entry += 1) {
				lines.push(JSON.stringify({ type: "message", timestamp: String(entry), message: { role: "assistant", content: [], stopReason: "stop" } }));
			}
			await writeFile(task.path, `${lines.join("\n")}\n`, { mode: 0o600 });
		}
		await run.settle();
	}
	assert.equal((await store.discover()).length, HARD_LIMITS.maxDiagnosticScopes);
	const inspection = await store.inspect(latestTaskRef);
	assert.equal(inspection.entries.length, HARD_LIMITS.maxDiagnosticTimelineEntries);
	assert.equal(inspection.truncated, true);
	assert.equal(inspection.transcriptComplete, false);
});

test("inspection rejects symlinked parent and run ancestors", async (t) => {
	const { agentDir, store } = await fixture(t);
	await mkdir(store.root, { mode: 0o700 });
	const externalParent = join(agentDir, "external-parent");
	const externalRun = join(externalParent, "run");
	await mkdir(externalRun, { recursive: true, mode: 0o700 });
	await chmod(externalParent, 0o700);
	await chmod(externalRun, 0o700);
	await writeFile(join(externalRun, "task.jsonl"), `${JSON.stringify({ type: "session", version: 3 })}\n`, { mode: 0o600 });
	await symlink(externalParent, join(store.root, "parent"));
	await assert.rejects(store.inspect("parent/run/task.jsonl"), /not a private directory/);
});

test("unsafe inspection references and oversized lines are rejected", async (t) => {
	const { store } = await fixture(t);
	await assert.rejects(store.inspect("../outside/run/task.jsonl"), /invalid/);
	const run = await store.allocateRun("parent", "run");
	const task = await run.createTask("scan");
	await writeFile(task.path, JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(HARD_LIMITS.maxDiagnosticLineBytes) } }), { mode: 0o600 });
	await assert.rejects(store.inspect(task.ref), /line exceeds/);
	await rm(task.path);
	const replacement = join(store.agentDir, "replacement.jsonl");
	await writeFile(replacement, "{}\n", { mode: 0o600 });
	await symlink(replacement, task.path);
	await assert.rejects(store.inspect(task.ref), /cannot be inspected/);
	await rm(task.path);
	await writeFile(task.path, "{}\n", { mode: 0o600 });
	await run.settle();
	assert.equal(safeSegment("safe-id"), "safe-id");
	assert.notEqual(safeSegment("../unsafe"), "../unsafe");
});
