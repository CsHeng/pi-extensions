import type { InputSource } from "@earendil-works/pi-coding-agent";

/** Pi 0.85.1 public contract:
 * - context is the model-preparation boundary, not input receipt or queue insertion.
 * - before_agent_start identifies ordinary preparation; native events expose queued occurrences
 *   but no queued source. Unknown origin never replenishes automatic-review credit.
 * - waitForIdle must be armed in a command context BEFORE settlement. Timers, isIdle and a
 *   waiter first registered during settlement are not barriers (see settlement.ts).
 */
export function isUserInputSource(source: InputSource): boolean {
	return source === "interactive" || source === "rpc";
}
