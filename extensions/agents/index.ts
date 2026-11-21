import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, sep } from "node:path";
import { loadConfig } from "./config.ts";
import { AGENT_STATUS_COMMAND } from "./contracts.ts";
import { createProvenance, type ProvenanceCore } from "./provenance.ts";
import { resolveRoleRoute, resolveRoute, type RouteContext } from "./routing.ts";
import { registerObservationHooks } from "./observation-hooks.ts";
import { defaultEnclosingCapability, registerContinuationTool, type ContinuationDependencies } from "./continuation.ts";
import { PEER_TOOL_NAMES } from "./peer-protocol.ts";
import { loadRoleDefinitions } from "./role-definitions.ts";
import { findCanonicalGitRoot } from "./repository-policy.ts";

export interface AgentDependencies extends Partial<ContinuationDependencies> {
	createProvenance?(): ProvenanceCore;
}
function routeContext(ctx: ExtensionContext): RouteContext {
	return {
		...(ctx.model === undefined ? {} : { parentModel: ctx.model as NonNullable<RouteContext["parentModel"]> }),
		...(ctx.thinkingLevel === undefined ? {} : { parentThinking: ctx.thinkingLevel }),
		modelRegistry: ctx.modelRegistry as unknown as RouteContext["modelRegistry"],
	};
}
export function createAgentsExtension(dependencies: AgentDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const config = dependencies.loadConfig ?? loadConfig;
		const provenance = dependencies.createProvenance?.() ?? dependencies.provenance ?? createProvenance();
		const observations = registerObservationHooks(pi, dependencies.now ? { now: dependencies.now } : {});
		let parentSkills: Skill[] | undefined;
		let parentSkillCwd: string | undefined;
		registerContinuationTool(pi, { ...dependencies, enclosingCapability: dependencies.enclosingCapability ?? defaultEnclosingCapability, loadConfig: config, provenance, onRun: observations.recordRun,
			getParentSkills: sourceRoot => {
				if (!parentSkillCwd) return undefined;
				const path = relative(sourceRoot, parentSkillCwd);
				return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) ? parentSkills : undefined;
			},
		});
		pi.registerCommand(AGENT_STATUS_COMMAND, {
			description: "Show Agent capabilities, routes and limits",
			handler: async (_args, ctx) => {
				const loaded = await config();
				if (!loaded.config) {
					ctx.ui.notify(`Agents unavailable: ${loaded.diagnostic?.message ?? "invalid configuration"}`, "error");
					return;
				}
				const lines = [`tools=${Object.values(PEER_TOOL_NAMES).join(",")}`, `routes=${loaded.source?.userFile ?? "package-default"}`, `maxConcurrency=${loaded.config.maxConcurrency}`];
				const projectRoot = await findCanonicalGitRoot(ctx.cwd).catch(() => undefined);
				const catalog = await loadRoleDefinitions({ agentDir: getAgentDir(), ...(projectRoot ? { projectRoot } : {}), trusted: ctx.isProjectTrusted() });
				for (const [role, definition] of [...catalog.roles].sort(([left], [right]) => left < right ? -1 : 1)) {
					const selected = resolveRoute(role, loaded.config, routeContext(ctx), {}, definition);
					const max = resolveRoleRoute(role, loaded.config, definition).route.maxConcurrency;
					lines.push(selected.ok
						? `${role} (${definition.source})=${selected.route.provider}/${selected.route.model}:${selected.route.thinking} source=${selected.route.source}${selected.route.roleRouteFallback ? ` routeFallback=${selected.route.roleRouteFallback}` : ""} max=${max} workspace=${definition.workspace} inheritSkills=${loaded.config.roles[role]?.inheritSkills ?? true}`
						: `${role} (${definition.source})=unavailable max=${max}`);
				}
				for (const problem of catalog.problems) lines.push(`role problem: ${problem.reason}`);
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
		pi.on("before_agent_start", async (event, ctx) => {
			if (!pi.getActiveTools().includes(PEER_TOOL_NAMES.invoke)) return;
			if (Array.isArray(event.systemPromptOptions?.skills)) {
				parentSkills = event.systemPromptOptions.skills.map(skill => ({ ...skill, sourceInfo: { ...skill.sourceInfo } }));
				parentSkillCwd = ctx.cwd;
			}
		});
	};
}
export default createAgentsExtension();
