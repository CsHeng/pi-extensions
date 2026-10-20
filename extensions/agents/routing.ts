import type {
	EffectiveRoute,
	ExecutionProfile,
	ThinkingProfile,
	RoleName,
	TaskError,
	ThinkingLevel,
} from "./contracts.ts";
import type { EffectiveSubagentConfig, RouteCandidateConfig } from "./config.ts";

export interface RouteModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** Full public catalogue and authenticated availability, independent of the UI cycling subset. */
export interface RouteRegistry {
	getAll(): readonly RouteModel[];
	getAvailable(): readonly RouteModel[];
}

export interface RouteContext {
	parentModel?: RouteModel;
	parentThinking?: string;
	modelRegistry: RouteRegistry;
}

export interface TaskRouteProfiles {
	executionProfile?: ExecutionProfile;
	thinkingProfile?: ThinkingProfile;
	model?: string;
	thinking?: ThinkingLevel;
}

export type RouteResolution =
	| { ok: true; route: EffectiveRoute }
	| { ok: false; error: TaskError };

function parseModelReference(reference: string): { provider: string; model: string } | undefined {
	const separator = reference.indexOf("/");
	if (separator < 1 || separator === reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), model: reference.slice(separator + 1) };
}

function canonicalModel(model: RouteModel): string {
	return `${model.provider}/${model.id}`;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueCanonical(models: readonly RouteModel[]): RouteModel[] {
	const unique = new Map<string, RouteModel>();
	for (const model of models) {
		const canonical = canonicalModel(model);
		if (!unique.has(canonical)) unique.set(canonical, model);
	}
	return [...unique.values()];
}

function normalizeSelector(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function supportsThinking(model: RouteModel, thinking: string): boolean {
	if (thinking === "off") return true;
	if (model.reasoning === false) return false;
	if (model.thinkingLevelMap && thinking in model.thinkingLevelMap) {
		return model.thinkingLevelMap[thinking] !== null;
	}
	return true;
}

function resolveConfiguredThinking(
	candidate: RouteCandidateConfig,
	profileThinking: string | undefined,
	context: RouteContext,
): string | undefined {
	const configured = profileThinking ?? candidate.thinking;
	return configured === "$parent" ? context.parentThinking : configured;
}

function candidateSummary(models: readonly RouteModel[]): string {
	const candidates = [...new Set(models.map(canonicalModel))].sort(compareText);
	const shown = candidates.slice(0, 8);
	const omitted = candidates.length - shown.length;
	return omitted === 0 ? shown.join(", ") : `${shown.join(", ")} (${omitted} more omitted)`;
}

function explicitModelError(code: "model_unavailable" | "ambiguous_model", models: readonly RouteModel[]): TaskError {
	const candidates = candidateSummary(models);
	if (code === "ambiguous_model") {
		return {
			code,
			message: `Explicit model selector is ambiguous among available models: ${candidates}. Provide exact provider/model.`,
		};
	}
	return {
		code,
		message: `Explicit model selector matched model(s) that are not available: ${candidates}.`,
	};
}

function matchExplicitModel(
	selector: string,
	allModels: readonly RouteModel[],
	availableModels: readonly RouteModel[],
): { ok: true; model: RouteModel } | { ok: false; error: TaskError } {
	const all = uniqueCanonical(allModels);
	const canonicalSelector = selector.toLowerCase();
	const normalizedSelector = normalizeSelector(selector);
	const tiers = [
		all.filter((model) => canonicalModel(model).toLowerCase() === canonicalSelector),
		all.filter((model) => normalizeSelector(model.id) === normalizedSelector),
		all.filter((model) => model.name !== undefined && normalizeSelector(model.name) === normalizedSelector),
	];
	const matched = tiers.find((tier) => tier.length > 0);
	if (!matched) {
		return {
			ok: false,
			error: {
				code: "model_not_found",
				message: "Explicit model selector did not match any model in Pi's registry.",
			},
		};
	}

	const matchedCanonicals = new Set(matched.map(canonicalModel));
	const available = uniqueCanonical(availableModels)
		.filter((model) => matchedCanonicals.has(canonicalModel(model)))
		.sort((left, right) => compareText(canonicalModel(left), canonicalModel(right)));
	if (available.length === 0) return { ok: false, error: explicitModelError("model_unavailable", matched) };
	if (available.length > 1) return { ok: false, error: explicitModelError("ambiguous_model", available) };
	return { ok: true, model: available[0]! };
}

function thinkingUnavailable(message: string): RouteResolution {
	return { ok: false, error: { code: "thinking_unavailable", message } };
}

function resolveExplicitModelRoute(
	config: EffectiveSubagentConfig,
	context: RouteContext,
	profiles: TaskRouteProfiles,
	allModels: readonly RouteModel[],
	availableModels: readonly RouteModel[],
): RouteResolution {
	const matched = matchExplicitModel(profiles.model!, allModels, availableModels);
	if (!matched.ok) return matched;

	const profileThinking = profiles.thinkingProfile === undefined
		? undefined
		: config.thinkingProfiles[profiles.thinkingProfile];
	const thinking = profiles.thinking ?? profileThinking ?? context.parentThinking;
	if (!thinking || !supportsThinking(matched.model, thinking)) {
		return thinkingUnavailable(
			`The exact requested thinking level is unavailable for explicit model ${canonicalModel(matched.model)}.`,
		);
	}

	const profileApplied = profiles.thinking === undefined && profileThinking !== undefined;
	const profileFallbacks: EffectiveRoute["profileFallbacks"] = [];
	if (profiles.thinking === undefined && profiles.thinkingProfile !== undefined && profileThinking === undefined) {
		profileFallbacks.push("thinking-role-default");
	}
	const profileSource = profileApplied && profiles.thinkingProfile !== undefined
		? config.thinkingProfileSources[profiles.thinkingProfile]
		: undefined;

	return {
		ok: true,
		route: {
			provider: matched.model.provider,
			model: matched.model.id,
			thinking,
			source: profileSource ?? "parent",
			candidateIndex: 0,
			...(profiles.executionProfile === undefined ? {} : { executionProfileRequested: profiles.executionProfile }),
			executionProfileApplied: false,
			...(profiles.thinkingProfile === undefined ? {} : { thinkingProfileRequested: profiles.thinkingProfile }),
			thinkingProfileApplied: profileApplied,
			profileFallbacks,
			selectionSource: "explicit-task",
			modelOverrideRequested: true,
			thinkingOverrideRequested: profiles.thinking !== undefined,
		},
	};
}

export function resolveRoute(
	role: RoleName,
	config: EffectiveSubagentConfig,
	context: RouteContext,
	profiles: TaskRouteProfiles = {},
): RouteResolution {
	const allModels = context.modelRegistry.getAll();
	const availableModels = context.modelRegistry.getAvailable();
	if (profiles.model !== undefined) {
		return resolveExplicitModelRoute(config, context, profiles, allModels, availableModels);
	}

	const roleRoute = config.routes[role];
	const executionRoute = profiles.executionProfile === undefined ? undefined : roleRoute.executionProfiles[profiles.executionProfile];
	const candidates = executionRoute?.candidates ?? roleRoute.candidates;
	const mappedThinkingProfile = profiles.thinkingProfile === undefined ? undefined : config.thinkingProfiles[profiles.thinkingProfile];
	const profileThinking = profiles.thinking === undefined ? mappedThinkingProfile : undefined;
	const profileFallbacks: EffectiveRoute["profileFallbacks"] = [];
	if (profiles.executionProfile !== undefined && executionRoute === undefined) profileFallbacks.push("execution-role-default");
	if (profiles.thinking === undefined && profiles.thinkingProfile !== undefined && mappedThinkingProfile === undefined) {
		profileFallbacks.push("thinking-role-default");
	}

	const availableByCanonical = new Map(uniqueCanonical(availableModels).map((model) => [canonicalModel(model), model]));
	const allByCanonical = new Map(uniqueCanonical(allModels).map((model) => [canonicalModel(model), model]));
	let exactThinkingCandidateSeen = false;

	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const reference = candidate.model === "$parent"
			? context.parentModel && { provider: context.parentModel.provider, model: context.parentModel.id }
			: parseModelReference(candidate.model);
		if (!reference) continue;
		const canonical = `${reference.provider}/${reference.model}`;
		if (!allByCanonical.has(canonical)) continue;
		const model = availableByCanonical.get(canonical);
		if (!model) continue;

		const thinking = profiles.thinking ?? resolveConfiguredThinking(candidate, profileThinking, context);
		if (profiles.thinking !== undefined) exactThinkingCandidateSeen = true;
		if (!thinking || !supportsThinking(model, thinking)) continue;

		const profileApplied = profiles.thinking === undefined && mappedThinkingProfile !== undefined;
		const profileSource = profileApplied && profiles.thinkingProfile !== undefined
			? config.thinkingProfileSources[profiles.thinkingProfile]
			: undefined;
		return {
			ok: true,
			route: {
				provider: model.provider,
				model: model.id,
				thinking,
				source: profileSource ?? executionRoute?.source ?? roleRoute.source,
				candidateIndex: index,
				...(profiles.executionProfile === undefined ? {} : { executionProfileRequested: profiles.executionProfile }),
				executionProfileApplied: executionRoute !== undefined,
				...(profiles.thinkingProfile === undefined ? {} : { thinkingProfileRequested: profiles.thinkingProfile }),
				thinkingProfileApplied: profileApplied,
				profileFallbacks,
				selectionSource: "role-default",
				modelOverrideRequested: false,
				thinkingOverrideRequested: profiles.thinking !== undefined,
			},
		};
	}

	if (profiles.thinking !== undefined && exactThinkingCandidateSeen) {
		return thinkingUnavailable(`Thinking level ${profiles.thinking} is unavailable for configured ${role} routes.`);
	}
	return {
		ok: false,
		error: {
			code: "route_unavailable",
			message: `No configured ${role} route has an available model and supported thinking level.`,
		},
	};
}
