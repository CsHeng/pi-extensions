import type { EffectiveRoute, RoleName, TaskError } from "./contracts.ts";
import type { EffectiveSubagentConfig } from "./config.ts";

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

export type RouteResolution =
	| { ok: true; route: EffectiveRoute; model: RouteModel }
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

export function resolveRoute(role: RoleName, config: EffectiveSubagentConfig, context: RouteContext): RouteResolution {
	const roleRoute = config.routes[role];
	for (let index = 0; index < roleRoute.candidates.length; index += 1) {
		const candidate = roleRoute.candidates[index];
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

		const thinking = candidate.thinking === "$parent" ? context.parentThinking : candidate.thinking;
		if (!thinking || !supportsThinking(model, thinking)) continue;
		if (scoped?.thinkingLevel !== undefined && scoped.thinkingLevel !== thinking) continue;

		return {
			ok: true,
			model,
			route: {
				provider: model.provider,
				model: model.id,
				thinking,
				source: roleRoute.source,
				candidateIndex: index,
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
