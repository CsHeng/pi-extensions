import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, readConfigSources } from "../extensions/agents/config.ts";

const canonical = "csheng-agents.json";
const legacy = "csheng-subagents.json";
const config = (model: string) => JSON.stringify({ routes: { explorer: { candidates: [{ model, thinking: "off" }] } } });

async function fixture(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agents-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("Agents uses the known legacy route file without rewriting explicit choices", async t => {
	const root = await fixture(t);
	const bytes = config("fixture/legacy");
	await writeFile(join(root, legacy), bytes);
	const result = await loadConfig(root);
	assert.equal(result.config?.routes.explorer.candidates[0]?.model, "fixture/legacy");
	assert.equal(result.source?.userFile, legacy);
	assert.equal(await readFile(join(root, legacy), "utf8"), bytes);
	await assert.rejects(readFile(join(root, canonical)), { code: "ENOENT" });
});

test("canonical Agents route file takes precedence rather than merging legacy choices", async t => {
	const root = await fixture(t);
	await writeFile(join(root, legacy), config("fixture/legacy"));
	await writeFile(join(root, canonical), config("fixture/canonical"));
	const result = await loadConfig(root);
	assert.equal(result.config?.routes.explorer.candidates[0]?.model, "fixture/canonical");
	assert.equal(result.source?.userFile, canonical);
	assert.equal((await readConfigSources(root)).userFile, canonical);
});

test("an invalid canonical route file is visible and never silently falls back", async t => {
	const root = await fixture(t);
	await writeFile(join(root, legacy), config("fixture/legacy"));
	await writeFile(join(root, canonical), "{invalid");
	const result = await loadConfig(root);
	assert.equal(result.config === undefined, true, "invalid configuration must not yield effective routes");
	assert.equal(result.diagnostic?.code, "invalid_route_config");
	assert.equal(result.source?.userFile, canonical);
});

test("canonical route file safety failures do not fall back to legacy state", async t => {
	const root = await fixture(t);
	await writeFile(join(root, legacy), config("fixture/legacy"));
	await symlink(join(root, legacy), join(root, canonical));
	const result = await loadConfig(root);
	assert.equal(result.config === undefined, true, "invalid configuration must not yield effective routes");
	assert.equal(result.diagnostic?.code, "invalid_route_config");
	assert.match(result.diagnostic?.message ?? "", /regular non-symlink/);
});
