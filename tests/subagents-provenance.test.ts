import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfigSources, readConfigSources } from "../extensions/subagents/config.ts";
import { createProvenance, fingerprintConfig, fingerprintSources } from "../extensions/subagents/provenance.ts";

test("identical source and configuration fingerprints reuse opaque epochs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-provenance-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const sourceRoot = join(root, "src");
	await mkdir(sourceRoot);
	await writeFile(join(sourceRoot, "index.ts"), "export {}\n");
	let now = 1_000;
	const first = createProvenance({
		now: () => now,
		randomId: () => "epoch-a",
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
		randomId: () => "epoch-b",
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
	const root = await mkdtemp(join(tmpdir(), "subagent-provenance-"));
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

test("config source snapshots keep parse bytes identical to the fingerprint input", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-config-source-"));
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
	const root = await mkdtemp(join(tmpdir(), "subagent-provenance-supersede-"));
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
	const manifest = JSON.parse(await readFile(join(root, "subagent-provenance", "current.json"), "utf8")) as { extensionEpoch: string };
	assert.equal(manifest.extensionEpoch, "new");
});
