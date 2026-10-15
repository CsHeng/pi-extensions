import { durationMsFromSeconds } from "./duration-timer.ts";

/** Omitted observation budgets are bounded; explicit finite budgets are not product-capped. */
export const DEFAULT_OBSERVATION_WAIT_SECONDS = 180;

export function observationWaitMilliseconds(seconds = DEFAULT_OBSERVATION_WAIT_SECONDS): number {
 return seconds === 0 ? 0 : durationMsFromSeconds(seconds, DEFAULT_OBSERVATION_WAIT_SECONDS);
}
