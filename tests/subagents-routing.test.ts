import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, loadConfig, parseConfig } from "../extensions/subagents/config.ts";
import { resolveRoute, type RouteModel, type RouteRegistry } from "../extensions/subagents/routing.ts";

function registry(models: RouteModel[], authenticated = new Set(models.map((model) => `${model.provider}/${model.id}`))): RouteRegistry {
	return {
		find(provider, modelId) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		hasConfiguredAuth(model) {
			return authenticated.has(`${model.provider}/${model.id}`);
		},
	};
}

const parent: RouteModel = { provider: "synthetic", id: "parent", reasoning: true };
const fast: RouteModel = { provider: "synthetic", id: "fast", reasoning: true };
const deep: RouteModel = { provider: "synthetic", id: "deep", reasoning: true };

function context(models: RouteModel[], scopedModels: Array<{ model: RouteModel; thinkingLevel?: string }> = []) {
	return {
		parentModel: parent,
		parentThinking: "high",
		scopedModels,
		modelRegistry: registry(models),
	};
}

test("packaged route configuration owns role preferences and ten-way global capacity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-package-routing-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const loaded = await loadConfig(root);
	assert.equal(loaded.diagnostic, undefined);
	const config = loaded.config;
	assert.ok(config);
	assert.equal(config.maxConcurrency, 10);
	assert.equal(config.routes.explorer.candidates[0]?.model, "openai-codex/gpt-5.6-luna");
	assert.equal(config.routes.worker.candidates[0]?.model, "openai-codex/gpt-5.6-terra");
	assert.equal(config.routes.reviewer.candidates[0]?.model, "openai-codex/gpt-5.6-sol");
	assert.equal(config.routes.explorer.source, "package-default");
	assert.deepEqual(config.reasoningProfiles, { light: "low", standard: "medium", deep: "high" });
});

test("neutral configuration inherits the exact parent route when explicitly used", () => {
	const config = defaultConfig("/tmp/agent");
	const result = resolveRoute("worker", config, context([parent]));
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.route, {
			provider: "synthetic",
			model: "parent",
			thinking: "high",
			source: "parent",
			candidateIndex: 0,
			executionProfileApplied: false,
			reasoningProfileApplied: false,
			profileFallbacks: [],
		});
	}
});

test("ordered user candidates respect authentication, scope, and thinking pins", () => {
	const config = parseConfig({
		maxConcurrency: 2,
		routes: {
			explorer: {
				candidates: [
					{ model: "synthetic/unavailable", thinking: "low" },
					{ model: "synthetic/fast", thinking: "low" },
				],
				maxConcurrency: 2,
			},
		},
	}, "/tmp/agent");
	const result = resolveRoute("explorer", config, context([parent, fast], [{ model: fast, thinkingLevel: "low" }]));
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.route.model, "fast");
		assert.equal(result.route.candidateIndex, 1);
		assert.equal(result.route.source, "user-config");
	}
});

test("semantic profiles select configured candidates and reasoning while unmapped profiles visibly fall back", () => {
	const config = parseConfig({
		reasoningProfiles: { deep: "high" },
		routes: {
			explorer: {
				candidates: [{ model: "synthetic/fast", thinking: "medium" }],
				executionProfiles: {
					deep: { candidates: [{ model: "synthetic/deep", thinking: "medium" }] },
				},
			},
		},
	}, "/tmp/agent");
	const mapped = resolveRoute("explorer", config, context([fast, deep]), {
		executionProfile: "deep",
		reasoningProfile: "deep",
	});
	assert.equal(mapped.ok, true);
	if (mapped.ok) {
		assert.equal(mapped.route.model, "deep");
		assert.equal(mapped.route.thinking, "high");
		assert.equal(mapped.route.executionProfileApplied, true);
		assert.equal(mapped.route.reasoningProfileApplied, true);
		assert.deepEqual(mapped.route.profileFallbacks, []);
	}
	const fallback = resolveRoute("explorer", config, context([fast, deep]), {
		executionProfile: "fast",
		reasoningProfile: "light",
	});
	assert.equal(fallback.ok, true);
	if (fallback.ok) {
		assert.equal(fallback.route.model, "fast");
		assert.equal(fallback.route.thinking, "medium");
		assert.deepEqual(fallback.route.profileFallbacks, ["execution-role-default", "reasoning-role-default"]);
	}
});

test("user overlay can lower caps without replacing unmentioned packaged routes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-user-overlay-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "csheng-subagents.json"), JSON.stringify({
		maxConcurrency: 3,
		routes: { explorer: { maxConcurrency: 2 } },
	}));
	const loaded = await loadConfig(root);
	assert.equal(loaded.config?.maxConcurrency, 3);
	assert.equal(loaded.config?.routes.explorer.maxConcurrency, 2);
	assert.equal(loaded.config?.routes.explorer.source, "package-default");
	assert.equal(loaded.config?.routes.worker.candidates[0]?.model, "openai-codex/gpt-5.6-terra");
});

test("route fails without silent fallback when scope or thinking is incompatible", () => {
	const config = parseConfig({
		routes: { reviewer: { candidates: [{ model: "synthetic/fast", thinking: "high" }] } },
	}, "/tmp/agent");
	const result = resolveRoute("reviewer", config, context([fast], [{ model: fast, thinkingLevel: "low" }]));
	assert.deepEqual(result, {
		ok: false,
		error: {
			code: "route_unavailable",
			message: "No configured reviewer route is available inside the active model scope.",
		},
	});
});

test("configuration cannot raise hard limits or add unknown fields", () => {
	assert.throws(() => parseConfig({ maxConcurrency: 11 }, "/tmp/agent"), /1 through 10/);
	assert.throws(() => parseConfig({ routes: { explorer: { maxConcurrency: 5 } } }, "/tmp/agent"), /1 through 4/);
	assert.throws(() => parseConfig({ routes: { worker: { maxConcurrency: 3 } } }, "/tmp/agent"), /1 through 2/);
	assert.throws(() => parseConfig({ model: "synthetic/fast" }, "/tmp/agent"), /unsupported fields/);
	assert.throws(() => parseConfig({ reasoningProfiles: { extreme: "max" } }, "/tmp/agent"), /unsupported fields/);
});

test("loader isolates malformed and symlinked user configuration", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "csheng-subagents.json"), "{");
	const malformed = await loadConfig(root);
	assert.equal(malformed.diagnostic?.code, "invalid_route_config");
	assert.equal(malformed.diagnostic?.message, "route configuration is not valid JSON");

	await rm(join(root, "csheng-subagents.json"));
	await mkdir(join(root, "actual"));
	await writeFile(join(root, "actual", "config.json"), "{}");
	await symlink(join(root, "actual", "config.json"), join(root, "csheng-subagents.json"));
	const linked = await loadConfig(root);
	assert.match(linked.diagnostic?.message ?? "", /non-symlink/);
});

test("packaged JSON parses through the strict package source", async () => {
	const value = JSON.parse(await readFile(new URL("../config/csheng-subagents.json", import.meta.url), "utf8")) as unknown;
	const parsed = parseConfig(value, "/tmp/agent", { source: "package-default" });
	assert.equal(parsed.routes.worker.source, "package-default");
});
