/**
 * Branch-local workflow persistence (WF-02).
 *
 * Pi owns the session JSONL. Every committed mutation appends one complete bounded snapshot as
 * a non-model custom entry before the in-memory projection is installed. Replay reads the
 * active branch and refuses to fall back to an older snapshot when the latest one is invalid.
 */
import {
	WORKFLOW_ENTRY_TYPE,
	WORKFLOW_LIMITS,
	WORKFLOW_SCHEMA_VERSION,
	type ReduceResult,
	type WorkflowOperation,
	type WorkflowSnapshot,
	type WorksetState,
} from "./contracts.ts";
import { applyOperation, buildView, validateState, type ReduceContext } from "./reducer.ts";

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface WorkflowStore {
	/** Current committed projection, or undefined before the first open. */
	current(): WorksetState | undefined;
	/** Non-empty when the latest snapshot could not be trusted; mutations stay disabled. */
	recovery(): string | undefined;
	/** Replay from the active branch (root to leaf). */
	replay(entries: readonly SessionEntryLike[]): void;
	/** Apply one operation; commits a snapshot before installing the new state. */
	apply(operation: WorkflowOperation, context: ReduceContext, toolCallId: string): ReduceResult;
	/** Observe committed changes/replay. A failed observer is removed without changing the commit. */
	subscribe(onChange: () => void, onError: () => void): () => void;
}

function validateSnapshot(data: unknown): { state: WorksetState } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "latest workflow snapshot is not an object" };
	const snapshot = data as Partial<WorkflowSnapshot>;
	if (snapshot.schemaVersion !== WORKFLOW_SCHEMA_VERSION) return { error: `unsupported workflow schema ${String(snapshot.schemaVersion)}` };
	if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision ?? 0) < 1) return { error: "workflow snapshot revision is invalid" };
	if (typeof snapshot.state !== "object" || snapshot.state === null) return { error: "workflow snapshot has no state" };
	const state = snapshot.state as WorksetState;
	if (state.revision !== snapshot.revision) return { error: `workflow snapshot revision ${snapshot.revision} does not match state revision ${state.revision}` };
	let bytes = 0;
	try {
		bytes = Buffer.byteLength(JSON.stringify(data));
	} catch {
		return { error: "workflow snapshot is not serializable" };
	}
	if (bytes > WORKFLOW_LIMITS.maxSnapshotBytes) return { error: `workflow snapshot exceeds ${WORKFLOW_LIMITS.maxSnapshotBytes} bytes` };
	const invalid = validateState(state);
	if (invalid) return { error: `workflow snapshot is invalid: ${invalid}` };
	if (typeof state.appliedCalls !== "object" || state.appliedCalls === null) return { error: "workflow snapshot has no call index" };
	return { state };
}

export function createWorkflowStore(sink: { append(customType: string, data: unknown): void }): WorkflowStore {
	let state: WorksetState | undefined;
	let recoveryError: string | undefined;
	const observers = new Set<{ onChange(): void; onError(): void }>();
	const notify = (): void => {
		for (const observer of observers) {
			try {
				observer.onChange();
			} catch {
				observers.delete(observer);
				// Presentation failure cannot invalidate a snapshot that has already committed.
				try { observer.onError(); } catch { /* The observer's error surface can also be unavailable. */ }
			}
		}
	};

	const apply = (operation: WorkflowOperation, context: ReduceContext, toolCallId: string): ReduceResult => {
		if (operation.operation === "inspect") return applyOperation(state, operation, context);
		if (recoveryError) {
			return {
				ok: false,
				code: "state_unavailable",
				message: `Workflow state is unavailable: ${recoveryError}`,
				...(state === undefined ? {} : { view: buildView(state) }),
			};
		}
		if (state && Object.hasOwn(state.appliedCalls, toolCallId)) {
			return { ok: true, state, view: buildView(state), notice: `Tool call ${toolCallId} was already applied at revision ${state.appliedCalls[toolCallId]}.` };
		}
		const result = applyOperation(state, operation, context);
		if (!result.ok) return result;
		const next = result.state;
		const appliedCalls = { ...next.appliedCalls, [toolCallId]: next.revision };
		const keys = Object.keys(appliedCalls);
		for (const key of keys.slice(0, Math.max(0, keys.length - WORKFLOW_LIMITS.maxAppliedCalls))) delete appliedCalls[key];
		next.appliedCalls = appliedCalls;
		const snapshot: WorkflowSnapshot = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: next.revision,
			transition: toolCallId,
			at: context.now,
			state: next,
		};
		let bytes = 0;
		try {
			bytes = Buffer.byteLength(JSON.stringify(snapshot));
		} catch {
			return { ok: false, code: "state_unavailable", message: "Workflow snapshot could not be serialized.", view: buildView(state ?? next) };
		}
		if (bytes > WORKFLOW_LIMITS.maxSnapshotBytes) {
			return {
				ok: false,
				code: "snapshot_limit",
				message: `Workflow snapshot would exceed ${WORKFLOW_LIMITS.maxSnapshotBytes} bytes; nothing was appended.`,
				view: buildView(state ?? next),
			};
		}
		try {
			sink.append(WORKFLOW_ENTRY_TYPE, snapshot);
		} catch (error) {
			return {
				ok: false,
				code: "state_unavailable",
				message: `Workflow snapshot could not be appended: ${error instanceof Error ? error.message : String(error)}`,
				...(state === undefined ? {} : { view: buildView(state) }),
			};
		}
		state = next;
		notify();
		return result;
	};

	return {
		current: () => state,
		recovery: () => recoveryError,
		subscribe(onChange, onError) {
			const observer = { onChange, onError };
			observers.add(observer);
			return () => { observers.delete(observer); };
		},
		replay(entries) {
			state = undefined;
			recoveryError = undefined;
			const snapshots = entries.filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_ENTRY_TYPE);
			const latest = snapshots.at(-1);
			if (!latest) { notify(); return; }
			let validated: { state: WorksetState } | { error: string };
			try {
				validated = validateSnapshot(latest.data);
			} catch (error) {
				validated = { error: `workflow snapshot could not be validated: ${error instanceof Error ? error.message : String(error)}` };
			}
			if ("error" in validated) recoveryError = validated.error;
			else state = validated.state;
			notify();
		},
		apply,
	};
}
