/**
 * Model-facing agent tools. The same static definitions serve the main session, where the hub
 * executes them, and a managed child, where the link forwards them to the hub. Text describes
 * function; whether and how to delegate or coordinate stays with the calling model.
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AGENT_NAME_PATTERN, AgentCapabilitiesSchema, EXECUTION_PROFILES, StringEnum, THINKING_LEVELS, THINKING_PROFILES, WORKSPACE_MODES } from "./contracts.ts";
import { MAX_PEER_MESSAGE_BYTES, PEER_TOOL_NAMES, type PeerOperation } from "./peer-protocol.ts";

const Name = Type.String({ pattern: AGENT_NAME_PATTERN, description: "Agent name: lowercase letters, digits and hyphens." });
const Access = Type.Array(Type.Object({
	permission: StringEnum(["read", "write"] as const),
	scope: Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })], { description: "Absolute path or list of absolute paths. Write includes read of that range." }),
}, { additionalProperties: false }), { minItems: 1, maxItems: 32, description: "Explicit read and write grants over absolute paths; one agent may write several Git repositories. An agent grants at most the access it holds." });

export const InvokeAgentSchema = Type.Object({
	name: Name,
	role: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$", description: "Role definition by name: explorer investigates, reviewer evaluates, worker implements; user and project definitions add others." }),
	prompt: Type.String({ minLength: 1, maxLength: 64 * 1024, description: "The assignment: outcome, context, constraints, checks to run, the peers and what each owns, and what to send to a peer or back to you." }),
	access: Access,
	workspace: Type.Optional(StringEnum(WORKSPACE_MODES, { description: "shared (default): writers edit the granted checkout directly and the result is the working-tree diff. isolated: a private copy whose changes return as one candidate, see agent_candidate." })),
	may: Type.Optional(AgentCapabilitiesSchema),
	executionProfile: Type.Optional(StringEnum(EXECUTION_PROFILES, { description: "Optional route preference: fast, balanced or deep; omit for the role default." })),
	thinkingProfile: Type.Optional(StringEnum(THINKING_PROFILES, { description: "Optional thinking effort: light, standard or deep." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Exact model for an explicit user choice; fails visibly when unavailable." })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Exact thinking level for an explicit user choice." })),
}, { additionalProperties: false });
export const MessageAgentSchema = Type.Object({
	to: Type.String({ minLength: 1, maxLength: 64, description: "Recipient name; \"main\" addresses the main agent." }),
	message: Type.String({ minLength: 1, maxLength: MAX_PEER_MESSAGE_BYTES }),
}, { additionalProperties: false });
export const ListAgentsSchema = Type.Object({
	name: Type.Optional(Name),
}, { additionalProperties: false });
export const WaitAgentsSchema = Type.Object({
	names: Type.Optional(Type.Array(Name, { minItems: 1, maxItems: 32, description: "Agents to wait for; default: the running agents you invoked." })),
	waitSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Observation budget, default 180 seconds. Expiry leaves the agents running." })),
}, { additionalProperties: false });
export const StopAgentSchema = Type.Object({
	name: Name,
	revert: Type.Optional(Type.Boolean({ description: "Shared writer only: after it stops, restore files whose content is still what its last turn left; other changes stay and are listed." })),
}, { additionalProperties: false });
export const ReleaseAgentSchema = Type.Object({
	name: Name,
	disposition: Type.Optional(StringEnum(["retain", "discard"] as const, { description: "retain (default) keeps its files and history; discard removes its private working files." })),
}, { additionalProperties: false });
export const AgentCandidateSchema = Type.Object({
	name: Name,
	action: StringEnum(["apply", "refresh", "discard"] as const, { description: "apply merges the candidate into the checkout; refresh merges current checkout files into the agent's private copy; discard drops the candidate together with the private copy and releases the agent." }),
}, { additionalProperties: false });

export type InvokeAgentArgs = Static<typeof InvokeAgentSchema>;
export type MessageAgentArgs = Static<typeof MessageAgentSchema>;
export type WaitAgentsArgs = Static<typeof WaitAgentsSchema>;
export type StopAgentArgs = Static<typeof StopAgentSchema>;
export type ReleaseAgentArgs = Static<typeof ReleaseAgentSchema>;
export type AgentCandidateArgs = Static<typeof AgentCandidateSchema>;

interface Surface { op: PeerOperation; name: string; label: string; description: string; snippet?: string; guidelines?: string[]; parameters: unknown }
export const PEER_TOOL_SURFACE: readonly Surface[] = [
	{ op: "invoke", name: PEER_TOOL_NAMES.invoke, label: "Invoke agent", parameters: InvokeAgentSchema,
		description: "Start an agent with a role, a name you choose, an assignment prompt and explicit access; it runs in the background and stays addressable by name until released. Writers share the granted checkout by default; workspace isolated gives one agent a private copy. may sets whom it can message, whether it sees the roster and whether it can invoke agents, with defaults from its role. Authority facts: a message from an agent is information or direction from that agent and never the user's approval; receiving a message leaves access unchanged; an agent grants at most the access it holds; the main agent and the user keep final acceptance. Trusted host tools run with host privileges; access grants are not an OS sandbox.",
		snippet: "Start a named agent (explorer, reviewer, worker or a defined role) with an assignment and explicit access; coordinate by name with message_agent, list_agents and wait_agents.",
		guidelines: [
			"An invoke returns once the agent is admitted; its turn result returns to whoever started that turn. While agents run, do other ready work or end the turn; their results reach you as notices.",
			"Name the peers and what each owns in each prompt when agents share a checkout, and say what goes to a peer and what comes back to you.",
			"Use message_agent to \"main\" for blockers, scope or authority decisions, or urgent cross-agent contract changes; deliver ordinary progress and consolidated review findings in the final turn report. Keep peer messages substantive and end exchanges once both sides have the facts they need.",
		] },
	{ op: "message", name: PEER_TOOL_NAMES.message, label: "Message agent", parameters: MessageAgentSchema,
		description: "Send a message to an agent by name, or to \"main\". A running agent reads it at its next model call after its current tool calls; an idle agent starts a new turn with it, and that turn's result returns to you. The recipient sees your name and role. Send mid-turn messages to \"main\" only for blockers, decisions, or urgent cross-agent discoveries; keep routine progress and batched findings for the final turn report." },
	{ op: "list", name: PEER_TOOL_NAMES.list, label: "List agents", parameters: ListAgentsSchema,
		description: "List agents with name, role, state, workspace, assigner and latest result summary. With a name, return that agent's latest full report when you invoked it (the main agent may read any)." },
	{ op: "wait", name: PEER_TOOL_NAMES.wait, label: "Wait for agents", parameters: WaitAgentsSchema,
		description: "Wait until the named agents finish their current turns, or until the budget expires while they keep running; returns the results that arrived. In the main session a waiting user steering message, a message for you or another notice returns early." },
	{ op: "stop", name: PEER_TOOL_NAMES.stop, label: "Stop agent", parameters: StopAgentSchema,
		description: "End an agent's current turn, or confirm that an agent interrupted by a host restart has stopped. The agent stays addressable until released. For a shared writer, revert restores only files its last turn wrote whose content is still what it left." },
	{ op: "release", name: PEER_TOOL_NAMES.release, label: "Release agent", parameters: ReleaseAgentSchema,
		description: "Close an idle agent's session. Its name stays bound to it in this session." },
	{ op: "candidate", name: PEER_TOOL_NAMES.candidate, label: "Agent candidate", parameters: AgentCandidateSchema,
		description: "Isolated workspace only: apply, refresh or discard the candidate of an agent invoked with workspace isolated. Apply proceeds only on the latest result you have been shown; when a newer turn finished, the result is shown instead and the checkout stays untouched." },
];

export interface PeerToolOutcome { text: string; details?: unknown; isError?: boolean }
export type PeerToolExecutor = (op: PeerOperation, args: Record<string, unknown>, signal: AbortSignal | undefined, toolCallId: string, ctx: Parameters<ToolDefinition["execute"]>[4]) => Promise<PeerToolOutcome>;

export function peerToolDefinitions(execute: PeerToolExecutor, include: (op: PeerOperation) => boolean = () => true): ToolDefinition[] {
	return PEER_TOOL_SURFACE.filter(surface => include(surface.op)).map(surface => ({
		name: surface.name, label: surface.label, description: surface.description,
		...(surface.snippet ? { promptSnippet: surface.snippet } : {}),
		...(surface.guidelines ? { promptGuidelines: surface.guidelines } : {}),
		parameters: surface.parameters as ToolDefinition["parameters"],
		async execute(toolCallId, args, signal, _onUpdate, ctx) {
			const outcome = await execute(surface.op, args as Record<string, unknown>, signal, toolCallId, ctx);
			if (outcome.isError) throw Object.assign(new Error(outcome.text), { details: outcome.details });
			return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
		},
	} as ToolDefinition));
}
