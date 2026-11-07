import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, readConfigSources } from "../extensions/agents/config.ts";

const canonical = "csheng-agents.json";
const retired = "csheng-subagents.json";
const config = (model: string) => JSON.stringify({ routes: { explorer: { candidates: [{ model, thinking: "off" }] } } });

async function fixture(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agents-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("Agents reads only the canonical route file and leaves a retired file name alone", async t => {
	const root = await fixture(t);
	const bytes = config("fixture/retired");
	await writeFile(join(root, retired), bytes);
	const result = await loadConfig(root);
	assert.equal(result.source?.userFile, undefined, "a retired file name is not a user source");
	assert.notEqual(result.config?.routes.explorer.candidates[0]?.model, "fixture/retired");
	assert.equal(await readFile(join(root, retired), "utf8"), bytes);
	await assert.rejects(readFile(join(root, canonical)), { code: "ENOENT" });
});

test("canonical Agents route file is used without merging other files", async t => {
	const root = await fixture(t);
	await writeFile(join(root, retired), config("fixture/retired"));
	await writeFile(join(root, canonical), config("fixture/canonical"));
	const result = await loadConfig(root);
	assert.equal(result.config?.routes.explorer.candidates[0]?.model, "fixture/canonical");
	assert.equal(result.source?.userFile, canonical);
	assert.equal((await readConfigSources(root)).userFile, canonical);
});

test("an invalid canonical route file is visible and never silently falls back", async t => {
	const root = await fixture(t);
	await writeFile(join(root, retired), config("fixture/retired"));
	await writeFile(join(root, canonical), "{invalid");
	const result = await loadConfig(root);
	assert.equal(result.config === undefined, true, "invalid configuration must not yield effective routes");
	assert.equal(result.diagnostic?.code, "invalid_route_config");
	assert.equal(result.source?.userFile, canonical);
});

test("canonical route file safety failures do not fall back to any other state", async t => {
	const root = await fixture(t);
	await writeFile(join(root, retired), config("fixture/retired"));
	await symlink(join(root, retired), join(root, canonical));
	const result = await loadConfig(root);
	assert.equal(result.config === undefined, true, "invalid configuration must not yield effective routes");
	assert.equal(result.diagnostic?.code, "invalid_route_config");
	assert.match(result.diagnostic?.message ?? "", /regular non-symlink/);
});
