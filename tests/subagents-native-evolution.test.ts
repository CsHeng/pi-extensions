import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { collectNativeObservation, nativeLeaf } from "../extensions/subagents/observability.ts";
import { validateGraphStructure } from "../extensions/subagents/graph.ts";
import { installedHostEnvironment } from "../scripts/installed-host-env.ts";
const exec = promisify(execFile);
const hostEnv = installedHostEnvironment();

test("installed Pi recovery context edits are readable without mutating native history", async (t) => {
	try { await exec("pi", ["--version"], { env: hostEnv, timeout: 5000 }); } catch { t.skip("installed Pi unavailable; no installation performed"); return; }
	const base = await mkdtemp(join(tmpdir(), "native-evolution-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const store = new ManagedSessionStore(base);
	const owner = { repo: base, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
	const graph = validateGraphStructure({ tasks: [{ id: "reader", role: "explorer", objective: "synthetic", scope: ["."] }] });
	if (!graph.ok) throw new Error("fixture");
	const record = (await store.allocate(owner, "native", graph.tasks)).records[0]!;
	const source = join(store.path(record.handle), "source"); await mkdir(source);
	const file = join(store.path(record.handle), "native.jsonl");
	const launched = exec("pi", ["--mode", "json", "-p", "--session", file, "--no-extensions", "-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname, "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--model", "subagent-fixture/fixture", "--thinking", "off", "--", "synthetic recovery"], {
		cwd: source, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
		env: { PATH: hostEnv.PATH, HOME: base, PI_CODING_AGENT_DIR: join(base, "agent"), PI_OFFLINE: "1", CSHENG_NATIVE_COMPACTION_MODE: "overflow" },
	});
	launched.child.stdin?.end();
	await launched;
	const original = await readFile(file, "utf8");
	const entries = original.trim().split("\n").map(line => JSON.parse(line));
	assert.ok(entries.some(entry => entry.type === "context_edit"), "actual installed host emitted recovery edit");
	const revision = await store.nativeRevision(record.handle);
	assert.equal(revision.sessionId, entries[0].id);
	assert.equal(revision.leaf, entries.at(-1).id);
	assert.equal(nativeLeaf(original), revision.leaf);
	assert.equal(collectNativeObservation(original, { startLeaf: null, endLeaf: revision.leaf, launched: true }).available, true);
	assert.equal(await readFile(file, "utf8"), original);
	for (const entry of [
		{ type: "usage", id: "ancillary", parentId: revision.leaf, timestamp: new Date().toISOString(), kind: "synthetic" },
		{ type: "future_host_metadata", id: "ancillary", parentId: revision.leaf },
	]) {
		await writeFile(file, `${original}${JSON.stringify(entry)}\n`);
		assert.equal((await store.nativeRevision(record.handle)).leaf, "ancillary");
	}
	for (const bad of [
		{ ...entries[0], cwd: base }, { ...entries[0], id: "../forged" },
	]) {
		await writeFile(file, [bad, ...entries.slice(1)].map(entry => JSON.stringify(entry)).join("\n") + "\n");
		await assert.rejects(store.nativeRevision(record.handle), /managed_native_invalid/);
	}
	for (const tail of [
		JSON.stringify({ type: "context_edit", id: revision.leaf, parentId: revision.leaf }),
		JSON.stringify({ type: "context_edit", id: "orphan", parentId: "absent" }),
		JSON.stringify(entries[0]), "{broken-json}",
	]) {
		await writeFile(file, `${original}${tail}\n`);
		await assert.rejects(store.nativeRevision(record.handle), /managed_native_invalid/);
	}
	await writeFile(file, original.slice(0, -1));
	await assert.rejects(store.nativeRevision(record.handle), /managed_native_incomplete/);
});
