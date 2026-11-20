import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfigSources, readConfigSources } from "../extensions/agents/config.ts";
import { createProvenance, fingerprintConfig, fingerprintSources, PROVENANCE_DIR, PROVENANCE_MANIFEST } from "../extensions/agents/provenance.ts";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";

test("identical source and configuration fingerprints reuse opaque epochs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-provenance-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const sourceRoot = join(root, "src");
	await mkdir(sourceRoot);
	await writeFile(join(sourceRoot, "index.ts"), "export {}\n");
	let now = 1_000;
	const first = createProvenance({
		now: () => now,
		randomId: () => "EpochA",
		agentDir: root,
		sourceRoot,
	});
	const extension = await first.observeExtension();
	assert.equal(extension.available, true);
	const snapshot = { packageBytes: Buffer.from("{\"guidance\":\"off\"}") };
	const config = await first.observeConfiguration(snapshot);
	assert.equal(config.available, true);
	if (!config.available || !extension.available) return;
	now = 2_000;
	const second = createProvenance({
		now: () => now,
		randomId: () => "EpochB",
		agentDir: root,
		sourceRoot,
	});
	const again = await second.observeExtension();
	assert.equal(again.available, true);
	if (!again.available) return;
	assert.equal(again.extensionEpoch, extension.extensionEpoch);
	const configAgain = await second.observeConfiguration(snapshot);
	assert.equal(configAgain.available, true);
	if (!configAgain.available) return;
	assert.equal(configAgain.configurationEpoch, config.configurationEpoch);
});

test("reloaded content transitions mint epochs while disk edits cannot relabel a loaded runtime", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-provenance-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const sourceRoot = join(root, "src");
	await mkdir(sourceRoot);
	await writeFile(join(sourceRoot, "index.ts"), "one\n");
	const ids = ["one", "two", "three"];
	const makeRuntime = () => createProvenance({
		now: () => 1,
		randomId: () => ids.shift() ?? "overflow",
		agentDir: root,
		sourceRoot,
	});
	const provenance = makeRuntime();
	const first = await provenance.observeExtension();
	await writeFile(join(sourceRoot, "index.ts"), "two\n");
	assert.deepEqual(await provenance.observeExtension(), first, "same loaded runtime keeps its original identity");
	const second = await makeRuntime().observeExtension();
	await writeFile(join(sourceRoot, "index.ts"), "one\n");
	const third = await makeRuntime().observeExtension();
	assert.equal(first.available && second.available && third.available, true);
	if (!first.available || !second.available || !third.available) return;
	assert.equal(first.extensionEpoch, "one");
	assert.equal(second.extensionEpoch, "two");
	assert.equal(third.extensionEpoch, "three");
});

test("current epoch IDs are alphanumeric and do not reuse or rewrite the retired cache", async t => {
	const root = await mkdtemp(join(tmpdir(), "agent-provenance-cut-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, PROVENANCE_DIR); await mkdir(directory, { recursive: true, mode: 0o700 });
	const old = join(directory, "current.json"); const bytes = '{"legacy":"not current evidence"}';
	await writeFile(old, bytes, { mode: 0o600 });
	const core = createProvenance({ agentDir: root, listSourceFiles: async () => [{ name: "a.ts", bytes: Buffer.from("current") }] });
	const source = await core.observeExtension();
	const configuration = await core.observeConfiguration({ packageBytes: Buffer.from("{}") });
	assert.equal(source.available && configuration.available, true);
	if (!source.available || !configuration.available) return;
	assert.match(source.extensionEpoch, /^[A-Za-z0-9]+$/);
	assert.match(configuration.configurationEpoch, /^[A-Za-z0-9]+$/);
	assert.equal(configuration.extensionEpoch, source.extensionEpoch);
	assert.equal(await readFile(old, "utf8"), bytes);
	assert.equal(JSON.parse(await readFile(join(directory, PROVENANCE_MANIFEST), "utf8")).configurationEpoch, configuration.configurationEpoch);
});

test("nested provenance leaves the old location untouched and shares epochs under concurrent writers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-provenance-nested-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const old = join(root, "agent-provenance");
	await mkdir(old, { mode: 0o700 });
	await writeFile(join(old, PROVENANCE_MANIFEST), "old evidence", { mode: 0o600 });
	const make = () => createProvenance({ agentDir: root, listSourceFiles: async () => [{ name: "a.ts", bytes: Buffer.from("same") }] });
	const results = await Promise.all(Array.from({ length: 5 }, () => make().observeExtension()));
	const available = results.filter(result => result.available);
	assert.ok(available.length > 0);
	assert.equal(new Set(available.map(result => result.extensionEpoch)).size, 1);
	const after = await make().observeExtension();
	assert.ok(after.available);
	assert.equal(after.extensionEpoch, available[0]?.extensionEpoch);
	assert.equal(await readFile(join(old, PROVENANCE_MANIFEST), "utf8"), "old evidence");
	assert.deepEqual(await readdir(old), [PROVENANCE_MANIFEST]);
	const nested = join(root, "managed-agents", "_provenance");
	assert.equal(PROVENANCE_DIR, join("managed-agents", "_provenance"));
	assert.equal((await lstat(nested)).mode & 0o077, 0);
	assert.equal(JSON.parse(await readFile(join(nested, PROVENANCE_MANIFEST), "utf8")).extensionEpoch, after.extensionEpoch);
	const store = new ManagedSessionStore(root);
	const owner = { repo: root, parentSessionId: "parent", anchor: "branch", branch: ["branch"] };
	assert.throws(() => store.path("_provenance"), /invalid_handle/);
	assert.deepEqual(await store.list(owner), []);
	const inventory = await store.inventory(owner);
	assert.ok(inventory.available);
	assert.equal(inventory.complete, true);
	assert.deepEqual(inventory.entries, []);
});

test("managed root symlinks are rejected before creating nested provenance", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-provenance-symlink-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "target");
	await mkdir(target, { mode: 0o700 });
	await symlink(target, join(root, "managed-agents"));
	const core = createProvenance({ agentDir: root, listSourceFiles: async () => [{ name: "a.ts", bytes: Buffer.from("a") }] });
	assert.deepEqual(await core.observeExtension(), { available: false });
	assert.deepEqual(await readdir(target), []);
	await assert.rejects(lstat(join(root, "agent-provenance")), { code: "ENOENT" });
	const alias = join(root, "agent-dir-alias");
	await symlink(target, alias);
	const aliased = createProvenance({ agentDir: alias, listSourceFiles: async () => [] });
	assert.deepEqual(await aliased.observeExtension(), { available: false });
	assert.deepEqual(await readdir(target), [], "no private root may be created through a symlinked Pi directory");
});

test("config source snapshots keep parse bytes identical to the fingerprint input", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-config-source-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const snapshot = await readConfigSources(root);
	const loaded = parseConfigSources(snapshot);
	assert.ok(loaded.config);
	assert.equal(loaded.source, snapshot);
	assert.equal(fingerprintConfig(snapshot).length, 64);
	assert.notEqual(
		await fingerprintSources([{ name: "a.ts", bytes: Buffer.from("a") }]),
		await fingerprintSources([{ name: "a.ts", bytes: Buffer.from("b") }]),
	);
	const invalid = parseConfigSources({ packageBytes: Buffer.from("{") });
	assert.equal(invalid.config, undefined);
	assert.equal(invalid.diagnostic?.code, "invalid_route_config");
	assert.ok(invalid.source);
});

test("a superseded core does not overwrite a newer extension epoch after a config change", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-provenance-supersede-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const sourceA = join(root, "a");
	const sourceB = join(root, "b");
	await mkdir(sourceA);
	await mkdir(sourceB);
	await writeFile(join(sourceA, "index.ts"), "a\n");
	await writeFile(join(sourceB, "index.ts"), "b\n");
	const older = createProvenance({ now: () => 1, randomId: () => "old", agentDir: root, sourceRoot: sourceA });
	const newer = createProvenance({ now: () => 2, randomId: () => "new", agentDir: root, sourceRoot: sourceB });
	assert.equal((await older.observeExtension()).available, true);
	assert.equal((await older.observeConfiguration({ packageBytes: Buffer.from("1") })).available, true);
	assert.equal((await newer.observeExtension()).available, true);
	const changed = await older.observeConfiguration({ packageBytes: Buffer.from("2") });
	assert.equal(changed.available, false);
	const manifest = JSON.parse(await readFile(join(root, PROVENANCE_DIR, PROVENANCE_MANIFEST), "utf8")) as { extensionEpoch: string };
	assert.equal(manifest.extensionEpoch, "new");
});
