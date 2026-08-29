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

test("packaged route configuration projects the code-owned defaults", async () => {
	const packaged = parseConfig(
		JSON.parse(await readFile(new URL("../config/csheng-subagents.json", import.meta.url), "utf8")) as unknown,
		"/tmp/agent",
	);
	const defaults = defaultConfig("/tmp/agent");
	assert.equal(packaged.guidance, defaults.guidance);
	assert.equal(packaged.maxConcurrency, defaults.maxConcurrency);
	for (const role of ["explorer", "reviewer", "worker"] as const) {
		assert.deepEqual(packaged.routes[role].candidates, defaults.routes[role].candidates);
		assert.equal(packaged.routes[role].maxConcurrency, defaults.routes[role].maxConcurrency);
	}
});

test("absent configuration inherits the exact parent route", () => {
	const config = defaultConfig("/tmp/agent");
	const result = resolveRoute("worker", config, {
		parentModel: parent,
		parentThinking: "high",
		scopedModels: [],
		modelRegistry: registry([parent]),
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.route, {
			provider: "synthetic",
			model: "parent",
			thinking: "high",
			source: "parent",
			candidateIndex: 0,
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
	const result = resolveRoute("explorer", config, {
		parentModel: parent,
		parentThinking: "high",
		scopedModels: [{ model: fast, thinkingLevel: "low" }],
		modelRegistry: registry([parent, fast]),
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.route.model, "fast");
		assert.equal(result.route.candidateIndex, 1);
		assert.equal(result.route.source, "user-config");
	}
});

test("route fails without silent fallback when scope or thinking is incompatible", () => {
	const config = parseConfig({
		routes: { reviewer: { candidates: [{ model: "synthetic/fast", thinking: "high" }] } },
	}, "/tmp/agent");
	const result = resolveRoute("reviewer", config, {
		parentModel: parent,
		parentThinking: "high",
		scopedModels: [{ model: fast, thinkingLevel: "low" }],
		modelRegistry: registry([fast]),
	});
	assert.deepEqual(result, {
		ok: false,
		error: {
			code: "route_unavailable",
			message: "No configured reviewer route is available inside the active model scope.",
		},
	});
});

test("configuration cannot raise hard limits or add unknown fields", () => {
	assert.throws(() => parseConfig({ maxConcurrency: 5 }, "/tmp/agent"), /1 through 4/);
	assert.throws(() => parseConfig({ routes: { worker: { candidates: [{ model: "$parent", thinking: "$parent" }], maxConcurrency: 3 } } }, "/tmp/agent"), /1 through 2/);
	assert.throws(() => parseConfig({ model: "synthetic/fast" }, "/tmp/agent"), /unsupported fields/);
});

test("loader isolates missing, malformed, and symlinked user configuration", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const missing = await loadConfig(root);
	assert.equal(missing.config?.guidance, "aggressive");

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
