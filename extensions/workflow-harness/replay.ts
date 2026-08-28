import { cloneSessionState, isHarnessSessionState, SESSION_ENTRY_TYPE, type HarnessSessionStateV1 } from "./session-state.ts";

export interface CustomEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

export function sessionEntry(state: HarnessSessionStateV1): CustomEntry {
	return { type: "custom", customType: SESSION_ENTRY_TYPE, data: cloneSessionState(state) };
}

export function replaySessionState(entries: readonly unknown[]): HarnessSessionStateV1 | undefined {
	let state: HarnessSessionStateV1 | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || (entry as Record<string, unknown>).type !== "custom" || (entry as Record<string, unknown>).customType !== SESSION_ENTRY_TYPE) continue;
		if (!isHarnessSessionState((entry as Record<string, unknown>).data)) throw new Error("invalid newest workflow session entry; replay is blocked");
		state = cloneSessionState((entry as Record<string, unknown>).data as HarnessSessionStateV1);
	}
	return state;
}

export function schedulePendingChild(state: HarnessSessionStateV1, pending: NonNullable<HarnessSessionStateV1["pendingChild"]>): HarnessSessionStateV1 {
	if (state.pendingChild?.dispatchId === pending.dispatchId) return cloneSessionState(state);
	if (state.pendingChild) throw new Error("another child dispatch is pending");
	return { ...cloneSessionState(state), pendingChild: structuredClone(pending) };
}

export function markPendingChildDispatched(state: HarnessSessionStateV1, dispatchId: string): HarnessSessionStateV1 {
	if (state.pendingChild?.dispatchId !== dispatchId) throw new Error("child dispatch is stale or unknown");
	if (state.pendingChild.status === "dispatched") return cloneSessionState(state);
	return { ...cloneSessionState(state), pendingChild: { ...state.pendingChild, status: "dispatched" } };
}

export function completePendingChild(state: HarnessSessionStateV1, dispatchId: string): HarnessSessionStateV1 {
	if (state.pendingChild?.dispatchId !== dispatchId) throw new Error("child result is stale or unknown");
	return { ...cloneSessionState(state), pendingChild: null };
}
