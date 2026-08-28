import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/settings-cutover.mjs", import.meta.url).pathname;

function run(args: string[]) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: {} });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("cutover preserves unrelated secret structure, permissions, and exact restoration", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-settings-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const settings = join(root, "settings.json");
	const backup = join(root, "private-backup.json");
	const original = { packages: ["/fixture/legacy", "/fixture/other"], legacyHarness: { opaque: true }, unrelated: { secret: "not-for-output", nested: [1, 2, 3] } };
	const originalSource = `${JSON.stringify(original, null, 2)}\n`;
	await writeFile(settings, originalSource);
	await chmod(settings, 0o600);
	const baseline = run(["baseline", settings, backup]);
	const applied = run(["apply", settings, "/fixture/legacy", "/fixture/current", "legacyHarness", "workflowHarness"]);
	const verified = run(["verify", settings, "/fixture/current", "workflowHarness"]);
	for (const output of [baseline, applied, verified]) assert.equal(output.includes("not-for-output"), false);
	const changed = JSON.parse(await readFile(settings, "utf8")) as Record<string, unknown>;
	assert.deepEqual(changed.unrelated, original.unrelated);
	assert.deepEqual(changed.packages, ["/fixture/current", "/fixture/other"]);
	assert.equal("legacyHarness" in changed, false);
	assert.equal((await stat(settings)).mode & 0o777, 0o600);
	assert.equal((await stat(backup)).mode & 0o777, 0o600);
	run(["restore", settings, backup]);
	assert.equal(await readFile(settings, "utf8"), originalSource);
	assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), original);
});
