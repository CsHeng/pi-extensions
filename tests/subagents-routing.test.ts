import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, loadConfig, parseConfig } from "../extensions/subagents/config.ts";
import { resolveRoute, type RouteModel, type RouteRegistry } from "../extensions/subagents/routing.ts";

function canonical(model: RouteModel): string {
	return `${model.provider}/${model.id}`;
}

function registry(
	models: RouteModel[],
	authenticated = new Set(models.map(canonical)),
): RouteRegistry {
	return {
		getAll() {
			return models;
		},
		getAvailable() {
			return models.filter((model) => authenticated.has(canonical(model)));
		},
	};
}

const parent: RouteModel = { provider: "synthetic", id: "parent", name: "Parent", reasoning: true };
const fast: RouteModel = { provider: "synthetic", id: "fast", name: "Fast", reasoning: true };
const deep: RouteModel = { provider: "synthetic", id: "deep", name: "Deep", reasoning: true };

function context(
	models: RouteModel[],
	scopedModels: Array<{ model: RouteModel; thinkingLevel?: string }> = [],
	authenticated = new Set(models.map(canonical)),
	parentThinking: string | undefined = "high",
) {
	return {
		parentModel: parent,
		parentThinking,
		scopedModels,
		modelRegistry: registry(models, authenticated),
	};
}

function configuredRoutes(models: RouteModel[]) {
	return parseConfig({
		routes: Object.fromEntries(["explorer", "reviewer", "worker"].map((role, index) => [role, {
			candidates: [{ model: canonical(models[index]!), thinking: "low" }],
		}])) as Record<string, unknown>,
	});
}

test("packaged route configuration owns role preferences and ten-way global capacity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-package-routing-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const loaded = await loadConfig(root);
	assert.equal(loaded.diagnostic, undefined);
	const config = loaded.config;
	assert.ok(config);
	assert.equal("configPath" in config, false);
	assert.equal(config.maxConcurrency, 10);
	assert.equal(config.routes.explorer.candidates[0]?.model, "openai-codex/gpt-5.6-luna");
	assert.equal(config.routes.worker.candidates[0]?.model, "openai-codex/gpt-5.6-terra");
	assert.equal(config.routes.reviewer.candidates[0]?.model, "openai-codex/gpt-5.6-sol");
	assert.equal(config.routes.explorer.source, "package-default");
	assert.deepEqual(config.reasoningProfiles, { light: "low", standard: "medium", deep: "high" });
});

test("neutral configuration inherits the exact parent route when overrides are omitted", () => {
	const result = resolveRoute("worker", defaultConfig(), context([parent]));
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
			selectionSource: "role-default",
			modelOverrideRequested: false,
			thinkingOverrideRequested: false,
		});
	}
});

test("ordered user candidates skip missing and unauthenticated models without consulting the cycling subset", () => {
	const config = parseConfig({
		maxConcurrency: 2,
		routes: {
			explorer: {
				candidates: [
					{ model: "synthetic/unavailable", thinking: "low" },
					{ model: "synthetic/deep", thinking: "low" },
					{ model: "synthetic/fast", thinking: "low" },
				],
				maxConcurrency: 2,
			},
		},
	});
	const result = resolveRoute("explorer", config, context([parent, fast, deep], [{ model: parent }], new Set([canonical(parent), canonical(fast)])));
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.route.model, "fast");
		assert.equal(result.route.candidateIndex, 2);
		assert.equal(result.route.source, "user-config");
		assert.equal(result.route.selectionSource, "role-default");
	}
});

test("semantic profiles select configured candidates and visibly fall back when unmapped", () => {
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
	});
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

test("explicit canonical provider/model is case-insensitive and bypasses every role default and session scope", () => {
	const defaults = [
		{ provider: "defaults", id: "explorer", reasoning: true },
		{ provider: "defaults", id: "reviewer", reasoning: true },
		{ provider: "defaults", id: "worker", reasoning: true },
	] satisfies RouteModel[];
	const selected: RouteModel = { provider: "xAI", id: "grok-4.6", name: "Grok 4.6", reasoning: true };
	const config = configuredRoutes(defaults);
	for (const role of ["explorer", "reviewer", "worker"] as const) {
		const result = resolveRoute(role, config, context([...defaults, selected], [{ model: defaults[0]! }]), {
			model: "XAI/GROK-4.6",
			thinking: "high",
		});
		assert.equal(result.ok, true, role);
		if (result.ok) {
			assert.equal(result.route.provider, "xAI");
			assert.equal(result.route.model, "grok-4.6");
			assert.equal(result.route.thinking, "high");
			assert.equal(result.route.selectionSource, "explicit-task");
			assert.equal(result.route.modelOverrideRequested, true);
			assert.equal(result.route.thinkingOverrideRequested, true);
		}
	}
});

test("normalized bare IDs and display names use exact NFKC punctuation and case equivalence", () => {
	const byId: RouteModel = { provider: "one", id: "Grok-4.6", name: "Unrelated", reasoning: true };
	const byName: RouteModel = { provider: "two", id: "release-046", name: "ＧＲＯＫ—４．６", reasoning: true };
	const idResult = resolveRoute("explorer", defaultConfig(), context([parent, byId, byName]), {
		model: "gROK__4 6",
		thinking: "low",
	});
	assert.equal(idResult.ok, true);
	if (idResult.ok) assert.equal(idResult.route.provider, "one");

	const nameResult = resolveRoute("reviewer", defaultConfig(), context([parent, byName]), {
		model: "Grok 4_6",
		thinking: "medium",
	});
	assert.equal(nameResult.ok, true);
	if (nameResult.ok) assert.equal(nameResult.route.model, "release-046");
});

test("the first non-empty matching tier wins over lower-tier display-name matches", () => {
	const idMatch: RouteModel = { provider: "id-provider", id: "chosen", name: "Other", reasoning: true };
	const nameMatch: RouteModel = { provider: "name-provider", id: "different", name: "Chosen", reasoning: true };
	const result = resolveRoute("explorer", defaultConfig(), context([parent, idMatch, nameMatch]), {
		model: "chosen",
		thinking: "low",
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.route.provider, "id-provider");
});

test("normalized collisions are ambiguous while exact provider/model disambiguates", () => {
	const first: RouteModel = { provider: "alpha", id: "grok-4.6", reasoning: true };
	const second: RouteModel = { provider: "beta", id: "grok_4_6", reasoning: true };
	const ambiguous = resolveRoute("worker", defaultConfig(), context([parent, first, second]), {
		model: "Grok 4 6",
		thinking: "high",
	});
	assert.equal(ambiguous.ok, false);
	if (!ambiguous.ok) {
		assert.equal(ambiguous.error.code, "ambiguous_model");
		assert.match(ambiguous.error.message, /alpha\/grok-4\.6, beta\/grok_4_6/);
		assert.match(ambiguous.error.message, /exact provider\/model/);
	}
	const exact = resolveRoute("worker", defaultConfig(), context([parent, first, second]), {
		model: "beta/grok_4_6",
		thinking: "high",
	});
	assert.equal(exact.ok, true);
	if (exact.ok) assert.equal(exact.route.provider, "beta");
});

test("normalized display-name collisions are ambiguous", () => {
	const first: RouteModel = { provider: "alpha", id: "release-a", name: "Grok 4.6", reasoning: true };
	const second: RouteModel = { provider: "beta", id: "release-b", name: "GROK_4-6", reasoning: true };
	const result = resolveRoute("reviewer", defaultConfig(), context([parent, first, second]), {
		model: "grok 4 6",
		thinking: "medium",
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error.code, "ambiguous_model");
		assert.match(result.error.message, /alpha\/release-a, beta\/release-b/);
	}
});

test("missing and present-but-unavailable explicit models have stable distinct failures", () => {
	const unavailable: RouteModel = { provider: "synthetic", id: "offline", name: "Offline", reasoning: true };
	const missing = resolveRoute("explorer", defaultConfig(), context([parent, unavailable]), {
		model: "does not exist",
	});
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.error.code, "model_not_found");

	const absentAuth = new Set([canonical(parent)]);
	const unavailableResult = resolveRoute("explorer", defaultConfig(), context([parent, unavailable], [], absentAuth), {
		model: "Offline",
	});
	assert.equal(unavailableResult.ok, false);
	if (!unavailableResult.ok) {
		assert.equal(unavailableResult.error.code, "model_unavailable");
		assert.match(unavailableResult.error.message, /synthetic\/offline/);
	}
});

test("duplicate canonical registry entries are one effective explicit match", () => {
	const duplicateA: RouteModel = { provider: "synthetic", id: "same", name: "Same", reasoning: true };
	const duplicateB: RouteModel = { provider: "synthetic", id: "same", name: "Same", reasoning: true };
	const result = resolveRoute("reviewer", defaultConfig(), context([parent, duplicateA, duplicateB]), {
		model: "same",
		thinking: "low",
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.route.model, "same");
});

test("ambiguous and unavailable diagnostics sort, cap at eight, and report omitted candidates", () => {
	const collisions = Array.from({ length: 10 }, (_, index): RouteModel => ({
		provider: `provider-${String(index).padStart(2, "0")}`,
		id: index % 2 === 0 ? "same-model" : "same_model",
		reasoning: true,
	}));
	const ambiguous = resolveRoute("explorer", defaultConfig(), context([parent, ...collisions]), {
		model: "same model",
		thinking: "low",
	});
	assert.equal(ambiguous.ok, false);
	if (!ambiguous.ok) {
		assert.equal(ambiguous.error.code, "ambiguous_model");
		assert.match(ambiguous.error.message, /provider-00\/same-model/);
		assert.doesNotMatch(ambiguous.error.message, /provider-08\/same-model/);
		assert.match(ambiguous.error.message, /\(2 more omitted\)/);
	}

	const onlyParent = new Set([canonical(parent)]);
	const unavailable = resolveRoute("explorer", defaultConfig(), context([parent, ...collisions], [], onlyParent), {
		model: "same model",
		thinking: "low",
	});
	assert.equal(unavailable.ok, false);
	if (!unavailable.ok) {
		assert.equal(unavailable.error.code, "model_unavailable");
		assert.match(unavailable.error.message, /\(2 more omitted\)/);
	}
});

test("an explicit model inherits the parent turn's exact thinking when no reasoning override exists", () => {
	const selected: RouteModel = { provider: "synthetic", id: "selected", reasoning: true };
	const result = resolveRoute("worker", defaultConfig(), context([parent, selected], [], undefined, "xhigh"), {
		model: "synthetic/selected",
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.route.thinking, "xhigh");
});

test("unsupported inherited parent thinking fails without using a role fallback", () => {
	const selected: RouteModel = { provider: "synthetic", id: "plain", reasoning: false };
	const fallback: RouteModel = { provider: "synthetic", id: "fallback", reasoning: true };
	const config = parseConfig({ routes: { worker: { candidates: [{ model: canonical(fallback), thinking: "off" }] } } });
	const result = resolveRoute("worker", config, context([parent, selected, fallback]), {
		model: "synthetic/plain",
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error.code, "thinking_unavailable");
		assert.match(result.error.message, /synthetic\/plain/);
	}
});

test("thinking-only selection skips unsupported ordered defaults but does not change the exact level", () => {
	const plain: RouteModel = { provider: "synthetic", id: "plain", reasoning: false };
	const capable: RouteModel = { provider: "synthetic", id: "capable", reasoning: true };
	const config = parseConfig({ routes: { reviewer: { candidates: [
		{ model: canonical(plain), thinking: "off" },
		{ model: canonical(capable), thinking: "low" },
	] } } });
	const result = resolveRoute("reviewer", config, context([plain, capable]), { thinking: "max" });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.route.model, "capable");
		assert.equal(result.route.thinking, "max");
		assert.equal(result.route.candidateIndex, 1);
		assert.equal(result.route.selectionSource, "role-default");
		assert.equal(result.route.thinkingOverrideRequested, true);
	}
});

test("thinking-only selection returns thinking_unavailable when no available default supports it", () => {
	const plain: RouteModel = { provider: "synthetic", id: "plain", reasoning: false };
	const config = parseConfig({ routes: { reviewer: { candidates: [{ model: canonical(plain), thinking: "off" }] } } });
	const result = resolveRoute("reviewer", config, context([plain]), { thinking: "high" });
	assert.deepEqual(result, {
		ok: false,
		error: {
			code: "thinking_unavailable",
			message: "Thinking level high is unavailable for configured reviewer routes.",
		},
	});
});

test("explicit model and thinking supersede semantic profiles with accurate evidence", () => {
	const roleDefault: RouteModel = { provider: "synthetic", id: "default", reasoning: true };
	const profileDefault: RouteModel = { provider: "synthetic", id: "profile", reasoning: true };
	const selected: RouteModel = { provider: "synthetic", id: "selected", reasoning: true };
	const config = parseConfig({
		reasoningProfiles: { deep: "max" },
		routes: { worker: {
			candidates: [{ model: canonical(roleDefault), thinking: "low" }],
			executionProfiles: { deep: { candidates: [{ model: canonical(profileDefault), thinking: "xhigh" }] } },
		} },
	});
	const before = JSON.stringify(config);
	const result = resolveRoute("worker", config, context([roleDefault, profileDefault, selected]), {
		executionProfile: "deep",
		reasoningProfile: "deep",
		model: "synthetic/selected",
		thinking: "medium",
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.route.model, "selected");
		assert.equal(result.route.thinking, "medium");
		assert.equal(result.route.executionProfileRequested, "deep");
		assert.equal(result.route.executionProfileApplied, false);
		assert.equal(result.route.reasoningProfileRequested, "deep");
		assert.equal(result.route.reasoningProfileApplied, false);
		assert.deepEqual(result.route.profileFallbacks, []);
	}
	assert.equal(JSON.stringify(config), before);
});

test("mapped reasoning applies to an explicit model when exact thinking is omitted", () => {
	const selected: RouteModel = { provider: "synthetic", id: "selected", reasoning: true };
	const config = parseConfig({ reasoningProfiles: { deep: "high" } });
	const result = resolveRoute("explorer", config, context([parent, selected]), {
		model: "synthetic/selected",
		reasoningProfile: "deep",
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.route.thinking, "high");
		assert.equal(result.route.reasoningProfileApplied, true);
		assert.equal(result.route.source, "user-config");
	}
});

test("explicit routing takes one getAll and getAvailable snapshot and never mutates config on failure", () => {
	const selected: RouteModel = { provider: "synthetic", id: "selected", reasoning: false };
	let allCalls = 0;
	let availableCalls = 0;
	const modelRegistry: RouteRegistry = {
		getAll() {
			allCalls += 1;
			return [selected];
		},
		getAvailable() {
			availableCalls += 1;
			return [selected];
		},
	};
	const config = defaultConfig();
	const before = JSON.stringify(config);
	const result = resolveRoute("worker", config, {
		parentModel: parent,
		parentThinking: "high",
		modelRegistry,
	}, { model: "synthetic/selected" });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "thinking_unavailable");
	assert.equal(allCalls, 1);
	assert.equal(availableCalls, 1);
	assert.equal(JSON.stringify(config), before);
});

test("user overlay owns concurrency without replacing unmentioned packaged routes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-user-overlay-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "csheng-subagents.json"), JSON.stringify({
		maxConcurrency: 12,
		routes: {
			explorer: { maxConcurrency: 5 },
			reviewer: { maxConcurrency: 3 },
			worker: { maxConcurrency: 4 },
		},
	}));
	const loaded = await loadConfig(root);
	assert.equal(loaded.config?.maxConcurrency, 12);
	assert.equal(loaded.config?.routes.explorer.maxConcurrency, 5);
	assert.equal(loaded.config?.routes.reviewer.maxConcurrency, 3);
	assert.equal(loaded.config?.routes.worker.maxConcurrency, 4);
	assert.equal(loaded.config?.routes.explorer.source, "package-default");
	assert.equal(loaded.config?.routes.worker.candidates[0]?.model, "openai-codex/gpt-5.6-terra");
});

test("all default role routes ignore cycling membership and thinking pins", () => {
	const config = configuredRoutes([fast, fast, fast]);
	for (const role of ["explorer", "reviewer", "worker"] as const) {
		for (const subset of [[{ model: parent }], [{ model: fast, thinkingLevel: "high" }]]) {
			const result = resolveRoute(role, config, context([parent, fast], subset));
			assert.equal(result.ok, true);
			if (result.ok) {
				assert.equal(result.route.model, "fast");
				assert.equal(result.route.thinking, "low");
			}
		}
	}
});

test("parent and semantic-profile routes use all accessible models", () => {
	const inherited = resolveRoute("worker", defaultConfig(), context([parent, fast], [{ model: fast }]));
	assert.equal(inherited.ok, true);
	if (inherited.ok) assert.equal(inherited.route.model, "parent");
	const config = parseConfig({
		reasoningProfiles: { deep: "high" },
		routes: { explorer: {
			candidates: [{ model: "synthetic/fast", thinking: "low" }],
			executionProfiles: { deep: { candidates: [{ model: "synthetic/deep", thinking: "medium" }] } },
		} },
	});
	const profiled = resolveRoute("explorer", config, context([parent, fast, deep], [{ model: parent }]), {
		executionProfile: "deep", reasoningProfile: "deep",
	});
	assert.equal(profiled.ok, true);
	if (profiled.ok) {
		assert.equal(profiled.route.model, "deep");
		assert.equal(profiled.route.thinking, "high");
	}
});

test("default routes still reject inaccessible models and unsupported thinking", () => {
	const config = configuredRoutes([fast, fast, fast]);
	const unavailable = context([fast], [], new Set<string>());
	const unsupported = context([{ ...fast, thinkingLevelMap: { low: null } }]);
	const noReasoning = context([{ ...fast, reasoning: false }]);
	for (const ctx of [unavailable, unsupported, noReasoning]) {
		const result = resolveRoute("reviewer", config, ctx);
		assert.deepEqual(result, {
			ok: false,
			error: {
				code: "route_unavailable",
				message: "No configured reviewer route has an available model and supported thinking level.",
			},
		});
	}
});

test("configuration accepts user concurrency and rejects invalid values or unknown fields", () => {
	const config = parseConfig({
		maxConcurrency: 12,
		routes: {
			explorer: { maxConcurrency: 5 },
			reviewer: { maxConcurrency: 3 },
			worker: { maxConcurrency: 4 },
		},
	});
	assert.equal(config.maxConcurrency, 12);
	assert.equal(config.routes.explorer.maxConcurrency, 5);
	assert.equal(config.routes.reviewer.maxConcurrency, 3);
	assert.equal(config.routes.worker.maxConcurrency, 4);
	assert.throws(() => parseConfig({ maxConcurrency: 0 }), /positive safe integer/);
	assert.throws(() => parseConfig({ routes: { explorer: { maxConcurrency: 1.5 } } }), /positive safe integer/);
	assert.throws(() => parseConfig({ routes: { worker: { maxConcurrency: Number.MAX_SAFE_INTEGER + 1 } } }), /positive safe integer/);
	assert.throws(() => parseConfig({ model: "synthetic/fast" }), /unsupported fields/);
	assert.throws(() => parseConfig({ reasoningProfiles: { extreme: "max" } }), /unsupported fields/);
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
	const parsed = parseConfig(value, { source: "package-default" });
	assert.equal(parsed.routes.worker.source, "package-default");
});
