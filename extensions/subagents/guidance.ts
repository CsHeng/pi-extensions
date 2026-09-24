import type { DelegationGuidance } from "./config.ts";

/** Base delegation policy: batch shape and parent-owned closure, without a delegation trigger. */
export const BASE_DELEGATION_GUIDANCE = "Use a flat csheng_subagent_sessions create batch for independent bounded work. A single episode may complete the task; continuation is explicit. Parent owns synthesis, verification, acceptance, apply and close. File-dependent successors require explicit parent apply between dispatches; dependency edges pass reports, not candidate files.";

/**
 * Aggressive guidance encourages substantive independent work without a
 * file-count trigger or a mandatory investigation round.
 */
export const AGGRESSIVE_DELEGATION_GUIDANCE = "Delegate substantive independent investigation, implementation or review when the available context makes its separate result useful. Keep quick known-path reads and tightly coupled small edits local; batch ready independent slices and synthesize their results. Do not add a sizing call or mandatory explorer round merely to decide whether to delegate.";

/** Delegation guidance bullets, or undefined when guidance is off. */
export function delegationGuidanceLines(guidance: DelegationGuidance): string[] | undefined {
	if (guidance === "off") return undefined;
	return guidance === "aggressive" ? [BASE_DELEGATION_GUIDANCE, AGGRESSIVE_DELEGATION_GUIDANCE] : [BASE_DELEGATION_GUIDANCE];
}
