import { DEFAULT_OBSERVATION_WAIT_SECONDS } from "../shared/observation-budget.ts";

/** Modes that can return from a bash call without ending the process. */
export const ASYNC_BASH_MODES = ["tui", "rpc"] as const;

export const BASH_EXECUTION_EVENT = "async-bash.execution";
export const BASH_OWNER = "pi-bash";

/** Finite default checkpoint for a job. A call can choose a longer representable value and renew the same process. */
export const DEFAULT_DEADLINE_SECONDS = 600;
/** Releases the tool call only. It is not an execution timeout. Omitted only; an explicit value is not capped. */
export const DEFAULT_FOREGROUND_SECONDS = 2;
/** Observation budget when waitSeconds is omitted. Expiry does not cancel or renew the execution. */
export const DEFAULT_WAIT_SECONDS = DEFAULT_OBSERVATION_WAIT_SECONDS;
export const OUTPUT_MAX_BYTES = 50 * 1024;

export type BashClaim = "claim" | "leave-native" | "other-owner";

/**
 * Claim builtin bash only in a mode that can keep the host alive.
 * Print/JSON stays on the native draining tool. Another extension's bash is left alone.
 */
export function bashClaim(mode: string, bashSource: string | undefined): BashClaim {
	if (mode !== "tui" && mode !== "rpc") return "leave-native";
	if (bashSource === undefined || bashSource !== "builtin") return bashSource === undefined ? "leave-native" : "other-owner";
	return "claim";
}
