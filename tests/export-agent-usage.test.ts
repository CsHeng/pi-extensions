import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../scripts/export-agent-usage.ts", import.meta.url));
const timestamp = "2026-11-11T04:15:32.001Z";
const later = "2026-11-11T04:16:00.000Z";
const childId = "019ababc-1234-7000-8000-000000000001";
const otherId = "019ababc-1234-7000-8000-000000000002";
const thirdId = "019ababc-1234-7000-8000-000000000003";
const parentSessionId = "019ababc-1234-7000-8000-000000000004";
const ownerRepo = "/home/fixture/team:tools/repo";
const project = "--home-fixture-team-tools-repo--";
const filename = (id: string) => `2026-11-11T04-15-32-001Z_${id}.jsonl`;
const recorded = { input: 9, output: 2, cacheRead: 50, cacheWrite: 3, cacheWrite1h: 1, reasoning: 1, totalTokens: 64,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.04, total: 0.35, totalFromProvider: true } };
const jsonl = (rows: object[]) => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
const header = (id: string) => ({ type: "session", version: 3, id, timestamp, cwd: "/sensitive/worker/checkout", parentSession: "/private/path/SYNTHETIC_SECRET" });
const assistant = (id: string, parentId: string | null = null, usage: unknown = recorded) => ({
	type: "message", id, parentId, timestamp: later,
	message: { role: "assistant", content: [{ type: "thinking", thinking: "SYNTHETIC_SECRET" }], provider: "synthetic", model: "example/model",
		responseModel: "example/model-actual", timestamp: Date.parse(later), usage, errorMessage: "SYNTHETIC_SECRET", api: "SYNTHETIC_SECRET", stopReason: "stop" },
});

async function fixture(t: test.TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-extensions-export-agent-usage-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const sessions = join(agentDir, "sessions");
	return {
		root, agentDir, sessions,
		target: (id: string) => join(sessions, project, "agents", filename(id)),
		async source({ handle, id = childId, entries = [assistant("abcd1001")], source = "managed-agents", repo = ownerRepo,
			parent = parentSessionId, version = source === "managed-agents" ? 4 : 1, binding }: {
			handle: string; id?: string; entries?: object[]; source?: string; repo?: string; parent?: string; version?: number; binding?: object;
		}) {
			const dir = join(agentDir, source, handle);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "registry.json"), JSON.stringify({ version, handle, owner: { repo, parentSessionId: parent }, native: binding, result: { privateSettings: "SYNTHETIC_SECRET" } }));
			const native = join(dir, "native.jsonl");
			const bytes = jsonl([header(id), ...entries]);
			await writeFile(native, bytes);
			return { dir, native, bytes };
		},
		run(write = false, directory = agentDir) {
			const proc = spawnSync(process.execPath, [cli, "--agent-dir", directory, ...(write ? ["--write"] : [])], {
				encoding: "utf8", env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "should-not-be-used") }, timeout: 10_000,
			});
			assert.ifError(proc.error);
			assert.equal(proc.stderr, "");
			assert.doesNotMatch(proc.stdout, /SYNTHETIC_SECRET|sensitive\/worker|fixture\/team|019ababc/);
			return { status: proc.status, report: JSON.parse(proc.stdout) };
		},
	};
}

async function put(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

test("legacy usage CLI defaults to dry-run, uses Pi project/timestamp names and emits only allowed native usage facts", async t => {
	const f = await fixture(t);
	const user = { type: "message", id: "abcd1000", parentId: null, timestamp, message: { role: "user", content: "SYNTHETIC_SECRET" } };
	const output = { type: "message", id: "abcd1002", parentId: "abcd1001", timestamp: later,
		message: { role: "toolResult", content: "SYNTHETIC_SECRET", usage: { input: 900 } } };
	const a = assistant("abcd1001", user.id, { ...recorded, privatePrompt: "SYNTHETIC_SECRET", cost: { ...recorded.cost, apiKey: "SYNTHETIC_SECRET" } });
	const b = assistant("abcd1003", output.id);
	const first = await f.source({ handle: "currentPrivate", entries: [user, a, output, b] });
	const oldest = await f.source({ handle: `session_${thirdId}`, source: "subagent-managed-sessions", version: 3, id: otherId, entries: [assistant("abcd2000")] });

	const dry = f.run();
	assert.equal(dry.status, 0);
	assert.equal(dry.report.mode, "dry-run");
	assert.equal(dry.report.readyFiles, 2);
	assert.equal(dry.report.readyRows, 3);
	assert.equal(dry.report.writtenFiles, 0);
	assert.deepEqual((await readdir(f.agentDir)).sort(), ["managed-agents", "subagent-managed-sessions"]);

	const written = f.run(true);
	assert.equal(written.status, 0);
	assert.equal(written.report.writtenFiles, 2);
	assert.equal(written.report.writtenRows, 3);
	const path = f.target(childId);
	const expectedHeader = { type: "session", version: 3, id: childId, timestamp, cwd: ".", parentSessionId };
	const expectedMessage = { role: "assistant", content: [], provider: "synthetic", model: "example/model", responseModel: "example/model-actual", timestamp: Date.parse(later), usage: recorded };
	const expected = jsonl([
		expectedHeader,
		{ type: "message", id: `${childId}_abcd1001`, nativeEntryId: "abcd1001", parentId: null, timestamp: later, message: expectedMessage },
		{ type: "message", id: `${childId}_abcd1003`, nativeEntryId: "abcd1003", parentId: `${childId}_abcd1001`, timestamp: later, message: expectedMessage },
	]);
	assert.equal(await readFile(path, "utf8"), expected);
	assert.equal(await readFile(f.target(otherId), "utf8"), jsonl([
		{ ...expectedHeader, id: otherId }, { type: "message", id: `${otherId}_abcd2000`, nativeEntryId: "abcd2000", parentId: null, timestamp: later, message: expectedMessage },
	]));
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal(await readFile(first.native, "utf8"), first.bytes);
	assert.equal(await readFile(oldest.native, "utf8"), oldest.bytes);
	const inode = (await stat(path)).ino;
	const rerun = f.run(true);
	assert.equal(rerun.status, 0);
	assert.equal(rerun.report.identicalFiles, 2);
	assert.equal(rerun.report.writtenFiles, 0);
	assert.equal((await stat(path)).ino, inode);
	assert.equal(await readFile(path, "utf8"), expected);
	assert.deepEqual((await readdir(dirname(path))).sort(), [filename(childId), filename(otherId)]);
});

test("independent requests with the same short native ID stay distinct even for a source-wide deduplicating consumer", async t => {
	const f = await fixture(t);
	await f.source({ handle: "one" });
	const entry = { ...assistant("abcd1001"), timestamp: "2026-11-12T04:16:00.000Z" };
	await f.source({ handle: "two", id: otherId, entries: [entry] });
	const result = f.run(true);
	assert.equal(result.status, 0); assert.equal(result.report.writtenRows, 2);
	const rows = await Promise.all([childId, otherId].map(async id => JSON.parse((await readFile(f.target(id), "utf8")).split("\n")[1]!)));
	assert.equal(new Set(rows.map(row => row.id)).size, 2); assert.ok(rows.every(row => row.nativeEntryId === "abcd1001"));
	await rm(f.target(otherId));
	await put(join(f.sessions, "--forked--", "copy.jsonl"), jsonl([header(thirdId), rows[1]]));
	const again = f.run(true);
	assert.equal(again.report.identicalFiles, 1); assert.equal(again.report.existingSessions, 1); assert.equal(again.report.writtenFiles, 0);
});

test("an original session elsewhere and an empty reserved target cannot acquire a second export", async t => {
	const f = await fixture(t);
	const source = await f.source({ handle: "copy" });
	await f.source({ handle: "reserved", id: otherId, entries: [assistant("abcd2000")] });
	const offPath = join(f.sessions, "--other-project--", "ordinary", "renamed.jsonl");
	await put(offPath, source.bytes);
	await put(f.target(otherId), "");
	const result = f.run(true);
	assert.equal(result.status, 1);
	assert.equal(result.report.existingSessions, 2);
	assert.equal(result.report.emptyDestinationFiles, 1);
	assert.equal(result.report.readyFiles, 0);
	assert.equal(result.report.writtenFiles, 0);
	assert.equal(await readFile(offPath, "utf8"), source.bytes);
	assert.equal(await readFile(f.target(otherId), "utf8"), "");
	await assert.rejects(stat(f.target(childId)), { code: "ENOENT" });
});

test("exact source duplicates collapse, conflicting variants of a UUID are flagged, and forked requests are not counted twice", async t => {
	const f = await fixture(t);
	await f.source({ handle: "sameOne" });
	await f.source({ handle: "sameTwo", source: "subagent-managed-sessions" });
	await f.source({ handle: "conflictOne", id: otherId, entries: [assistant("abcd2000")] });
	await f.source({ handle: "conflictTwo", id: otherId, entries: [assistant("abcd2000", null, { ...recorded, input: 99 })], source: "subagent-managed-sessions" });
	await f.source({ handle: "fork", id: thirdId, entries: [assistant("abcd3000")] });
	await put(join(f.sessions, "--forked-other-project--", "forked.jsonl"), jsonl([header(parentSessionId), assistant("abcd3000")]));
	const result = f.run(true);
	assert.equal(result.status, 1);
	assert.equal(result.report.duplicateSources, 1);
	assert.equal(result.report.conflictingSources, 1);
	assert.equal(result.report.existingSessions, 1);
	assert.equal(result.report.writtenFiles, 1);
	assert.equal(result.report.writtenRows, 1);
	assert.deepEqual(await readdir(dirname(f.target(childId))), [filename(childId)]);

	const exported = await readFile(f.target(childId), "utf8");
	await put(join(f.sessions, "--another-copy--", "moved.jsonl"), exported);
	const duplicate = f.run(true);
	assert.equal(duplicate.report.existingSessions, 2);
	assert.equal(duplicate.report.identicalFiles, 0);
	assert.equal(duplicate.report.writtenFiles, 0);
	assert.equal(await readFile(f.target(childId), "utf8"), exported);
});

test("cache warm is an attributed request, but unattributed compaction stays inert and partial facts remain partial", async t => {
	const f = await fixture(t);
	const unattributed = { totalTokens: 64, cacheRead: 0, cost: { total: 1.25 } };
	const costOnly = { cost: { total: 0.05 } };
	await f.source({ handle: "partial", entries: [
		assistant("abcd1001", null, null),
		assistant("abcd1002", "abcd1001", { input: 0, output: -1, cacheRead: "4", cost: { total: 0, output: "SYNTHETIC_SECRET" } }),
		{ type: "usage", id: "abcd1003", parentId: "abcd1002", timestamp: later, kind: "cache_warm", provider: "synthetic", model: "warm/cache", usage: recorded, note: "SYNTHETIC_SECRET" },
		{ type: "compaction", id: "abcd1004", parentId: "abcd1003", timestamp: later, usage: unattributed, summary: "SYNTHETIC_SECRET" },
		{ type: "branch_summary", id: "abcd1005", parentId: "abcd1004", timestamp: later, summary: "SYNTHETIC_SECRET" },
		assistant("abcd1006", "abcd1005", costOnly),
	] });
	const result = f.run(true);
	assert.equal(result.status, 1);
	assert.equal(result.report.coverage, "incomplete");
	assert.equal(result.report.missingUsageRows, 2);
	assert.equal(result.report.partialUsageRows, 3);
	assert.equal(result.report.unattributedUsageRows, 1);
	assert.deepEqual(result.report.unattributedUsageSubtotal, { input: null, output: null, cacheRead: 0, cacheWrite: null, cacheWrite1h: null, reasoning: null, totalTokens: 64 });
	assert.equal(result.report.writtenRows, 4);
	const path = f.target(childId);
	const content = await readFile(path, "utf8");
	assert.doesNotMatch(content, /SYNTHETIC_SECRET|abcd1001|abcd1005|cache_warm/);
	const [, partial, direct, compaction, assistantCostOnly] = content.trimEnd().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(partial.message.usage, { input: 0, cost: { total: 0 } });
	assert.deepEqual(direct.message, { role: "assistant", content: [], provider: "synthetic", model: "warm/cache", timestamp: Date.parse(later), usage: recorded });
	assert.deepEqual(compaction, { type: "custom", id: `${childId}_abcd1004`, nativeEntryId: "abcd1004", parentId: `${childId}_abcd1003`, timestamp: later,
		customType: "agents.usage-unattributed", data: { timestamp: Date.parse(later), usage: unattributed } });
	assert.deepEqual(assistantCostOnly.message.usage, costOnly);
	const inode = (await stat(path)).ino;
	const rerun = f.run(true);
	assert.equal(rerun.report.identicalFiles, 1);
	assert.equal(rerun.report.writtenFiles, 0);
	assert.deepEqual(rerun.report.unattributedUsageSubtotal, result.report.unattributedUsageSubtotal);
	assert.equal((await stat(path)).ino, inode);
});

test("missing source, invalid owner, and partial or inaccessible native input do not look like known zero usage", async t => {
	const f = await fixture(t);
	const missing = f.run();
	assert.equal(missing.status, 1);
	assert.equal(missing.report.coverage, "unavailable");
	assert.deepEqual(missing.report.sourceRoots, { "managed-agents": "absent", "subagent-managed-sessions": "absent" });
	await f.source({ handle: "invalidOwner", repo: "/workspace/../escaped", parent: "../escape" });
	const partial = await f.source({ handle: "partial", id: otherId });
	await writeFile(partial.native, `${partial.bytes}{"type":"mess`);
	const noRegistry = await f.source({ handle: "missingRegistry", id: thirdId });
	await rm(join(noRegistry.dir, "registry.json"));
	const result = f.run(true);
	assert.equal(result.status, 1);
	assert.equal(result.report.coverage, "unavailable");
	assert.equal(result.report.sourceIssues, 3);
	assert.equal(result.report.writtenFiles, 0);
	await assert.rejects(stat(f.sessions), { code: "ENOENT" });
});

test("zero-byte private placeholders, bound handles, and unknown missing native files are distinct", async t => {
	const f = await fixture(t);
	const empty = await f.source({ handle: `session_${otherId}`, version: 3 });
	await writeFile(empty.native, "");
	const binding = { bucket: project, filename: filename(otherId) };
	const bound = await f.source({ handle: "newBound", id: otherId, binding });
	await rm(bound.native);
	const noNative = await f.source({ handle: "noNative", id: thirdId });
	await rm(noNative.native);
	const result = f.run(true);
	assert.equal(result.status, 1);
	assert.equal(result.report.emptyNativeFiles, 1);
	assert.equal(result.report.boundHandles, 1);
	assert.equal(result.report.missingNativeFiles, 1);
	assert.equal(result.report.sourceIssues, 1);
	assert.equal(result.report.writtenFiles, 0);
	assert.equal(await readFile(empty.native, "utf8"), "");
	await assert.rejects(stat(f.sessions), { code: "ENOENT" });

	await rm(join(empty.dir, "registry.json"));
	const brokenRegistry = f.run();
	assert.equal(brokenRegistry.report.emptyNativeFiles, 1);
	assert.equal(brokenRegistry.report.missingNativeFiles, 1);
	assert.equal(brokenRegistry.report.sourceIssues, 2);
});

test("native source and destination are streamed over long rows and large files", async t => {
	const f = await fixture(t);
	const longContent = "通".repeat(1_500_000);
	const user = { type: "message", id: "abcd1000", parentId: null, timestamp, message: { role: "user", content: longContent } };
	const source = await f.source({ handle: `session_${thirdId}`, version: 3, entries: [user, assistant("abcd1001", user.id)] });
	assert.ok((await stat(source.native)).size > 4 * 1024 ** 2);
	const ordinary = join(f.sessions, "--ordinary--", filename(otherId));
	await put(ordinary, jsonl([header(otherId)]));
	const padding = jsonl([{ type: "custom", id: "nonUsage", data: longContent }]);
	for (let index = 0; index < 16; index++) await appendFile(ordinary, padding);
	await appendFile(ordinary, jsonl([assistant("abcd2000", null, { cost: { total: 0.1 } })]));
	assert.ok((await stat(ordinary)).size > 64 * 1024 ** 2);
	const result = f.run(true);
	assert.equal(result.status, 0);
	assert.equal(result.report.writtenRows, 1);
	const content = await readFile(f.target(childId), "utf8");
	assert.doesNotMatch(content, /通/);
	assert.equal(content.trimEnd().split("\n").length, 2);
});

test("an observation ledger is skipped only at its sidecar boundary, not at an ordinary session path", async t => {
	const f = await fixture(t);
	await f.source({ handle: "currentPrivate" });
	const sidecar = join(f.sessions, project, "sol-pi", "sol-session-1", "observation-pack", "ledger.jsonl");
	await put(sidecar, '{"type":"observation"}\n');
	const ordinary = join(f.sessions, "--another--", "observation-pack", "ledger.jsonl");
	await put(ordinary, jsonl([header(otherId), assistant("abcd1001", null, { cost: { total: 0.1 } })]));
	const overlap = f.run(true);
	assert.equal(overlap.status, 1);
	assert.equal(overlap.report.ignoredSidecars, 1);
	assert.equal(overlap.report.existingSessions, 1);
	assert.equal(overlap.report.scanIssues, 0);
	assert.equal(overlap.report.writtenFiles, 0);
	await rm(ordinary);
	await put(sidecar, jsonl([header(otherId), assistant("abcd1001")]));
	const nativeAtSidecarPath = f.run(true);
	assert.equal(nativeAtSidecarPath.report.ignoredSidecars, 0);
	assert.equal(nativeAtSidecarPath.report.existingSessions, 1);
	assert.equal(nativeAtSidecarPath.report.writtenFiles, 0);
	await put(sidecar, '{"type":"observation"}\n');
	const withoutOverlap = f.run(true);
	assert.equal(withoutOverlap.status, 0);
	assert.equal(withoutOverlap.report.writtenFiles, 1);
	assert.equal(await readFile(sidecar, "utf8"), '{"type":"observation"}\n');
});

test("the global scan refuses an unscannable destination, and neither source nor destination symlinks are followed", async t => {
	const f = await fixture(t);
	const valid = await f.source({ handle: "source" });
	const external = join(f.root, "outside");
	await mkdir(external);
	await symlink(valid.native, join(external, "private.jsonl"));
	const unsafe = await f.source({ handle: "linkedNative", id: otherId });
	await rm(unsafe.native);
	await symlink(valid.native, unsafe.native);
	const alias = join(f.root, "agent-alias");
	await symlink(f.agentDir, alias);
	assert.equal(f.run(true, alias).report.blocked, "agent-dir");
	const legacy = join(f.agentDir, "subagent-managed-sessions");
	await symlink(external, legacy);
	await symlink(external, f.sessions);
	const rootLink = f.run(true);
	assert.equal(rootLink.report.sourceRoots["subagent-managed-sessions"], "unavailable");
	assert.equal(rootLink.report.sourceIssues, 2);
	assert.equal(rootLink.report.blocked, "destination-scan");
	assert.equal(rootLink.report.writtenFiles, 0);

	await rm(f.sessions);
	await mkdir(f.sessions);
	const projectPath = join(f.sessions, project);
	await symlink(external, projectPath);
	assert.equal(f.run(true).report.blocked, "destination-scan");
	await rm(projectPath);
	await put(join(f.sessions, "unrelated", "truncated.jsonl"), `${JSON.stringify(header(otherId))}\n{"partial":`);
	assert.equal(f.run(true).report.blocked, "destination-scan");
	assert.deepEqual(await readdir(external), ["private.jsonl"]);
	assert.equal(await readFile(valid.native, "utf8"), valid.bytes);
});

test("all-NUL destination holes cannot hide later duplicate charges; a mixed damaged line still blocks publication", async t => {
	const f = await fixture(t);
	await f.source({ handle: "copied" });
	await f.source({ handle: "fresh", id: otherId, entries: [assistant("abcd2000")] });
	const file = join(f.sessions, "--other--", "existing.jsonl");
	const bytes = `${jsonl([header(thirdId)])}${"\u0000".repeat(843)}\n${jsonl([assistant("abcd1001")])}`;
	await put(file, bytes);
	const dry = f.run();
	assert.equal(dry.report.destinationPaddingRows, 1); assert.equal(dry.report.scanIssues, 0);
	assert.equal(dry.report.existingSessions, 1); assert.equal(dry.report.readyFiles, 1);
	await writeFile(file, `${bytes}\u0000{\n`);
	const invalid = f.run(true);
	assert.equal(invalid.report.blocked, "destination-scan"); assert.equal(invalid.report.writtenFiles, 0);
	await writeFile(file, bytes);
	const result = f.run(true);
	assert.equal(result.report.writtenFiles, 1); assert.equal(result.report.writtenRows, 1);
	assert.equal(await readFile(file, "utf8"), bytes);
});

test("a public child archive is refused without changing its permissions or writing a charge", async t => {
	const f = await fixture(t);
	await f.source({ handle: "legacy" });
	const dir = dirname(f.target(childId));
	await mkdir(dir, { recursive: true }); await chmod(dir, 0o755);
	for (const write of [false, true]) {
		const result = f.run(write);
		assert.equal(result.status, 1); assert.equal(result.report.unsafeDestinations, 1);
		assert.equal(result.report.readyFiles, 0); assert.equal(result.report.writtenFiles, 0);
	}
	assert.deepEqual(await readdir(dir), []); assert.equal((await stat(dir)).mode & 0o777, 0o755);
});

test("a destination lock or exact-path native collision preserves original bytes", async t => {
	const f = await fixture(t);
	const source = await f.source({ handle: "source" });
	const lock = join(f.agentDir, ".export-agent-usage.lock");
	await writeFile(lock, "occupied");
	assert.equal(f.run(true).report.blocked, "export-lock");
	assert.equal(await readFile(lock, "utf8"), "occupied");
	await rm(lock);
	await put(f.target(childId), source.bytes);
	await chmod(f.target(childId), 0o400);
	const original = await stat(f.target(childId));
	const result = f.run(true);
	assert.equal(result.status, 1);
	assert.equal(result.report.existingSessions, 1);
	assert.equal(result.report.identicalFiles, 0);
	assert.equal(result.report.writtenFiles, 0);
	assert.equal(await readFile(f.target(childId), "utf8"), source.bytes);
	assert.equal((await stat(f.target(childId))).ino, original.ino);
});
