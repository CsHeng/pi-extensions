import type { DelegationGuidance } from "./config.ts";

/** Base delegation policy: batch shape and parent-owned closure, without a delegation trigger. */
export const BASE_DELEGATION_GUIDANCE = "Use a flat csheng_subagent_sessions create batch for independent bounded work. A single episode may complete the task; continuation is explicit. Parent owns synthesis, verification, acceptance, apply and close. File-dependent successors require explicit parent apply between dispatches; dependency edges pass reports, not candidate files.";

/**
 * Aggressive guidance adds the measured trigger: naming the condition under
 * which a parent should fan out before reading wide areas serially. Measured
 * effect and method: agent-architecture `docs/evaluations/pi-integration/`.
 */
export const AGGRESSIVE_DELEGATION_GUIDANCE = "Use csheng_subagent_sessions whenever a request needs evidence from three or more independent files, directories, modules or subsystems: submit one create batch with one explorer task per slice before reading them serially, then synthesize the reports.";

/** Delegation guidance bullets, or undefined when guidance is off. */
export function delegationGuidanceLines(guidance: DelegationGuidance): string[] | undefined {
	if (guidance === "off") return undefined;
	return guidance === "aggressive" ? [BASE_DELEGATION_GUIDANCE, AGGRESSIVE_DELEGATION_GUIDANCE] : [BASE_DELEGATION_GUIDANCE];
}
