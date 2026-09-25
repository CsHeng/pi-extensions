// Delegation probe fixture: registers exactly one mock subagent tool whose
// parent-visible surface is selected by environment variables, and launches no
// child process. It exists only for the provider-gated delegation probe lane
// (scripts/run-delegation-probe.ts) and is not part of the shipped package.
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGGRESSIVE_DELEGATION_GUIDANCE, BASE_DELEGATION_GUIDANCE } from "../../extensions/subagents/guidance.ts";
import { SubagentTaskSchema } from "../../extensions/subagents/contracts.ts";
import { SUBAGENT_SESSION_TOOL_NAME, SubagentSessionToolSchema, parseSessionRequest } from "../../extensions/subagents/session-contracts.ts";
import { SUBAGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_PROMPT_GUIDELINES, SUBAGENT_TOOL_PROMPT_SNIPPET } from "../../extensions/subagents/tool-surface.ts";

export const PROBE_SHAPE_ENV = "CSHENG_PROBE_SHAPE";
export const PROBE_GUIDANCE_ENV = "CSHENG_PROBE_GUIDANCE";
export const PROBE_TOOL_NAMES = [SUBAGENT_SESSION_TOOL_NAME, "Agent"] as const;

export type ProbeShape = "production" | "flat" | "agent-shape";
export type ProbeGuidance = "off" | "balanced" | "aggressive";

export const PROBE_SHAPES: readonly ProbeShape[] = ["production", "flat", "agent-shape"];
export const PROBE_GUIDANCE_LEVELS: readonly ProbeGuidance[] = ["off", "balanced", "aggressive"];

/** The flat shape is derived from the production task object, not copied, so it cannot drift from the real fields. */
export const FLAT_SHAPE_PARAMETERS = Type.Pick(SubagentTaskSchema, ["objective", "role", "repository", "scope", "inputs", "writePaths", "verification"]);

/** External reference shape only; it corresponds to no production contract and is never derived. */
export const AGENT_SHAPE_PARAMETERS = Type.Object({
	description: Type.String({ minLength: 1, description: "A short (3-5 word) description of the task" }),
	prompt: Type.String({ minLength: 1, description: "The task for the agent to perform" }),
	subagent_type: Type.Optional(Type.String({ minLength: 1, description: "The type of specialized agent to use for this task" })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Optional model override" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run this agent in the background" })),
}, { additionalProperties: false });

const AGENT_SHAPE_DESCRIPTION = "Launch a new agent to handle complex, multi-step tasks autonomously. The agent has access to the same tools as you and returns a single final report when it finishes.";
const AGENT_SHAPE_SNIPPET = "Launch a subagent with description/prompt/subagent_type for independent research or parallel work";
const AGENT_SHAPE_GUIDELINES = ["Use Agent when a task needs broad exploration across several files or when independent work can run in parallel; give it a self-contained prompt."];

export function parseProbeShape(value: string | undefined): ProbeShape {
	const shape = (value ?? "production") as ProbeShape;
	if (!PROBE_SHAPES.includes(shape)) throw new Error(`unknown probe shape: ${value}`);
	return shape;
}

export function parseProbeGuidance(value: string | undefined): ProbeGuidance {
	const guidance = (value ?? "aggressive") as ProbeGuidance;
	if (!PROBE_GUIDANCE_LEVELS.includes(guidance)) throw new Error(`unknown probe guidance: ${value}`);
	return guidance;
}

/** Mirrors the production level mapping: off injects nothing, balanced the base text, aggressive adds the trigger. */
export function probeGuidanceLines(guidance: ProbeGuidance): string[] {
	if (guidance === "off") return [];
	return guidance === "aggressive" ? [BASE_DELEGATION_GUIDANCE, AGGRESSIVE_DELEGATION_GUIDANCE] : [BASE_DELEGATION_GUIDANCE];
}

export interface ProbeShapeDefinition {
	name: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: TSchema;
}

export function probeShapeDefinition(shape: ProbeShape): ProbeShapeDefinition {
	if (shape === "flat") {
		return { name: SUBAGENT_SESSION_TOOL_NAME, description: SUBAGENT_TOOL_DESCRIPTION, promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET, promptGuidelines: [...SUBAGENT_TOOL_PROMPT_GUIDELINES], parameters: FLAT_SHAPE_PARAMETERS };
	}
	if (shape === "agent-shape") {
		return { name: "Agent", description: AGENT_SHAPE_DESCRIPTION, promptSnippet: AGENT_SHAPE_SNIPPET, promptGuidelines: [...AGENT_SHAPE_GUIDELINES], parameters: AGENT_SHAPE_PARAMETERS };
	}
	return { name: SUBAGENT_SESSION_TOOL_NAME, description: SUBAGENT_TOOL_DESCRIPTION, promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET, promptGuidelines: [...SUBAGENT_TOOL_PROMPT_GUIDELINES], parameters: SubagentSessionToolSchema };
}

/** Lifecycle operations never request new task roles, even with invalid stray tasks. */
export function probeRequestedTasks(params: Record<string, unknown>): unknown[] {
	if (params.action !== undefined) return params.action === "create" && Array.isArray(params.tasks) ? params.tasks : [];
	return [params]; // Flat and external Agent reference shapes.
}

const receipt = (text: string) => ({ content: [{ type: "text" as const, text }], details: { probeFixture: true } });

export default function delegationProbe(pi: ExtensionAPI): void {
	const shape = parseProbeShape(process.env[PROBE_SHAPE_ENV]);
	const guidance = parseProbeGuidance(process.env[PROBE_GUIDANCE_ENV]);
	const definition = probeShapeDefinition(shape);
	pi.registerTool({
		...definition,
		label: "Subagent sessions",
		async execute(_id: string, params: Record<string, unknown>) {
			if (shape === "production") parseSessionRequest(params); // Mirror field validation, never execute a lifecycle action.
			const roles = probeRequestedTasks(params).map(value => { const task = value && typeof value === "object" ? value as Record<string, unknown> : {}; return task.role ?? task.subagent_type ?? "unknown"; });
			return receipt(`Probe fixture recorded the requested roles: ${JSON.stringify(roles)}. No child process was launched, no session or candidate exists, and no implementation was verified. This lane measures invocation decisions only; it provides no child report.`);
		},
	});
	const lines = probeGuidanceLines(guidance);
	if (lines.length === 0) return;
	pi.on("before_agent_start", async (event) => {
		const guidelines = event.systemPromptOptions?.promptGuidelines;
		if (Array.isArray(guidelines)) {
			for (const line of lines) if (!guidelines.includes(line)) guidelines.push(line);
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});
}
