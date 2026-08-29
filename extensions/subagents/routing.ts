import type {
	EffectiveRoute,
	ExecutionProfile,
	ReasoningProfile,
	RoleName,
	TaskError,
} from "./contracts.ts";
import type { EffectiveSubagentConfig, RouteCandidateConfig } from "./config.ts";

export interface RouteModel {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export interface RouteRegistry {
	find(provider: string, modelId: string): RouteModel | undefined;
	hasConfiguredAuth(model: RouteModel): boolean;
}

export interface RouteContext {
	parentModel?: RouteModel;
	parentThinking?: string;
	scopedModels: readonly { model: RouteModel; thinkingLevel?: string }[];
	modelRegistry: RouteRegistry;
}

export interface TaskRouteProfiles {
	executionProfile?: ExecutionProfile;
	reasoningProfile?: ReasoningProfile;
}

export type RouteResolution =
	| { ok: true; route: EffectiveRoute }
	| { ok: false; error: TaskError };

function parseModelReference(reference: string): { provider: string; model: string } | undefined {
	const separator = reference.indexOf("/");
	if (separator < 1 || separator === reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), model: reference.slice(separator + 1) };
}

function supportsThinking(model: RouteModel, thinking: string): boolean {
	if (thinking === "off") return true;
	if (model.reasoning === false) return false;
	if (model.thinkingLevelMap && thinking in model.thinkingLevelMap) {
		return model.thinkingLevelMap[thinking] !== null;
	}
	return true;
}

function resolveThinking(candidate: RouteCandidateConfig, profileThinking: string | undefined, context: RouteContext): string | undefined {
	const configured = profileThinking ?? candidate.thinking;
	return configured === "$parent" ? context.parentThinking : configured;
}

export function resolveRoute(
	role: RoleName,
	config: EffectiveSubagentConfig,
	context: RouteContext,
	profiles: TaskRouteProfiles = {},
): RouteResolution {
	const roleRoute = config.routes[role];
	const executionRoute = profiles.executionProfile === undefined ? undefined : roleRoute.executionProfiles[profiles.executionProfile];
	const candidates = executionRoute?.candidates ?? roleRoute.candidates;
	const reasoningThinking = profiles.reasoningProfile === undefined ? undefined : config.reasoningProfiles[profiles.reasoningProfile];
	const profileFallbacks: EffectiveRoute["profileFallbacks"] = [];
	if (profiles.executionProfile !== undefined && executionRoute === undefined) profileFallbacks.push("execution-role-default");
	if (profiles.reasoningProfile !== undefined && reasoningThinking === undefined) profileFallbacks.push("reasoning-role-default");

	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const reference = candidate.model === "$parent"
			? context.parentModel && { provider: context.parentModel.provider, model: context.parentModel.id }
			: parseModelReference(candidate.model);
		if (!reference) continue;
		const model = context.modelRegistry.find(reference.provider, reference.model);
		if (!model || !context.modelRegistry.hasConfiguredAuth(model)) continue;

		const scoped = context.scopedModels.length === 0
			? undefined
			: context.scopedModels.find((item) => item.model.provider === model.provider && item.model.id === model.id);
		if (context.scopedModels.length > 0 && !scoped) continue;

		const thinking = resolveThinking(candidate, reasoningThinking, context);
		if (!thinking || !supportsThinking(model, thinking)) continue;
		if (scoped?.thinkingLevel !== undefined && scoped.thinkingLevel !== thinking) continue;

		const reasoningSource = profiles.reasoningProfile === undefined
			? undefined
			: config.reasoningProfileSources[profiles.reasoningProfile];
		return {
			ok: true,
			route: {
				provider: model.provider,
				model: model.id,
				thinking,
				source: reasoningSource ?? executionRoute?.source ?? roleRoute.source,
				candidateIndex: index,
				...(profiles.executionProfile === undefined ? {} : { executionProfileRequested: profiles.executionProfile }),
				executionProfileApplied: executionRoute !== undefined,
				...(profiles.reasoningProfile === undefined ? {} : { reasoningProfileRequested: profiles.reasoningProfile }),
				reasoningProfileApplied: reasoningThinking !== undefined,
				profileFallbacks,
			},
		};
	}
	return {
		ok: false,
		error: {
			code: "route_unavailable",
			message: `No configured ${role} route is available inside the active model scope.`,
		},
	};
}
