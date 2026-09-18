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
	/** Prepare bounded operations privately, then commit once if the owner/revision is unchanged. */
	transact(expectedRevision: number, context: ReduceContext, toolCallId: string, run: (draft: WorkflowStore) => Promise<ReduceResult>, signal?: AbortSignal, canCommit?: () => boolean): Promise<ReduceResult>;
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
	let generation = 0;
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

	const preflight = (toolCallId: string): ReduceResult | undefined => {
		if (recoveryError) {
			return {
				ok: false,
				code: "state_unavailable",
				message: `Workflow state is unavailable: ${recoveryError}. Do not retry ledger operations or repair session history. Continue the user's task without workflow bookkeeping; repair the tool only if explicitly requested. Workflow completion cannot be certified.`,
				...(state === undefined ? {} : { view: buildView(state) }),
			};
		}
		if (state && Object.hasOwn(state.appliedCalls, toolCallId)) {
			return { ok: true, state, view: buildView(state), notice: `Tool call ${toolCallId} was already applied at revision ${state.appliedCalls[toolCallId]}.` };
		}
		return undefined;
	};

	const commit = (result: Extract<ReduceResult, { ok: true }>, context: ReduceContext, toolCallId: string): ReduceResult => {
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
		// Validate the final snapshot, including the just-added call index, with the same
		// reader used by replay. Never acknowledge a commit that a restart would reject.
		const validated = validateSnapshot(snapshot);
		if ("error" in validated) {
			return {
				ok: false,
				code: "state_unavailable",
				message: `Workflow snapshot was not appended: ${validated.error}`,
				...(state === undefined ? {} : { view: buildView(state) }),
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
		generation += 1;
		notify();
		return result;
	};

	const apply = (operation: WorkflowOperation, context: ReduceContext, toolCallId: string): ReduceResult => {
		if (operation.operation === "inspect" && !recoveryError) return applyOperation(state, operation, context);
		const prior = preflight(toolCallId);
		if (prior) return prior;
		const result = applyOperation(state, operation, context);
		return result.ok ? commit(result, context, toolCallId) : result;
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
			generation += 1;
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
		async transact(expectedRevision, context, toolCallId, run, signal, canCommit = () => true) {
			const prior = preflight(toolCallId);
			if (prior) return prior;
			if (!state) return { ok: false, code: "no_workset", message: "Open a workset before batching operations." };
			const failure = (code: "stale_revision" | "state_unavailable", message: string): ReduceResult => ({
				ok: false, code, message, ...(state ? { view: buildView(state) } : {}),
			});
			if (expectedRevision !== state.revision) return failure("stale_revision", `expectedRevision ${expectedRevision} is stale; the current revision is ${state.revision}.`);
			const owner = generation;
			const originalCalls = { ...state.appliedCalls };
			const draft = createWorkflowStore({ append() {} });
			draft.replay([{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: {
				schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: state.revision, state: structuredClone(state),
			} }]);
			if (signal?.aborted) return failure("state_unavailable", "Batch cancelled; nothing was committed.");
			const result = await run(draft);
			if (signal?.aborted) return failure("state_unavailable", "Batch cancelled; nothing was committed.");
			if (generation !== owner) return failure("stale_revision", "Workflow changed during batch preparation; nothing from this batch was committed. Inspect before resubmitting.");
			if (!canCommit()) return failure("state_unavailable", "Input preparation became unrecorded during the batch; nothing was committed. Retry context preparation before advancing workflow.");
			if (!result.ok) return { ...result, view: buildView(state!), message: `${result.message} Batch rolled back; nothing was committed.` };
			// Intermediate draft call identities are not durable host calls.
			result.state.appliedCalls = originalCalls;
			return commit(result, context, toolCallId);
		},
	};
}
