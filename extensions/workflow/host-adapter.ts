import type { InputSource } from "@earendil-works/pi-coding-agent";

/** Only native interactive/RPC input renews the opportunity for a task reminder. */
export function isUserInputSource(source: InputSource): boolean {
	return source === "interactive" || source === "rpc";
}
