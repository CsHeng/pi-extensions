import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getLaunchProfile, loadLaunchConfig, parseLaunchConfig } from "../extensions/herdr-handoff/config.ts";
import { HARD_LIMITS, LAUNCH_CONFIG_FILE } from "../extensions/herdr-handoff/contracts.ts";

async function agentDir(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "herdr-handoff-config-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return root;
}

function validConfig(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		profiles: {
			"codex-default": {
				kind: "codex",
				args: ["--ask-for-approval", "never"],
			},
		},
		...overrides,
	};
}

test("absent launch configuration leaves profiles empty", async (t) => {
	const loaded = await loadLaunchConfig(await agentDir(t));
	assert.equal(loaded.ok, true);
	if (!loaded.ok) return;
	assert.equal(loaded.config.missing, true);
	assert.deepEqual(loaded.config.profiles, {});
	const lookup = getLaunchProfile(loaded.config, "codex-default");
	assert.equal(lookup.ok, false);
	if (!lookup.ok) assert.equal(lookup.code, "launch_profile_not_found");
});

test("valid exact profile is returned without fallback", async (t) => {
	const root = await agentDir(t);
	await writeFile(join(root, LAUNCH_CONFIG_FILE), JSON.stringify({
		version: 1,
		profiles: {
			"codex-default": { kind: "codex", args: ["--sandbox", "workspace-write"], startupTimeoutMs: 30_000 },
			"pi-local": { kind: "pi", args: [] },
		},
	}));
	const loaded = await loadLaunchConfig(root);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) return;
	const selected = getLaunchProfile(loaded.config, "codex-default");
	assert.equal(selected.ok, true);
	if (!selected.ok) return;
	assert.equal(selected.profile.kind, "codex");
	assert.deepEqual(selected.profile.args, ["--sandbox", "workspace-write"]);
	assert.equal(selected.profile.startupTimeoutMs, 30_000);
	const missing = getLaunchProfile(loaded.config, "grok-default");
	assert.equal(missing.ok, false);
	if (!missing.ok) {
		assert.equal(missing.code, "launch_profile_not_found");
		assert.doesNotMatch(missing.message, /grok-default/);
	}
});

test("argv items keep spaces and punctuation and are not shell text", () => {
	const profiles = parseLaunchConfig({
		version: 1,
		profiles: {
			"codex-default": {
				kind: "codex",
				args: ["--flag", "value with spaces", "--json={\"a\":1}"],
			},
		},
	});
	assert.deepEqual(profiles["codex-default"]?.args, ["--flag", "value with spaces", "--json={\"a\":1}"]);
});

test("malformed, unknown-key, oversized, and invalid identifier configs fail closed", async (t) => {
	assert.throws(() => parseLaunchConfig({ version: 2, profiles: {} }));
	assert.throws(() => parseLaunchConfig({ version: 1, profiles: {}, extra: true }));
	assert.throws(() => parseLaunchConfig({ version: 1, profiles: { "Codex": { kind: "codex", args: [] } } }));
	assert.throws(() => parseLaunchConfig({
		version: 1,
		profiles: { "codex-default": { kind: "codex", args: ["x".repeat(HARD_LIMITS.maxArgvItemBytes + 1)] } },
	}));
	assert.throws(() => parseLaunchConfig({
		version: 1,
		profiles: { "codex-default": { kind: "codex", args: ["ok\0bad"] } },
	}));
	assert.throws(() => parseLaunchConfig({
		version: 1,
		profiles: { "codex-default": { kind: "codex", args: [], startupTimeoutMs: 3_000 } },
	}));

	const duplicates = await agentDir(t);
	await writeFile(join(duplicates, LAUNCH_CONFIG_FILE), '{"version":1,"version":1,"profiles":{}}');
	const duplicateLoad = await loadLaunchConfig(duplicates);
	assert.equal(duplicateLoad.ok, false);

	const malformed = await agentDir(t);
	await writeFile(join(malformed, LAUNCH_CONFIG_FILE), "{not json");
	const malformedLoad = await loadLaunchConfig(malformed);
	assert.equal(malformedLoad.ok, false);
	if (!malformedLoad.ok) {
		assert.equal(malformedLoad.code, "launch_config_invalid");
		assert.doesNotMatch(malformedLoad.message, /not json/);
		assert.equal(malformedLoad.message.includes(malformed), false);
	}
});

test("symlinked launch configuration is rejected", async (t) => {
	const root = await agentDir(t);
	const target = join(root, "target.json");
	await writeFile(target, JSON.stringify(validConfig()));
	await symlink(target, join(root, LAUNCH_CONFIG_FILE));
	const loaded = await loadLaunchConfig(root);
	assert.equal(loaded.ok, false);
	if (!loaded.ok) assert.equal(loaded.code, "launch_config_invalid");
});

test("directory named as the config file is rejected", async (t) => {
	const root = await agentDir(t);
	await mkdir(join(root, LAUNCH_CONFIG_FILE));
	const loaded = await loadLaunchConfig(root);
	assert.equal(loaded.ok, false);
	if (!loaded.ok) assert.equal(loaded.code, "launch_config_invalid");
	await chmod(join(root, LAUNCH_CONFIG_FILE), 0o700);
});
