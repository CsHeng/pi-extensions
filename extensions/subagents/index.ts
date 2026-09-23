import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, sep } from "node:path";
import { loadConfig } from "./config.ts";
import { delegationGuidanceLines } from "./guidance.ts";
import { SUBAGENT_STATUS_COMMAND } from "./contracts.ts";
import { createProvenance, type ProvenanceCore } from "./provenance.ts";
import { resolveRoute, type RouteContext } from "./routing.ts";
import { registerObservationHooks } from "./observation-hooks.ts";
import { registerContinuationTool, type ContinuationDependencies } from "./continuation.ts";
import { SUBAGENT_SESSION_TOOL_NAME } from "./session-contracts.ts";

export interface SubagentDependencies extends Partial<ContinuationDependencies> {
	createProvenance?(): ProvenanceCore;
}
function routeContext(ctx: ExtensionContext): RouteContext {
	return {
		...(ctx.model === undefined ? {} : { parentModel: ctx.model as NonNullable<RouteContext["parentModel"]> }),
		...(ctx.thinkingLevel === undefined ? {} : { parentThinking: ctx.thinkingLevel }),
		modelRegistry: ctx.modelRegistry as unknown as RouteContext["modelRegistry"],
	};
}
export function createSubagentsExtension(dependencies: SubagentDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const config = dependencies.loadConfig ?? loadConfig;
		const provenance = dependencies.createProvenance?.() ?? dependencies.provenance ?? createProvenance();
		const observations = registerObservationHooks(pi, dependencies.now ? { now: dependencies.now } : {});
		let parentSkills: Skill[] | undefined;
		let parentSkillCwd: string | undefined;
		registerContinuationTool(pi, { ...dependencies, loadConfig: config, provenance, onRun: observations.recordRun,
			getParentSkills: sourceRoot => {
				if (!parentSkillCwd) return undefined;
				const path = relative(sourceRoot, parentSkillCwd);
				return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) ? parentSkills : undefined;
			},
		});
		pi.registerCommand(SUBAGENT_STATUS_COMMAND, {
			description: "Show managed subagent capabilities, routes and limits",
			handler: async (_args, ctx) => {
				const loaded = await config();
				if (!loaded.config) {
					ctx.ui.notify(`Subagents unavailable: ${loaded.diagnostic?.message ?? "invalid configuration"}`, "error");
					return;
				}
				const lines = [`tool=${SUBAGENT_SESSION_TOOL_NAME}`, `guidance=${loaded.config.guidance}`, `maxConcurrency=${loaded.config.maxConcurrency}`];
				for (const role of ["explorer", "reviewer", "worker"] as const) {
					const selected = resolveRoute(role, loaded.config, routeContext(ctx));
					lines.push(selected.ok
						? `${role}=${selected.route.provider}/${selected.route.model}:${selected.route.thinking} source=${selected.route.source} max=${loaded.config.routes[role].maxConcurrency} inheritSkills=${loaded.config.roles[role].inheritSkills}`
						: `${role}=unavailable max=${loaded.config.routes[role].maxConcurrency} inheritSkills=${loaded.config.roles[role].inheritSkills}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
		pi.on("before_agent_start", async (event, ctx) => {
			if (!pi.getActiveTools().includes(SUBAGENT_SESSION_TOOL_NAME)) return;
			if (Array.isArray(event.systemPromptOptions?.skills)) {
				parentSkills = event.systemPromptOptions.skills.map(skill => ({ ...skill, sourceInfo: { ...skill.sourceInfo } }));
				parentSkillCwd = ctx.cwd;
			}
			const loaded = await config();
			if (!loaded.config) return;
			const lines = delegationGuidanceLines(loaded.config.guidance);
			if (!lines) return;
			const guidelines = event.systemPromptOptions?.promptGuidelines;
			if (Array.isArray(guidelines)) {
				for (const line of lines) if (!guidelines.includes(line)) guidelines.push(line);
				return;
			}
			// Hosts without structured prompt options still receive the same text as one appended block.
			return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
		});
	};
}
export default createSubagentsExtension();
