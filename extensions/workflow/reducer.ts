/**
 * Pure workflow reducer (WF-02).
 *
 * Code owns identity, revisions, coverage, readiness, transitions, invalidation and the
 * completion predicate. The main agent owns meaning: it declares goals, tasks, evidence
 * provenance and acceptance judgments. Every failure is typed and leaves the input state
 * untouched; callers append the returned state before installing it.
 */
import {
	WORKFLOW_LIMITS,
	WORKFLOW_SCHEMA_VERSION,
	type AcceptanceDecision,
	type AmendmentChange,
	type AmendmentRecord,
	type Attempt,
	type Criterion,
	type Deficit,
	type EvidenceBasis,
	type EvidenceRecord,
	type FailureResult,
	type ReduceResult,
	type SuccessResult,
	type Task,
	type WorkflowErrorCode,
	type WorkflowOperation,
	type WorkflowView,
	type Workset,
	type WorksetState,
} from "./contracts.ts";

export interface ReduceContext {
	now: string;
	cwd: string;
	sessionId: string;
}

export interface ViewDetail {
	kind: "task" | "criterion" | "attempt" | "evidence" | "decision" | "amendment";
	id: string;
}

class Reject extends Error {
	readonly code: WorkflowErrorCode;
	readonly deficits: Deficit[] | undefined;

	constructor(code: WorkflowErrorCode, message: string, deficits?: Deficit[]) {
		super(message);
		this.code = code;
		this.deficits = deficits;
	}
}

function reject(code: WorkflowErrorCode, message: string, deficits?: Deficit[]): never {
	throw new Reject(code, message, deficits);
}

function bounded(value: string, max: number, field: string): string {
	if (typeof value !== "string") reject("invalid_payload", `${field} must be a string`);
	if (value.length === 0) reject("invalid_payload", `${field} must not be empty`);
	if (value.length > max) reject("limit_exceeded", `${field} exceeds ${max} characters`);
	return value;
}

function boundedList(value: readonly string[] | undefined, max: number, field: string, itemMax: number): string[] {
	const list = value ?? [];
	if (!Array.isArray(list)) reject("invalid_payload", `${field} must be an array`);
	if (list.length > max) reject("limit_exceeded", `${field} exceeds ${max} items`);
	for (const item of list) bounded(item, itemMax, `${field} entry`);
	return [...list];
}

const clone = <T>(value: T): T => structuredClone(value);
const currentTasks = (state: WorksetState): Task[] => Object.values(state.tasks).filter((task) => task.worksetId === state.workset.id);
const currentCriteria = (state: WorksetState): Criterion[] => Object.values(state.criteria).filter((criterion) => criterion.worksetId === state.workset.id && criterion.retired === undefined);
const currentAttempts = (state: WorksetState): Attempt[] => Object.values(state.attempts).filter((attempt) => attempt.worksetId === state.workset.id);
const currentEvidence = (state: WorksetState): EvidenceRecord[] => Object.values(state.evidence).filter((evidence) => evidence.worksetId === state.workset.id);
const activeTask = (task: Task): boolean => task.disposition !== "superseded" && task.disposition !== "cancelled";

export function isTaskReady(state: WorksetState, task: Task): boolean {
	if (task.worksetId !== state.workset.id) return false;
	if (task.disposition !== "pending" && task.disposition !== "blocked") return false;
	return task.dependsOn.every((id) => state.tasks[id]?.disposition === "accepted" && hasCurrentAcceptance(state, state.tasks[id]!));
}

function hasCurrentAcceptance(state: WorksetState, subject: Task | Criterion): boolean {
	const decision = subject.decisionId === undefined ? undefined : state.decisions[subject.decisionId];
	if (!decision || decision.verdict !== "accepted" || decision.subject.id !== subject.id || decision.evidenceIds.length === 0) return false;
	return decision.evidenceIds.every((id) => {
		const evidence = state.evidence[id];
		return evidence?.worksetId === subject.worksetId && evidence.freshness === "current"
			&& evidence.basis.fingerprintState === "current" && evidence.subject.id === subject.id
			&& (decision.subject.kind === "task" ? evidence.revisions.taskRevision : evidence.revisions.criterionRevision) === subject.semanticRevision;
	});
}

export function computeDeficits(state: WorksetState): Deficit[] {
	const deficits: Deficit[] = [];
	if (state.workset.disposition !== "active") {
		deficits.push({ code: "workset_not_active", ids: [state.workset.id], message: `Workset ${state.workset.id} is ${state.workset.disposition}.` });
	}
	const { alignment, inputGeneration, goalRevision } = state.workset;
	if (alignment.state !== "aligned" || alignment.inputGeneration !== inputGeneration || alignment.goalRevision !== goalRevision) {
		deficits.push({
			code: "needs_alignment",
			ids: [state.workset.id],
			message: `Delivered input generation ${inputGeneration} is not aligned to goal revision ${goalRevision}.`,
		});
	}
	const requiredCriteria = currentCriteria(state).filter((criterion) => criterion.required);
	const unacceptedCriteria = requiredCriteria.filter((criterion) => criterion.disposition !== "accepted" || !hasCurrentAcceptance(state, criterion));
	if (unacceptedCriteria.length > 0) {
		deficits.push({
			code: "unaccepted_criteria",
			ids: unacceptedCriteria.map((criterion) => criterion.id),
			message: `Required criteria without a current acceptance: ${unacceptedCriteria.map((criterion) => `${criterion.id} (${criterion.disposition})`).join(", ")}`,
		});
	}
	const uncovered = unacceptedCriteria.filter((criterion) => !currentTasks(state).some((task) => activeTask(task) && task.covers.includes(criterion.id)));
	if (uncovered.length > 0) {
		deficits.push({
			code: "uncovered_criteria",
			ids: uncovered.map((criterion) => criterion.id),
			message: `Required criteria with no active task route: ${uncovered.map((criterion) => criterion.id).join(", ")}`,
		});
	}
	const unfinishedTasks = currentTasks(state).filter((task) => activeTask(task) && (task.disposition !== "accepted" || !hasCurrentAcceptance(state, task)));
	if (unfinishedTasks.length > 0) {
		deficits.push({
			code: "unaccepted_tasks",
			ids: unfinishedTasks.map((task) => task.id),
			message: `Tasks without a current acceptance: ${unfinishedTasks.map((task) => `${task.id} (${task.disposition})`).join(", ")}`,
		});
	}
	const openAttempts = currentAttempts(state).filter((attempt) => attempt.state === "running" || attempt.state === "unknown");
	if (openAttempts.length > 0) {
		deficits.push({
			code: "open_attempts",
			ids: openAttempts.map((attempt) => attempt.id),
			message: `Attempts without a resolved outcome: ${openAttempts.map((attempt) => `${attempt.id} (${attempt.state})`).join(", ")}`,
		});
	}
	if (!currentEvidence(state).some((evidence) => evidence.subject.kind === "workset" && evidence.freshness === "current")) {
		deficits.push({
			code: "missing_delivery_evidence",
			ids: [state.workset.id],
			message: "The declared delivery endpoint has no current evidence bound to the workset.",
		});
	}
	return state.workset.disposition === "closed" ? [] : deficits;
}

export function buildView(state: WorksetState, options: { detail?: ViewDetail } = {}): WorkflowView {
	const view: WorkflowView = {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: state.revision,
		workset: {
			id: state.workset.id,
			goal: state.workset.goal,
			goalRevision: state.workset.goalRevision,
			deliveryEndpoint: state.workset.deliveryEndpoint,
			disposition: state.workset.disposition,
			...(state.workset.closeOutcome === undefined ? {} : { closeOutcome: state.workset.closeOutcome }),
			alignment: state.workset.alignment,
			inputGeneration: state.workset.inputGeneration,
			reviewPolicy: state.workset.reviewPolicy,
		},
		criteria: currentCriteria(state).map((criterion) => ({
			id: criterion.id,
			outcome: criterion.outcome,
			required: criterion.required,
			semanticRevision: criterion.semanticRevision,
			disposition: criterion.disposition,
		})),
		tasks: currentTasks(state).map((task) => ({
			id: task.id,
			outcome: task.outcome,
			covers: task.covers,
			dependsOn: task.dependsOn,
			semanticRevision: task.semanticRevision,
			disposition: task.disposition,
			ready: isTaskReady(state, task),
			...(task.currentAttemptId === undefined ? {} : { currentAttemptId: task.currentAttemptId }),
			...(task.reason === undefined ? {} : { reason: task.reason }),
			...(task.lineage === undefined ? {} : { lineage: task.lineage }),
		})),
		attempts: currentAttempts(state).map((attempt) => ({
			id: attempt.id,
			taskId: attempt.taskId,
			state: attempt.state,
			taskRevision: attempt.taskRevision,
			transport: attempt.transport,
		})),
		evidence: currentEvidence(state).map((evidence) => ({
			id: evidence.id,
			subject: evidence.subject,
			provenance: evidence.provenance,
			freshness: evidence.freshness,
			result: evidence.check.result,
			identity: evidence.check.identity,
			recordedAt: evidence.recordedAt,
		})),
		deficits: computeDeficits(state),
	};
	if (options.detail) {
		const { kind, id } = options.detail;
		if (kind === "task") view.records = { tasks: [taskById(state, id)] };
		else if (kind === "criterion") view.records = { criteria: [criterionById(state, id)] };
		else if (kind === "attempt") {
			const attempt = state.attempts[id];
			if (!attempt) reject("unknown_reference", `Unknown attempt ${id}`);
			view.records = { attempts: [attempt] };
		} else if (kind === "evidence") {
			const evidence = state.evidence[id];
			if (!evidence) reject("unknown_reference", `Unknown evidence ${id}`);
			view.records = { evidence: [evidence] };
		} else if (kind === "decision") {
			const decision = state.decisions[id];
			if (!decision) reject("unknown_reference", `Unknown decision ${id}`);
			view.records = { decisions: [decision] };
		} else {
			const amendment = state.amendments[id];
			if (!amendment) reject("unknown_reference", `Unknown amendment ${id}`);
			view.records = { amendments: [amendment] };
		}
	}
	return view;
}

function assertAcyclic(tasks: readonly Task[]): void {
	const status = new Map<string, "visiting" | "done">();
	const byId = new Map(tasks.map((task) => [task.id, task] as const));
	const visit = (id: string, trail: string[]): void => {
		const current = status.get(id);
		if (current === "done") return;
		if (current === "visiting") reject("cycle", `Dependency cycle: ${[...trail, id].join(" -> ")}`);
		const task = byId.get(id);
		if (!task) return;
		status.set(id, "visiting");
		for (const dependency of task.dependsOn) visit(dependency, [...trail, id]);
		status.set(id, "done");
	};
	for (const task of tasks) visit(task.id, []);
}

function assertLimits(state: WorksetState): void {
	if (currentTasks(state).length > WORKFLOW_LIMITS.maxTasks) reject("limit_exceeded", `Task limit ${WORKFLOW_LIMITS.maxTasks} exceeded`);
	if (currentCriteria(state).length > WORKFLOW_LIMITS.maxCriteria) reject("limit_exceeded", `Criterion limit ${WORKFLOW_LIMITS.maxCriteria} exceeded`);
	if (Object.keys(state.attempts).length > WORKFLOW_LIMITS.maxAttempts) reject("limit_exceeded", `Attempt limit ${WORKFLOW_LIMITS.maxAttempts} exceeded`);
	if (Object.keys(state.evidence).length > WORKFLOW_LIMITS.maxEvidence) reject("limit_exceeded", `Evidence limit ${WORKFLOW_LIMITS.maxEvidence} exceeded`);
	if (Object.keys(state.decisions).length > WORKFLOW_LIMITS.maxDecisions) reject("limit_exceeded", `Decision limit ${WORKFLOW_LIMITS.maxDecisions} exceeded`);
	if (Object.keys(state.amendments).length > WORKFLOW_LIMITS.maxAmendments) reject("limit_exceeded", `Amendment limit ${WORKFLOW_LIMITS.maxAmendments} exceeded`);
}

/** Structural validation used on replay; returns an error string when a snapshot cannot be trusted. */
export function validateState(state: WorksetState): string | undefined {
	if (!state || typeof state !== "object") return "missing state";
	if (state.schemaVersion !== WORKFLOW_SCHEMA_VERSION) return `unsupported schema ${String(state.schemaVersion)}`;
	if (!Number.isSafeInteger(state.revision) || state.revision < 1) return "invalid revision";
	if (!state.workset || typeof state.workset.id !== "string" || state.workset.id.length === 0) return "missing workset";
	const collections = ["pastWorksets", "criteria", "tasks", "attempts", "evidence", "decisions", "amendments", "appliedCalls", "next"] as const;
	for (const key of collections) {
		const value = (state as unknown as Record<string, unknown>)[key];
		if (typeof value !== "object" || value === null || Array.isArray(value)) return `missing ${key}`;
	}
	if (!state.workset.alignment || !state.workset.review || !state.workset.reviewPolicy) return "missing workset bookkeeping";
	if (state.workset.alignment.deliveryUnavailable !== undefined && state.workset.alignment.deliveryUnavailable !== true) return "invalid delivery availability";
	for (const [name, value] of Object.entries(state.next)) if (!Number.isSafeInteger(value) || value < 0) return `invalid ${name} counter`;
	const counterIds: Array<[keyof WorksetState["next"], string[]]> = [
		["workset", [state.workset.id, ...Object.keys(state.pastWorksets)]],
		["criterion", Object.keys(state.criteria)],
		["task", Object.keys(state.tasks)],
		["attempt", Object.keys(state.attempts)],
		["evidence", Object.keys(state.evidence)],
		["decision", Object.keys(state.decisions)],
		["amendment", Object.keys(state.amendments)],
		["authority", (state.workset.authorityReferences ?? []).map((reference) => reference.id)],
	];
	for (const [name, ids] of counterIds) {
		if (!Object.hasOwn(state.next, name) || !Number.isSafeInteger(state.next[name]) || state.next[name] < 1) return `invalid ${name} counter`;
		let highest = 0;
		for (const id of ids) {
			const suffix = Number(id.slice(id.lastIndexOf("-") + 1));
			if (Number.isSafeInteger(suffix) && suffix > highest) highest = suffix;
		}
		if (state.next[name] <= highest) return `invalid ${name} counter below retained identity ${highest}`;
	}
	for (const [id, revision] of Object.entries(state.appliedCalls)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id) || !Number.isSafeInteger(revision)) return "invalid applied-call index";
	}
	if (Object.keys(state.tasks).length !== currentTasks(state).length && Object.keys(state.tasks).length === 0) return "missing tasks";
	for (const [id, workset] of Object.entries(state.pastWorksets)) {
		if (workset.id !== id) return `workset ${id} id mismatch`;
		if (workset.disposition !== "closed") return `past workset ${id} is not closed`;
	}
	const worksetIds = new Set<string>([state.workset.id, ...Object.keys(state.pastWorksets)]);
	for (const [id, task] of Object.entries(state.tasks)) {
		if (task.id !== id) return `task ${id} id mismatch`;
		if (!worksetIds.has(task.worksetId)) return `task ${id} references unknown workset`;
		if (task.worksetId !== state.workset.id && !state.pastWorksets[task.worksetId]) return `task ${id} references unknown workset`;
		for (const dependency of task.dependsOn) {
			const predecessor = state.tasks[dependency];
			if (!predecessor) return `task ${id} references unknown dependency ${dependency}`;
			if (predecessor.worksetId !== task.worksetId) return `task ${id} depends on another workset`;
		}
		for (const criterion of task.covers) if (!state.criteria[criterion]) return `task ${id} references unknown criterion ${criterion}`;
	}
	for (const [id, criterion] of Object.entries(state.criteria)) {
		if (criterion.id !== id) return `criterion ${id} id mismatch`;
		if (!worksetIds.has(criterion.worksetId)) return `criterion ${id} references unknown workset`;
		if (criterion.decisionId && !state.decisions[criterion.decisionId]) return `criterion ${id} references unknown decision`;
	}
	for (const [id, attempt] of Object.entries(state.attempts)) {
		if (attempt.id !== id) return `attempt ${id} id mismatch`;
		if (!state.tasks[attempt.taskId]) return `attempt ${id} references unknown task`;
		if (!worksetIds.has(attempt.worksetId)) return `attempt ${id} references unknown workset`;
	}
	for (const [id, evidence] of Object.entries(state.evidence)) {
		if (evidence.id !== id) return `evidence ${id} id mismatch`;
		if (!worksetIds.has(evidence.worksetId)) return `evidence ${id} references unknown workset`;
		if (evidence.subject.kind === "criterion" && !state.criteria[evidence.subject.id]) return `evidence ${id} references unknown criterion`;
		if (evidence.subject.kind === "task" && !state.tasks[evidence.subject.id]) return `evidence ${id} references unknown task`;
		if (evidence.subject.kind === "workset" && evidence.subject.id !== evidence.worksetId) return `evidence ${id} references another workset`;
		if (evidence.attemptId && !state.attempts[evidence.attemptId]) return `evidence ${id} references unknown attempt`;
	}
	for (const [id, decision] of Object.entries(state.decisions)) {
		if (decision.id !== id) return `decision ${id} id mismatch`;
		if (decision.subject.kind === "task" && !state.tasks[decision.subject.id]) return `decision ${id} references unknown task`;
		if (decision.subject.kind === "criterion" && !state.criteria[decision.subject.id]) return `decision ${id} references unknown criterion`;
		for (const evidenceId of decision.evidenceIds) if (!state.evidence[evidenceId]) return `decision ${id} references unknown evidence ${evidenceId}`;
	}
	try {
		assertAcyclic(currentTasks(state));
	} catch (error) {
		return error instanceof Error ? error.message : "dependency cycle";
	}
	return undefined;
}

function emptyState(): WorksetState {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 1,
		workset: undefined as unknown as Workset,
		pastWorksets: {},
		criteria: {},
		tasks: {},
		attempts: {},
		evidence: {},
		decisions: {},
		amendments: {},
		appliedCalls: {},
		next: { workset: 1, criterion: 1, task: 1, attempt: 1, evidence: 1, decision: 1, amendment: 1, authority: 1 },
	};
}

function idsOf(state: WorksetState, kind: keyof WorksetState["next"]): string[] {
	switch (kind) {
		case "workset": return [state.workset?.id, ...Object.keys(state.pastWorksets)].filter((id): id is string => typeof id === "string");
		case "criterion": return Object.keys(state.criteria);
		case "task": return Object.keys(state.tasks);
		case "attempt": return Object.keys(state.attempts);
		case "evidence": return Object.keys(state.evidence);
		case "decision": return Object.keys(state.decisions);
		case "amendment": return Object.keys(state.amendments);
		case "authority": return (state.workset?.authorityReferences ?? []).map((reference) => reference.id);
	}
}

/** Allocate the next bounded id, skipping any identity that a replayed snapshot already retains. */
function nextId(state: WorksetState, kind: keyof WorksetState["next"], prefix: string): string {
	let value = state.next[kind];
	if (!Number.isSafeInteger(value) || value < 1) reject("state_unavailable", `Invalid ${kind} allocation counter.`);
	const existing = new Set(idsOf(state, kind));
	while (existing.has(`${prefix}-${value}`)) {
		value += 1;
		if (!Number.isSafeInteger(value)) reject("limit_exceeded", `${kind} identity space exhausted.`);
	}
	if (!Number.isSafeInteger(value + 1)) reject("limit_exceeded", `${kind} identity space exhausted.`);
	state.next[kind] = value + 1;
	return `${prefix}-${value}`;
}

function requireRevision(state: WorksetState, expected: number): void {
	if (!Number.isSafeInteger(expected) || expected !== state.revision) {
		reject("stale_revision", `Expected revision ${expected}, current revision ${state.revision}. Re-inspect and retry.`);
	}
}

function isAligned(state: WorksetState): boolean {
	const { alignment, inputGeneration, goalRevision } = state.workset;
	return alignment.state === "aligned" && alignment.inputGeneration === inputGeneration && alignment.goalRevision === goalRevision;
}

function requireAlignment(state: WorksetState, alignInputGeneration?: number): void {
	if (isAligned(state)) return;
	if (alignInputGeneration !== undefined) {
		if (alignInputGeneration !== state.workset.inputGeneration) {
			reject("invalid_payload", `Alignment generation ${alignInputGeneration} does not match the delivered generation ${state.workset.inputGeneration}.`);
		}
		state.workset.alignment = { state: "aligned", inputGeneration: state.workset.inputGeneration, goalRevision: state.workset.goalRevision };
		return;
	}
	reject("needs_alignment", `Delivered input generation ${state.workset.inputGeneration} is not aligned to the current goal; align before mutating obligations.`);
}

function taskById(state: WorksetState, id: string): Task {
	const task = state.tasks[id];
	if (!task || task.worksetId !== state.workset.id) reject("unknown_reference", `Unknown task ${id}`);
	return task;
}

function criterionById(state: WorksetState, id: string): Criterion {
	const criterion = state.criteria[id];
	if (!criterion || criterion.worksetId !== state.workset.id) reject("unknown_reference", `Unknown criterion ${id}`);
	return criterion;
}

function markEvidenceStale(state: WorksetState, predicate: (evidence: EvidenceRecord) => boolean): string[] {
	const affected: string[] = [];
	for (const evidence of Object.values(state.evidence)) {
		if (evidence.freshness !== "current" || !predicate(evidence)) continue;
		evidence.freshness = "stale";
		affected.push(evidence.id);
	}
	// Loss of a binding invalidates its judgments, including criterion judgments supported by
	// a task attempt. Dependency invalidation is transitive; already-stale records end recursion.
	const changed = new Set(affected);
	for (const decision of Object.values(state.decisions)) {
		if (decision.verdict !== "accepted" || !decision.evidenceIds.some((id) => changed.has(id))) continue;
		decision.verdict = "unresolved_verification";
		if (decision.subject.kind === "task") {
			const task = state.tasks[decision.subject.id];
			if (task?.decisionId === decision.id) invalidateTaskAndDependents(state, [task.id], "supporting evidence became stale");
		} else {
			const criterion = state.criteria[decision.subject.id];
			if (criterion?.decisionId === decision.id) invalidateCriterionEvidence(state, criterion);
		}
	}
	return affected.sort();
}

interface Invalidation {
	tasks: string[];
	evidence: string[];
}

function invalidateTask(state: WorksetState, task: Task, reason: string | undefined): string[] {
	if (task.decisionId) {
		const decision = state.decisions[task.decisionId];
		if (decision) decision.verdict = "unresolved_verification";
		delete task.decisionId;
	}
	if (task.disposition === "accepted" || task.disposition === "awaiting_acceptance") task.disposition = "pending";
	// An execution that was authorized by a superseded contract cannot be reported or accepted afterwards.
	const fenced: string[] = [];
	for (const attempt of currentAttempts(state)) {
		if (attempt.taskId !== task.id) continue;
		if (attempt.state !== "interrupted") {
			attempt.state = "interrupted";
			attempt.endedAt = new Date().toISOString();
			attempt.outcome = reason ?? "invalidated by a semantic change to the task or one of its predecessors";
		}
		// Previously interrupted executions may already support a criterion; fence those bindings too.
		fenced.push(attempt.id);
	}
	if (task.disposition === "running") task.disposition = "pending";
	return fenced;
}

function invalidateTaskAndDependents(state: WorksetState, roots: readonly string[], reason?: string): Invalidation {
	const affectedTasks = new Set<string>();
	const fencedAttempts = new Set<string>();
	const queue = [...roots];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (affectedTasks.has(id)) continue;
		const task = state.tasks[id];
		if (!task) continue;
		affectedTasks.add(id);
		for (const attemptId of invalidateTask(state, task, reason)) fencedAttempts.add(attemptId);
		for (const candidate of currentTasks(state)) if (candidate.dependsOn.includes(id)) queue.push(candidate.id);
	}
	const evidence = new Set(markEvidenceStale(state, (record) => record.subject.kind === "task" && affectedTasks.has(record.subject.id)));
	for (const id of markEvidenceStale(state, (record) => record.attemptId !== undefined && fencedAttempts.has(record.attemptId))) evidence.add(id);
	return { tasks: [...affectedTasks].sort(), evidence: [...evidence].sort() };
}

function invalidateCriterionEvidence(state: WorksetState, criterion: Criterion): void {
	if (criterion.disposition === "accepted" || criterion.disposition === "stale") criterion.disposition = "unverified";
	if (criterion.decisionId) {
		const decision = state.decisions[criterion.decisionId];
		if (decision) decision.verdict = "unresolved_verification";
		delete criterion.decisionId;
	}
}

function openOperation(state: WorksetState | undefined, operation: Extract<WorkflowOperation, { operation: "open" }>, context: ReduceContext): ReduceResult {
	if (state && state.workset.disposition !== "closed") {
		if (state.workset.disposition === "paused") reject("workset_paused", `Workset ${state.workset.id} is paused; resume or close it before opening another.`);
		reject("workset_exists", `Workset ${state.workset.id} is ${state.workset.disposition}; close it before opening another.`);
	}
	const goal = bounded(operation.goal, WORKFLOW_LIMITS.maxGoal, "goal");
	const endpoint = bounded(operation.deliveryEndpoint, WORKFLOW_LIMITS.maxEndpoint, "deliveryEndpoint");
	const sourceReferences = boundedList(operation.sourceReferences, WORKFLOW_LIMITS.maxListItems, "sourceReferences", WORKFLOW_LIMITS.maxReference);
	if (!Array.isArray(operation.criteria) || operation.criteria.length === 0) reject("invalid_payload", "At least one acceptance criterion is required.");
	if (!Array.isArray(operation.tasks) || operation.tasks.length === 0) reject("invalid_payload", "At least one task is required.");
	if (operation.criteria.length > WORKFLOW_LIMITS.maxCriteria) reject("limit_exceeded", `Criterion limit ${WORKFLOW_LIMITS.maxCriteria} exceeded`);
	if (operation.tasks.length > WORKFLOW_LIMITS.maxTasks) reject("limit_exceeded", `Task limit ${WORKFLOW_LIMITS.maxTasks} exceeded`);
	const reviewLimit = operation.reviewPolicy?.maxAutomaticReviewsPerInputEpoch ?? 1;
	if (!Number.isSafeInteger(reviewLimit) || reviewLimit < 0 || reviewLimit > 1) {
		reject("invalid_payload", "Automatic review is bounded to the operator-owned default of one per delivered input generation; a model-supplied increase is not supported.");
	}

	const next = state ? clone(state) : emptyState();
	if (state) next.pastWorksets = { ...next.pastWorksets, [state.workset.id]: clone(state.workset) };
	const worksetId = nextId(next, "workset", "WS");
	const workset: Workset = {
		id: worksetId,
		goal,
		goalRevision: 1,
		sourceReferences,
		authorityReferences: [],
		deliveryEndpoint: endpoint,
		repository: { cwd: context.cwd, sessionId: context.sessionId },
		openedAt: context.now,
		disposition: "active",
		alignment: { state: operation.deliveryUnavailable ? "needs_alignment" : "aligned", inputGeneration: 0, goalRevision: 1, ...(operation.deliveryUnavailable ? { deliveryUnavailable: true as const } : {}) },
		inputGeneration: 0,
		reviewPolicy: { maxAutomaticReviewsPerInputEpoch: reviewLimit },
		review: { inputGeneration: 0, used: operation.deliveryUnavailable ? reviewLimit : 0 },
	};
	for (const reference of operation.authorityReferences ?? []) {
		workset.authorityReferences.push({
			id: nextId(next, "authority", "AUTH"),
			description: bounded(reference.description, WORKFLOW_LIMITS.maxReference, "authority description"),
			source: bounded(reference.source, WORKFLOW_LIMITS.maxReference, "authority source"),
			limits: bounded(reference.limits, WORKFLOW_LIMITS.maxReference, "authority limits"),
		});
	}
	next.workset = workset;
	next.revision = (state?.revision ?? 0) + 1;

	const mapping: Record<string, string> = {};
	const keyToCriterion = new Map<string, string>();
	for (const input of operation.criteria) {
		const key = bounded(input.key, WORKFLOW_LIMITS.maxKey, "criterion key");
		if (keyToCriterion.has(key)) reject("duplicate_key", `Duplicate criterion key ${key}`);
		const id = nextId(next, "criterion", "AC");
		keyToCriterion.set(key, id);
		mapping[key] = id;
		next.criteria[id] = {
			id,
			worksetId,
			outcome: bounded(input.outcome, WORKFLOW_LIMITS.maxOutcome, "criterion outcome"),
			verification: bounded(input.verification, WORKFLOW_LIMITS.maxVerification, "criterion verification"),
			required: input.required ?? true,
			semanticRevision: 1,
			disposition: "unverified",
		};
	}
	const keyToTask = new Map<string, string>();
	for (const input of operation.tasks) {
		const key = bounded(input.key, WORKFLOW_LIMITS.maxKey, "task key");
		if (keyToTask.has(key)) reject("duplicate_key", `Duplicate task key ${key}`);
		const id = nextId(next, "task", "T");
		keyToTask.set(key, id);
		mapping[key] = id;
		next.tasks[id] = {
			id,
			worksetId,
			outcome: bounded(input.outcome, WORKFLOW_LIMITS.maxOutcome, "task outcome"),
			semanticRevision: 1,
			covers: [],
			...(input.enablingPurpose === undefined ? {} : { enablingPurpose: bounded(input.enablingPurpose, WORKFLOW_LIMITS.maxOutcome, "enablingPurpose") }),
			dependsOn: [],
			repositoryOwner: bounded(input.repositoryOwner ?? context.cwd, WORKFLOW_LIMITS.maxReference, "repositoryOwner"),
			writeSurface: boundedList(input.writeSurface, WORKFLOW_LIMITS.maxWriteSurface, "writeSurface", WORKFLOW_LIMITS.maxReference),
			executionConstraints: boundedList(input.executionConstraints, WORKFLOW_LIMITS.maxListItems, "executionConstraints", WORKFLOW_LIMITS.maxReference),
			disposition: "pending",
		};
	}
	for (const input of operation.tasks) {
		const task = next.tasks[keyToTask.get(input.key)!]!;
		task.covers = (input.covers ?? []).map((criterionKey) => keyToCriterion.get(criterionKey) ?? criterionById(next, criterionKey).id);
		task.dependsOn = (input.dependsOn ?? []).map((taskKey) => keyToTask.get(taskKey) ?? taskById(next, taskKey).id);
	}
	for (const task of currentTasks(next)) {
		if (task.covers.length === 0 && !task.enablingPurpose) reject("invalid_payload", `Task ${task.id} has no criterion coverage and no enabling purpose.`);
		for (const criterion of task.covers) criterionById(next, criterion);
	}
	assertAcyclic(currentTasks(next));
	assertLimits(next);
	return { ok: true, state: next, view: buildView(next), mapping };
}

function applyAmendmentChanges(next: WorksetState, operation: Extract<WorkflowOperation, { operation: "amend" }>, amendmentId: string, context: ReduceContext): {
	mapping: Record<string, string>;
	affectedTasks: Set<string>;
	affectedCriteria: Set<string>;
	affectedEvidence: Set<string>;
	replacements: AmendmentRecord["replacements"];
} {
	const mapping: Record<string, string> = {};
	const affectedTasks = new Set<string>();
	const affectedCriteria = new Set<string>();
	const affectedEvidence = new Set<string>();
	const replacements: AmendmentRecord["replacements"] = [];
	const recordInvalidation = (invalidation: Invalidation): void => {
		for (const id of invalidation.tasks) affectedTasks.add(id);
		for (const id of invalidation.evidence) affectedEvidence.add(id);
	};
	const invalidateTaskContract = (task: Task, before: { outcome: string; covers: string[]; dependsOn: string[]; writeSurface: string[]; executionConstraints: string[]; enablingPurpose: string | undefined; repositoryOwner: string }): void => {
		const semantic = task.outcome !== before.outcome
			|| JSON.stringify(task.covers) !== JSON.stringify(before.covers)
			|| JSON.stringify(task.dependsOn) !== JSON.stringify(before.dependsOn)
			|| JSON.stringify(task.writeSurface) !== JSON.stringify(before.writeSurface)
			|| JSON.stringify(task.executionConstraints) !== JSON.stringify(before.executionConstraints)
			|| task.enablingPurpose !== before.enablingPurpose
			|| task.repositoryOwner !== before.repositoryOwner;
		if (!semantic) return;
		task.semanticRevision += 1;
		recordInvalidation(invalidateTaskAndDependents(next, [task.id], `attempt invalidated: task ${task.id} contract changed`));
	};
	const assertMutable = (task: Task): void => {
		if (task.disposition === "running") reject("invalid_transition", `Task ${task.id} is running; cancel or supersede it before changing its contract.`);
		if (task.disposition === "superseded") reject("invalid_transition", `Task ${task.id} is superseded.`);
	};
	const defineTask = (definition: { key: string; outcome: string; covers?: string[]; dependsOn?: string[]; enablingPurpose?: string; repositoryOwner?: string; writeSurface?: string[]; executionConstraints?: string[] }, lineage?: Task["lineage"]): Task => {
		const key = bounded(definition.key, WORKFLOW_LIMITS.maxKey, "task key");
		if (Object.hasOwn(mapping, key)) reject("duplicate_key", `Duplicate task key ${key}`);
		const id = nextId(next, "task", "T");
		mapping[key] = id;
		const task: Task = {
			id,
			worksetId: next.workset.id,
			outcome: bounded(definition.outcome, WORKFLOW_LIMITS.maxOutcome, "task outcome"),
			semanticRevision: 1,
			covers: boundedList(definition.covers, WORKFLOW_LIMITS.maxListItems, "covers", WORKFLOW_LIMITS.maxReference),
			...(definition.enablingPurpose === undefined ? {} : { enablingPurpose: bounded(definition.enablingPurpose, WORKFLOW_LIMITS.maxOutcome, "enablingPurpose") }),
			dependsOn: boundedList(definition.dependsOn, WORKFLOW_LIMITS.maxListItems, "dependsOn", WORKFLOW_LIMITS.maxReference),
			repositoryOwner: bounded(definition.repositoryOwner ?? next.workset.repository.cwd, WORKFLOW_LIMITS.maxReference, "repositoryOwner"),
			writeSurface: boundedList(definition.writeSurface, WORKFLOW_LIMITS.maxWriteSurface, "writeSurface", WORKFLOW_LIMITS.maxReference),
			executionConstraints: boundedList(definition.executionConstraints, WORKFLOW_LIMITS.maxListItems, "executionConstraints", WORKFLOW_LIMITS.maxReference),
			disposition: "pending",
			...(lineage === undefined ? {} : { lineage }),
		};
		for (const criterion of task.covers) criterionById(next, criterion);
		for (const dependency of task.dependsOn) taskById(next, dependency);
		next.tasks[id] = task;
		affectedTasks.add(id);
		return task;
	};

	for (const change of operation.changes as AmendmentChange[]) {
		switch (change.kind) {
			case "update_goal": {
				if (change.goal === undefined && change.deliveryEndpoint === undefined && change.sourceReferences === undefined) {
					reject("invalid_payload", "update_goal needs at least one of goal, deliveryEndpoint, or sourceReferences.");
				}
				const before = { goal: next.workset.goal, deliveryEndpoint: next.workset.deliveryEndpoint, sourceReferences: [...next.workset.sourceReferences] };
				if (change.goal !== undefined) next.workset.goal = bounded(change.goal, WORKFLOW_LIMITS.maxGoal, "goal");
				if (change.deliveryEndpoint !== undefined) next.workset.deliveryEndpoint = bounded(change.deliveryEndpoint, WORKFLOW_LIMITS.maxEndpoint, "deliveryEndpoint");
				if (change.sourceReferences !== undefined) next.workset.sourceReferences = boundedList(change.sourceReferences, WORKFLOW_LIMITS.maxListItems, "sourceReferences", WORKFLOW_LIMITS.maxReference);
				const semantic = next.workset.goal !== before.goal
					|| next.workset.deliveryEndpoint !== before.deliveryEndpoint
					|| JSON.stringify(next.workset.sourceReferences) !== JSON.stringify(before.sourceReferences);
				if (!semantic) break;
				// A changed goal or endpoint is a new intent revision: prior workset bindings cannot certify it.
				next.workset.goalRevision += 1;
				for (const id of markEvidenceStale(next, (record) => record.subject.kind === "workset")) affectedEvidence.add(id);
				break;
			}
			case "add_criterion": {
				const key = bounded(change.key, WORKFLOW_LIMITS.maxKey, "criterion key");
				if (Object.hasOwn(mapping, key)) reject("duplicate_key", `Duplicate criterion key ${key}`);
				const id = nextId(next, "criterion", "AC");
				mapping[key] = id;
				next.criteria[id] = {
					id,
					worksetId: next.workset.id,
					outcome: bounded(change.outcome, WORKFLOW_LIMITS.maxOutcome, "criterion outcome"),
					verification: bounded(change.verification, WORKFLOW_LIMITS.maxVerification, "criterion verification"),
					required: change.required ?? true,
					semanticRevision: 1,
					disposition: "unverified",
				};
				affectedCriteria.add(id);
				break;
			}
			case "update_criterion": {
				const criterion = criterionById(next, change.id);
				affectedCriteria.add(criterion.id);
				const before = { outcome: criterion.outcome, verification: criterion.verification, required: criterion.required };
				if (change.outcome !== undefined) criterion.outcome = bounded(change.outcome, WORKFLOW_LIMITS.maxOutcome, "criterion outcome");
				if (change.verification !== undefined) criterion.verification = bounded(change.verification, WORKFLOW_LIMITS.maxVerification, "criterion verification");
				if (change.required !== undefined) criterion.required = change.required;
				const semantic = criterion.outcome !== before.outcome || criterion.verification !== before.verification || criterion.required !== before.required;
				if (!semantic) break;
				criterion.semanticRevision += 1;
				const evidence = markEvidenceStale(next, (record) => record.subject.kind === "criterion" && record.subject.id === criterion.id);
				for (const id of evidence) affectedEvidence.add(id);
				invalidateCriterionEvidence(next, criterion);
				const covering = currentTasks(next).filter((task) => activeTask(task) && task.covers.includes(criterion.id)).map((task) => task.id);
				recordInvalidation(invalidateTaskAndDependents(next, covering, `attempt invalidated: criterion ${criterion.id} semantics changed`));
				break;
			}
			case "retire_criterion": {
				const criterion = criterionById(next, change.id);
				if (criterion.disposition === "retired") reject("invalid_transition", `Criterion ${criterion.id} is already retired.`);
				if (change.replacementId !== undefined) {
					const replacement = criterionById(next, change.replacementId);
					if (replacement.id === criterion.id || replacement.disposition === "retired") reject("invalid_payload", "Replacement criterion must be a different active criterion.");
				}
				criterion.disposition = "retired";
				criterion.retired = { amendmentId, reason: bounded(change.reason, WORKFLOW_LIMITS.maxReason, "retire reason") };
				affectedCriteria.add(criterion.id);
				break;
			}
			case "add_task": {
				defineTask(change);
				break;
			}
			case "update_task": {
				const task = taskById(next, change.id);
				assertMutable(task);
				affectedTasks.add(task.id);
				const before = {
					outcome: task.outcome,
					covers: [...task.covers],
					dependsOn: [...task.dependsOn],
					writeSurface: [...task.writeSurface],
					executionConstraints: [...task.executionConstraints],
					enablingPurpose: task.enablingPurpose as string | undefined,
					repositoryOwner: task.repositoryOwner,
				};
				if (change.outcome !== undefined) task.outcome = bounded(change.outcome, WORKFLOW_LIMITS.maxOutcome, "task outcome");
				if (change.covers !== undefined) {
					task.covers = boundedList(change.covers, WORKFLOW_LIMITS.maxListItems, "covers", WORKFLOW_LIMITS.maxReference);
					for (const criterion of task.covers) criterionById(next, criterion);
				}
				if (change.dependsOn !== undefined) {
					task.dependsOn = boundedList(change.dependsOn, WORKFLOW_LIMITS.maxListItems, "dependsOn", WORKFLOW_LIMITS.maxReference);
					if (task.dependsOn.includes(task.id)) reject("cycle", `Task ${task.id} cannot depend on itself.`);
					for (const dependency of task.dependsOn) taskById(next, dependency);
				}
				if (change.writeSurface !== undefined) task.writeSurface = boundedList(change.writeSurface, WORKFLOW_LIMITS.maxWriteSurface, "writeSurface", WORKFLOW_LIMITS.maxReference);
				if (change.executionConstraints !== undefined) task.executionConstraints = boundedList(change.executionConstraints, WORKFLOW_LIMITS.maxListItems, "executionConstraints", WORKFLOW_LIMITS.maxReference);
				if (change.enablingPurpose !== undefined) task.enablingPurpose = bounded(change.enablingPurpose, WORKFLOW_LIMITS.maxOutcome, "enablingPurpose");
				if (change.repositoryOwner !== undefined) task.repositoryOwner = bounded(change.repositoryOwner, WORKFLOW_LIMITS.maxReference, "repositoryOwner");
				invalidateTaskContract(task, before);
				break;
			}
			case "split_task":
			case "merge_tasks":
			case "replace_task": {
				const sources = change.kind === "split_task" || change.kind === "replace_task" ? [taskById(next, change.id)] : change.ids.map((id) => taskById(next, id));
				for (const source of sources) assertMutable(source);
				const sourceIds = sources.map((source) => source.id);
				for (const sourceId of sourceIds) {
					for (const candidate of currentTasks(next)) {
						if (candidate.id === sourceId) continue;
						const index = candidate.dependsOn.indexOf(sourceId);
						if (index >= 0 && sourceIds.includes(candidate.id)) reject("cycle", `Task ${candidate.id} depends on a task it is replacing.`);
					}
				}
				const definitions = change.kind === "split_task" ? change.into : [{ key: change.key, outcome: change.outcome, covers: change.covers, dependsOn: change.dependsOn }];
				if (definitions.length === 0) reject("invalid_payload", "A split needs at least one replacement task.");
				const relation = change.kind === "split_task" ? "split" : change.kind === "merge_tasks" ? "merge" : "replacement";
				const union = [...new Set(sources.flatMap((source) => source.covers))];
				const created: Task[] = [];
				for (const definition of definitions) {
					const covers = change.kind === "merge_tasks" || change.kind === "replace_task"
						? [...new Set([...(definition.covers ?? []), ...union])]
						: definition.covers;
					const replacement = defineTask({
						key: definition.key,
						outcome: definition.outcome,
						...(covers === undefined ? {} : { covers }),
						...(definition.dependsOn === undefined ? {} : { dependsOn: definition.dependsOn }),
					}, { relation, sourceIds });
					created.push(replacement);
				}
				for (const source of sources) {
					source.disposition = "superseded";
					source.reason = `${relation} by ${created.map((task) => task.id).join(", ")}`;
					affectedTasks.add(source.id);
					recordInvalidation(invalidateTaskAndDependents(next, [source.id], `attempt invalidated: task ${source.id} was ${relation}`));
					for (const replacement of created) replacements.push({ from: source.id, to: replacement.id, relation });
					for (const dependent of currentTasks(next)) {
						if (dependent.id === source.id || sourceIds.includes(dependent.id)) continue;
						if (!dependent.dependsOn.includes(source.id)) continue;
						dependent.dependsOn = [...new Set([
							...dependent.dependsOn.filter((id) => id !== source.id),
							...created.map((task) => task.id),
						])];
						dependent.semanticRevision += 1;
						recordInvalidation(invalidateTaskAndDependents(next, [dependent.id], `attempt invalidated: dependency ${source.id} was ${relation}`));
					}
				}
				for (const criterion of union) {
					const stillCovered = currentTasks(next).some((task) => activeTask(task) && task.covers.includes(criterion));
					const retired = next.criteria[criterion]?.disposition === "retired";
					if (!stillCovered && !retired) reject("coverage_loss", `Required criterion ${criterion} loses its last active route.`);
				}
				break;
			}
			case "suspend_task": {
				const task = taskById(next, change.id);
				if (task.disposition === "accepted" || task.disposition === "superseded") reject("invalid_transition", `Task ${task.id} cannot be suspended from ${task.disposition}.`);
				task.disposition = "paused";
				task.reason = bounded(change.reason, WORKFLOW_LIMITS.maxReason, "reason");
				affectedTasks.add(task.id);
				break;
			}
			case "cancel_task": {
				const task = taskById(next, change.id);
				if (task.disposition === "accepted" || task.disposition === "cancelled" || task.disposition === "superseded") reject("invalid_transition", `Task ${task.id} cannot be cancelled from ${task.disposition}.`);
				task.disposition = "cancelled";
				task.reason = bounded(change.reason, WORKFLOW_LIMITS.maxReason, "reason");
				affectedTasks.add(task.id);
				break;
			}
			default:
				reject("invalid_payload", "Unknown amendment change");
		}
	}
	return { mapping, affectedTasks, affectedCriteria, affectedEvidence, replacements };
}

function amendOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "amend" }>, context: ReduceContext): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (state.workset.disposition === "closed") reject("workset_closed", `Workset ${state.workset.id} is closed.`);
	const reason = bounded(operation.reason, WORKFLOW_LIMITS.maxReason, "reason");
	const intentReference = bounded(operation.intentReference, WORKFLOW_LIMITS.maxReference, "intentReference");
	if (!Array.isArray(operation.changes) || operation.changes.length === 0) reject("invalid_payload", "An amendment needs at least one change.");
	const next = clone(state);
	if (operation.alignInputGeneration !== undefined) requireAlignment(next, operation.alignInputGeneration);
	const amendmentId = nextId(next, "amendment", "AM");
	const { mapping, affectedTasks, affectedCriteria, affectedEvidence, replacements } = applyAmendmentChanges(next, operation, amendmentId, context);
	for (const task of currentTasks(next)) {
		if (activeTask(task) && task.covers.length === 0 && !task.enablingPurpose) reject("invalid_payload", `Task ${task.id} has no criterion coverage and no enabling purpose.`);
		for (const criterion of task.covers) criterionById(next, criterion);
	}
	const route = (criterionId: string, tasks: readonly Task[]): boolean => tasks.some((task) => activeTask(task) && task.covers.includes(criterionId));
	const beforeTasks = currentTasks(state);
	for (const criterion of currentCriteria(next)) {
		if (!criterion.required || criterion.disposition === "retired") continue;
		const before = currentCriteria(state).find((candidate) => candidate.id === criterion.id);
		if (before && route(criterion.id, beforeTasks) && !route(criterion.id, currentTasks(next))) {
			reject("coverage_loss", `Required criterion ${criterion.id} loses its last active route.`);
		}
	}
	assertAcyclic(currentTasks(next));
	assertLimits(next);
	next.amendments[amendmentId] = {
		id: amendmentId,
		worksetId: next.workset.id,
		reason,
		intentReference,
		at: context.now,
		affected: { tasks: [...affectedTasks].sort(), criteria: [...affectedCriteria].sort(), evidence: [...affectedEvidence].sort() },
		replacements,
	};
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next), mapping, notice: `Amendment ${amendmentId} applied.` };
}

function startOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "start" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (state.workset.disposition !== "active") reject(state.workset.disposition === "closed" ? "workset_closed" : "invalid_transition", `Workset is ${state.workset.disposition}.`);
	const next = clone(state);
	requireAlignment(next, operation.alignInputGeneration);
	const task = taskById(next, operation.taskId);
	const previous = task.currentAttemptId ? next.attempts[task.currentAttemptId] : undefined;
	if (previous?.state === "running") reject("attempt_open", `Attempt ${previous.id} is still running; record its outcome before starting another.`);
	if (previous?.state === "unknown") reject("attempt_unknown", `Attempt ${previous.id} has an unknown outcome; record it before starting another.`);
	if (task.disposition !== "pending" && task.disposition !== "blocked") reject("invalid_transition", `Task ${task.id} is ${task.disposition}; only pending or blocked work can start.`);
	if (!isTaskReady(next, task)) {
		const waiting = task.dependsOn.filter((id) => next.tasks[id]?.disposition !== "accepted");
		reject("not_ready", `Task ${task.id} waits for accepted predecessors: ${waiting.join(", ") || "unknown"}.`);
	}
	const attemptId = nextId(next, "attempt", "AT");
	const basis: EvidenceBasis = {
		scope: boundedList(operation.basis?.scope, WORKFLOW_LIMITS.maxListItems, "basis scope", WORKFLOW_LIMITS.maxReference),
		fingerprint: operation.basis?.fingerprint ?? "unavailable",
		fingerprintState: operation.basis?.fingerprintState ?? "unavailable",
	};
	if (basis.fingerprintState === "current" && basis.fingerprint === "unavailable") reject("invalid_payload", "A current basis needs a fingerprint.");
	next.attempts[attemptId] = {
		id: attemptId,
		worksetId: next.workset.id,
		taskId: task.id,
		taskRevision: task.semanticRevision,
		basis,
		transport: bounded(operation.transport ?? "parent_local", WORKFLOW_LIMITS.maxReference, "transport"),
		state: "running",
		startedAt: new Date().toISOString(),
	};
	task.disposition = "running";
	task.currentAttemptId = attemptId;
	delete task.reason;
	delete task.blockClass;
	delete task.nextUnblockCondition;
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function recordOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "record" }>, context: ReduceContext): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	const next = clone(state);
	if (!operation.attempt && !operation.evidence && operation.transport === undefined) reject("invalid_payload", "record needs an attempt update, transport link, or evidence.");
	if (operation.transport !== undefined) {
		if (!operation.attemptId) reject("invalid_payload", "A transport link needs attemptId.");
		const attempt = next.attempts[operation.attemptId];
		if (!attempt || attempt.worksetId !== next.workset.id) reject("unknown_reference", `Unknown attempt ${operation.attemptId}`);
		attempt.transport = bounded(operation.transport, WORKFLOW_LIMITS.maxReference, "transport");
	}
	if (operation.attempt) {
		if (!operation.attemptId) reject("invalid_payload", "An attempt update needs attemptId.");
		const attempt = next.attempts[operation.attemptId];
		if (!attempt || attempt.worksetId !== next.workset.id) reject("unknown_reference", `Unknown attempt ${operation.attemptId}`);
		const reconciliation = attempt.state === "unknown" && operation.attempt.state !== "unknown";
		if (attempt.state !== "running" && !reconciliation) reject("invalid_transition", `Attempt ${attempt.id} already has outcome ${attempt.state}.`);
		attempt.state = operation.attempt.state;
		attempt.endedAt = context.now;
		attempt.outcome = bounded(operation.attempt.outcome, WORKFLOW_LIMITS.maxReason, "attempt outcome");
		const task = next.tasks[attempt.taskId]!;
		if (operation.attempt.state === "reported") {
			task.disposition = "awaiting_acceptance";
		} else if (operation.taskDisposition?.disposition === "blocked") {
			task.disposition = "blocked";
			task.reason = bounded(operation.taskDisposition.reason ?? operation.attempt.outcome, WORKFLOW_LIMITS.maxReason, "block reason");
			task.blockClass = operation.taskDisposition.blockClass ?? "non_convergence";
			if (operation.taskDisposition.nextUnblockCondition === undefined) delete task.nextUnblockCondition;
			else task.nextUnblockCondition = bounded(operation.taskDisposition.nextUnblockCondition, WORKFLOW_LIMITS.maxReason, "nextUnblockCondition");
		} else {
			task.disposition = "pending";
			if (operation.taskDisposition?.reason === undefined) delete task.reason;
			else task.reason = bounded(operation.taskDisposition.reason, WORKFLOW_LIMITS.maxReason, "reason");
			delete task.blockClass;
			delete task.nextUnblockCondition;
		}
	}
	if (operation.evidence) {
		const input = operation.evidence;
		let revisions: EvidenceRecord["revisions"] = {};
		if (input.subject.kind === "task") revisions = { taskRevision: taskById(next, input.subject.id).semanticRevision };
		else if (input.subject.kind === "criterion") revisions = { criterionRevision: criterionById(next, input.subject.id).semanticRevision };
		else if (input.subject.id !== next.workset.id) reject("unknown_reference", `Unknown workset ${input.subject.id}`);
		if (input.attemptId) {
			const evidenceAttempt = next.attempts[input.attemptId];
			if (!evidenceAttempt || evidenceAttempt.worksetId !== next.workset.id) reject("unknown_reference", `Unknown attempt ${input.attemptId}`);
			// An attempt fenced by a semantic change cannot certify anything afterwards.
			if (evidenceAttempt.state === "interrupted") {
				reject("invalid_transition", `Attempt ${evidenceAttempt.id} was invalidated by a semantic change; start a new attempt before binding evidence.`);
			}
		}
		const fingerprint = input.fingerprint ?? "unavailable";
		const fingerprintState = input.fingerprintState ?? (fingerprint === "unavailable" ? "unavailable" : "current");
		if (fingerprintState === "current" && fingerprint === "unavailable") reject("invalid_payload", "A current fingerprint must not be unavailable.");
		const evidenceId = nextId(next, "evidence", "EV");
		next.evidence[evidenceId] = {
			id: evidenceId,
			worksetId: next.workset.id,
			provenance: input.provenance,
			subject: input.subject,
			revisions,
			basis: {
				scope: boundedList(input.scope, WORKFLOW_LIMITS.maxListItems, "basis scope", WORKFLOW_LIMITS.maxReference),
				fingerprint,
				fingerprintState,
			},
			check: {
				identity: bounded(input.checkIdentity, WORKFLOW_LIMITS.maxCheckIdentity, "checkIdentity"),
				result: input.result,
				...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
			},
			freshness: fingerprintState === "unavailable" ? "unavailable" : "current",
			artifactReferences: boundedList(input.artifactReferences, WORKFLOW_LIMITS.maxListItems, "artifactReferences", WORKFLOW_LIMITS.maxArtifactReference),
			...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
			recordedAt: context.now,
		};
	}
	assertLimits(next);
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function currentEvidenceFor(state: WorksetState, subject: { kind: "task" | "criterion"; id: string }, evidenceIds: readonly string[]): EvidenceRecord[] {
	const records: EvidenceRecord[] = [];
	for (const id of evidenceIds) {
		const evidence = state.evidence[id];
		if (!evidence || evidence.worksetId !== state.workset.id) reject("unknown_reference", `Unknown evidence ${id}`);
		if (evidence.subject.kind !== subject.kind || evidence.subject.id !== subject.id) reject("evidence_required", `Evidence ${id} is not bound to ${subject.kind} ${subject.id}.`);
		const expected = subject.kind === "task" ? state.tasks[subject.id]?.semanticRevision : state.criteria[subject.id]?.semanticRevision;
		const bound = subject.kind === "task" ? evidence.revisions.taskRevision : evidence.revisions.criterionRevision;
		if (evidence.freshness !== "current" || bound !== expected) reject("evidence_required", `Evidence ${id} is ${evidence.freshness} for revision ${bound ?? "none"}; current ${subject.kind} revision is ${expected ?? "none"}.`);
		records.push(evidence);
	}
	if (records.length === 0) reject("evidence_required", `Acceptance needs at least one current evidence bound to ${subject.kind} ${subject.id}.`);
	return records;
}

function assessOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "assess" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	const next = clone(state);
	requireAlignment(next, operation.alignInputGeneration);
	const rationale = bounded(operation.rationale, WORKFLOW_LIMITS.maxRationale, "rationale");
	const decisionId = nextId(next, "decision", "AD");
	if (operation.subject.kind === "task") {
		const task = taskById(next, operation.subject.id);
		if (!activeTask(task)) reject("invalid_transition", `Task ${task.id} is ${task.disposition}.`);
		const attempt = task.currentAttemptId ? next.attempts[task.currentAttemptId] : undefined;
		if (attempt?.state === "running") reject("attempt_open", `Attempt ${attempt.id} is running; record its outcome before assessing the task.`);
		if (operation.verdict !== "accepted" && task.disposition === "accepted") invalidateTaskAndDependents(next, [task.id], rationale);
		if (operation.verdict === "accepted") {
			if (!task.dependsOn.every((id) => next.tasks[id]?.disposition === "accepted" && hasCurrentAcceptance(next, next.tasks[id]!))) reject("not_ready", `Task ${task.id} has unaccepted predecessors.`);
			currentEvidenceFor(next, operation.subject, operation.evidenceIds);
			task.disposition = "accepted";
			task.decisionId = decisionId;
		} else if (operation.verdict === "rejected") {
			for (const id of operation.evidenceIds) if (!next.evidence[id]) reject("unknown_reference", `Unknown evidence ${id}`);
			task.disposition = "pending";
			task.reason = rationale;
			delete task.decisionId;
		} else {
			for (const id of operation.evidenceIds) if (!next.evidence[id]) reject("unknown_reference", `Unknown evidence ${id}`);
			// Unresolved verification revokes any standing acceptance instead of leaving it effective.
			task.disposition = "pending";
			task.reason = rationale;
			delete task.decisionId;
		}
	} else {
		const criterion = criterionById(next, operation.subject.id);
		if (criterion.disposition === "retired") reject("invalid_transition", `Criterion ${criterion.id} is retired.`);
		if (operation.verdict === "accepted") {
			currentEvidenceFor(next, operation.subject, operation.evidenceIds);
			criterion.disposition = "accepted";
			criterion.decisionId = decisionId;
		} else if (operation.verdict === "rejected") {
			for (const id of operation.evidenceIds) if (!next.evidence[id]) reject("unknown_reference", `Unknown evidence ${id}`);
			criterion.disposition = "unverified";
			delete criterion.decisionId;
		} else {
			for (const id of operation.evidenceIds) if (!next.evidence[id]) reject("unknown_reference", `Unknown evidence ${id}`);
			criterion.disposition = "unverified";
			delete criterion.decisionId;
		}
	}
	next.decisions[decisionId] = {
		id: decisionId,
		worksetId: next.workset.id,
		subject: operation.subject,
		verdict: operation.verdict,
		evidenceIds: [...operation.evidenceIds],
		rationale,
		at: new Date().toISOString(),
	};
	assertLimits(next);
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function closeOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "close" }>, context: ReduceContext): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (state.workset.disposition === "closed") reject("workset_closed", `Workset ${state.workset.id} is already closed.`);
	const reason = bounded(operation.reason, WORKFLOW_LIMITS.maxReason, "reason");
	const next = clone(state);
	if (operation.outcome === "completed") {
		requireAlignment(next);
		const deficits = computeDeficits(state);
		for (const id of operation.deliveryEvidenceIds ?? []) {
			const evidence = state.evidence[id];
			if (!evidence || evidence.worksetId !== state.workset.id) reject("unknown_reference", `Unknown delivery evidence ${id}`);
			if (evidence.subject.kind !== "workset" || evidence.subject.id !== state.workset.id) reject("evidence_required", `Evidence ${id} is not bound to the workset delivery endpoint.`);
			if (evidence.freshness !== "current") reject("evidence_required", `Delivery evidence ${id} is ${evidence.freshness}.`);
		}
		if ((operation.deliveryEvidenceIds ?? []).length === 0) {
			deficits.push({ code: "missing_delivery_evidence", ids: [state.workset.id], message: "Completion needs named current evidence for the declared delivery endpoint." });
		}
		if (deficits.length > 0) reject("completion_deficit", `Workset completion is blocked by ${deficits.length} deficit(s).`, deficits);
		next.workset.disposition = "closed";
		next.workset.closeOutcome = "completed";
		next.workset.closeReason = reason;
	} else {
		next.workset.disposition = "closed";
		next.workset.closeOutcome = operation.outcome;
		next.workset.closeReason = reason;
		for (const task of currentTasks(next)) {
			if (task.disposition === "accepted" || task.disposition === "cancelled" || task.disposition === "superseded") continue;
			task.disposition = operation.outcome === "cancelled" ? "cancelled" : "superseded";
			task.reason = reason;
		}
	}
	next.revision += 1;
	void context;
	return { ok: true, state: next, view: buildView(next) };
}

function alignOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "align" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (state.workset.disposition === "closed") reject("workset_closed", `Workset ${state.workset.id} is closed.`);
	if (operation.inputGeneration !== state.workset.inputGeneration) reject("invalid_payload", `Alignment generation ${operation.inputGeneration} does not match delivered generation ${state.workset.inputGeneration}.`);
	const next = clone(state);
	if (operation.action === "cancel") {
		next.workset.disposition = "closed";
		next.workset.closeOutcome = "cancelled";
		next.workset.closeReason = bounded(operation.reason ?? "cancelled during alignment", WORKFLOW_LIMITS.maxReason, "reason");
		for (const task of currentTasks(next)) {
			if (task.disposition === "accepted" || task.disposition === "cancelled" || task.disposition === "superseded") continue;
			task.disposition = "cancelled";
			task.reason = next.workset.closeReason;
		}
	} else if (operation.action === "pause") {
		next.workset.disposition = "paused";
		next.workset.closeReason = bounded(operation.reason ?? "paused during alignment", WORKFLOW_LIMITS.maxReason, "reason");
		next.workset.alignment = { state: "aligned", inputGeneration: next.workset.inputGeneration, goalRevision: next.workset.goalRevision };
	} else {
		requireAlignment(next, operation.inputGeneration);
	}
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function pauseOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "pause" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (state.workset.disposition !== "active") reject("invalid_transition", `Workset is ${state.workset.disposition}.`);
	const next = clone(state);
	next.workset.disposition = "paused";
	next.workset.closeReason = bounded(operation.reason, WORKFLOW_LIMITS.maxReason, "reason");
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function resumeOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "resume" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (state.workset.disposition !== "paused") reject("invalid_transition", `Workset is ${state.workset.disposition}.`);
	const next = clone(state);
	next.workset.disposition = "active";
	delete next.workset.closeReason;
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

/** Recompute-bound freshness: a changed basis marks the evidence stale before assessment. */
function refreshOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "refresh" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	const next = clone(state);
	const before = Object.values(next.decisions).filter((decision) => decision.verdict === "accepted").length;
	const staleEvidence = new Set(markEvidenceStale(next, (evidence) => evidence.worksetId === next.workset.id
		&& evidence.basis.fingerprintState === "current" && Object.hasOwn(operation.fingerprints, evidence.id)
		&& evidence.basis.fingerprint !== operation.fingerprints[evidence.id]));
	if (staleEvidence.size === 0) reject("invalid_transition", "The recomputed basis matches every named binding; no refresh was needed.");
	const invalidated = before - Object.values(next.decisions).filter((decision) => decision.verdict === "accepted").length;
	next.revision += 1;
	return {
		ok: true,
		state: next,
		view: buildView(next),
		notice: `${staleEvidence.size} evidence binding(s) marked stale after a basis change${invalidated === 0 ? "" : `; ${invalidated} acceptance(s) reverted`}.`,
	};
}

export function applyOperation(state: WorksetState | undefined, operation: WorkflowOperation, context: ReduceContext): ReduceResult {
	try {
		if (operation.operation === "open") return openOperation(state, operation, context);
		if (operation.operation === "inspect") {
			if (!state) reject("no_workset", "No workset is enrolled in this session branch.");
			return { ok: true, state, view: buildView(state, operation.detail === undefined ? {} : { detail: operation.detail }) };
		}
		if (!state) reject("no_workset", "No workset is enrolled in this session branch.");
		switch (operation.operation) {
			case "align":
				return alignOperation(state, operation);
			case "amend":
				return amendOperation(state, operation, context);
			case "start":
				return startOperation(state, operation);
			case "record":
				return recordOperation(state, operation, context);
			case "assess":
				return assessOperation(state, operation);
			case "pause":
				return pauseOperation(state, operation);
			case "resume":
				return resumeOperation(state, operation);
			case "close":
				return closeOperation(state, operation, context);
			case "refresh":
				return refreshOperation(state, operation);
			case "review":
				return reviewOperation(state, operation);
			case "delivered":
				return deliveredOperation(state, operation);
			case "branch_reset":
				return branchResetOperation(state, operation, context);
		}
	} catch (error) {
		if (error instanceof Reject) {
			const failure: FailureResult = {
				ok: false,
				code: error.code,
				message: error.message,
				...(error.deficits === undefined ? {} : { deficits: error.deficits }),
				...(state === undefined ? {} : { view: buildView(state) }),
			};
			return failure;
		}
		throw error;
	}
}

/** Mark one delivered real user input; prompt alignment uses this generation. */
function branchResetOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "branch_reset" }>, context: ReduceContext): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	const next = clone(state);
	const reason = bounded(operation.reason, WORKFLOW_LIMITS.maxReason, "reason");
	for (const attempt of currentAttempts(next)) {
		if (attempt.state !== "running") continue;
		attempt.state = "interrupted";
		attempt.endedAt = context.now;
		attempt.outcome = `reconciled on ${reason}: the owning process or branch is gone`;
	}
	for (const task of currentTasks(next)) {
		if (task.disposition !== "running") continue;
		const attempt = task.currentAttemptId ? next.attempts[task.currentAttemptId] : undefined;
		if (attempt?.state === "running") continue;
		task.disposition = "pending";
		task.reason = `attempt interrupted by ${reason}`;
	}
	if (operation.align) {
		next.workset.inputGeneration += 1;
		next.workset.alignment = { ...next.workset.alignment, state: "needs_alignment", inputGeneration: next.workset.inputGeneration, goalRevision: next.workset.goalRevision };
		next.workset.review = { ...next.workset.review, inputGeneration: next.workset.inputGeneration };
	}
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function deliveredOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "delivered" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (operation.provenance === "unavailable") {
		const next = clone(state);
		next.workset.inputGeneration += 1;
		next.workset.alignment = { state: "needs_alignment", inputGeneration: next.workset.inputGeneration, goalRevision: next.workset.goalRevision, deliveryUnavailable: true };
		// Context participation is not human provenance. Keep credit AND no-progress history.
		next.workset.review = { ...next.workset.review, inputGeneration: next.workset.inputGeneration };
		next.revision += 1;
		return { ok: true, state: next, view: buildView(next) };
	}
	return markInputDelivered(state);
}

export function markInputDelivered(state: WorksetState): SuccessResult {
	const next = clone(state);
	next.workset.inputGeneration += 1;
	next.workset.alignment = { state: "needs_alignment", inputGeneration: next.workset.inputGeneration, goalRevision: next.workset.goalRevision };
	// Newly delivered user intent invalidates old review leases and resets the finite allowance.
	next.workset.review = { inputGeneration: next.workset.inputGeneration, used: 0 };
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}

function reviewOperation(state: WorksetState, operation: Extract<WorkflowOperation, { operation: "review" }>): ReduceResult {
	requireRevision(state, operation.expectedRevision);
	if (operation.action === "dispatched" && state.workset.review.used >= state.workset.reviewPolicy.maxAutomaticReviewsPerInputEpoch) {
		reject("limit_exceeded", "Automatic-review allowance is exhausted for this input generation.");
	}
	return recordReviewDecision(state, operation.action, operation.fingerprint, operation.reason, new Date().toISOString());
}

/** Record one bounded automatic-review decision; only this hook owns it. */
export function recordReviewDecision(state: WorksetState, action: "dispatched" | "blocked", fingerprint: string, reason: string | undefined, now: string): SuccessResult {
	const next = clone(state);
	next.workset.review.inputGeneration = next.workset.inputGeneration;
	if (action === "dispatched") {
		next.workset.review.used += 1;
		next.workset.review.lastFingerprint = fingerprint;
		next.workset.review.lastDispatchAt = now;
		delete next.workset.review.pausedReason;
	} else {
		next.workset.review.lastFingerprint = fingerprint;
		if (reason !== undefined) next.workset.review.pausedReason = reason;
	}
	next.revision += 1;
	return { ok: true, state: next, view: buildView(next) };
}
