import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_LIMITS, WORKFLOW_TOOL_NAME, type EvidenceBasis, type RecordOperation, type WorkflowErrorCode, type WorkflowOperation, type WorkflowView, type WorksetState } from "./contracts.ts";
import { fingerprintScope } from "./fingerprints.ts";
import { buildView } from "./reducer.ts";
import type { HostObservation, ManagedSessionObservation, ObservationIndex } from "./observation.ts";
import type { WorkflowStore } from "./store.ts";

const criterionInput = Type.Object({
	key: Type.String({ maxLength: WORKFLOW_LIMITS.maxKey }),
	outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }),
	verification: Type.String({ maxLength: WORKFLOW_LIMITS.maxVerification }),
	required: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const taskInput = Type.Object({
	key: Type.String({ maxLength: WORKFLOW_LIMITS.maxKey }),
	outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }),
	covers: Type.Optional(Type.Array(Type.String(), { maxItems: WORKFLOW_LIMITS.maxListItems })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: WORKFLOW_LIMITS.maxListItems })),
	enablingPurpose: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome })),
	repositoryOwner: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference })),
	writeSurface: Type.Optional(Type.Array(Type.String(), { maxItems: WORKFLOW_LIMITS.maxWriteSurface })),
	executionConstraints: Type.Optional(Type.Array(Type.String(), { maxItems: WORKFLOW_LIMITS.maxListItems })),
}, { additionalProperties: false });

const authorityInput = Type.Object({
	description: Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }),
	source: Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }),
	limits: Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }),
}, { additionalProperties: false });

const amendmentChange = Type.Union([
	Type.Object({ kind: Type.Literal("add_criterion"), key: Type.String({ maxLength: 64 }), outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }), verification: Type.String({ maxLength: WORKFLOW_LIMITS.maxVerification }), required: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("update_criterion"), id: Type.String(), outcome: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome })), verification: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxVerification })), required: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("retire_criterion"), id: Type.String(), replacementId: Type.Optional(Type.String()), reason: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("add_task"), key: Type.String({ maxLength: 64 }), outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }), covers: Type.Optional(Type.Array(Type.String())), dependsOn: Type.Optional(Type.Array(Type.String())), enablingPurpose: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome })), repositoryOwner: Type.Optional(Type.String()), writeSurface: Type.Optional(Type.Array(Type.String())), executionConstraints: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("update_task"), id: Type.String(), outcome: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome })), covers: Type.Optional(Type.Array(Type.String())), dependsOn: Type.Optional(Type.Array(Type.String())), writeSurface: Type.Optional(Type.Array(Type.String())), executionConstraints: Type.Optional(Type.Array(Type.String())), enablingPurpose: Type.Optional(Type.String()), repositoryOwner: Type.Optional(Type.String()) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("split_task"), id: Type.String(), into: Type.Array(Type.Object({ key: Type.String({ maxLength: 64 }), outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }), covers: Type.Optional(Type.Array(Type.String())), dependsOn: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }), { minItems: 1, maxItems: WORKFLOW_LIMITS.maxListItems }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("merge_tasks"), ids: Type.Array(Type.String(), { minItems: 2, maxItems: WORKFLOW_LIMITS.maxListItems }), key: Type.String({ maxLength: 64 }), outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }), covers: Type.Optional(Type.Array(Type.String())), dependsOn: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("replace_task"), id: Type.String(), key: Type.String({ maxLength: 64 }), outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxOutcome }), covers: Type.Optional(Type.Array(Type.String())), dependsOn: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("update_goal"), goal: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxGoal })), deliveryEndpoint: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxEndpoint })), sourceReferences: Type.Optional(Type.Array(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }), { maxItems: WORKFLOW_LIMITS.maxListItems })) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("suspend_task"), id: Type.String(), reason: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("cancel_task"), id: Type.String(), reason: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }) }, { additionalProperties: false }),
]);

const operationParameters = Type.Union([
	Type.Object({
		operation: Type.Literal("open"),
		expectedRevision: Type.Literal(0),
		goal: Type.String({ maxLength: WORKFLOW_LIMITS.maxGoal }),
		deliveryEndpoint: Type.String({ maxLength: WORKFLOW_LIMITS.maxEndpoint }),
		sourceReferences: Type.Optional(Type.Array(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }), { maxItems: WORKFLOW_LIMITS.maxListItems })),
		authorityReferences: Type.Optional(Type.Array(authorityInput, { maxItems: WORKFLOW_LIMITS.maxListItems })),
		criteria: Type.Array(criterionInput, { minItems: 1, maxItems: WORKFLOW_LIMITS.maxCriteria }),
		tasks: Type.Array(taskInput, { minItems: 1, maxItems: WORKFLOW_LIMITS.maxTasks }),
		reviewPolicy: Type.Optional(Type.Object({ maxAutomaticReviewsPerInputEpoch: Type.Integer({ minimum: 0, maximum: 1 }) }, { additionalProperties: false })),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("inspect"),
		detail: Type.Optional(Type.Object({
			kind: Type.Union([Type.Literal("task"), Type.Literal("criterion"), Type.Literal("attempt"), Type.Literal("evidence"), Type.Literal("decision"), Type.Literal("amendment")]),
			id: Type.String({ maxLength: 64 }),
		}, { additionalProperties: false })),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("align"),
		expectedRevision: Type.Integer({ minimum: 1 }),
		inputGeneration: Type.Integer({ minimum: 0 }),
		action: Type.Union([Type.Literal("confirm"), Type.Literal("acknowledge"), Type.Literal("pause"), Type.Literal("cancel")]),
		reason: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxReason })),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("amend"),
		expectedRevision: Type.Integer({ minimum: 1 }),
		reason: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }),
		intentReference: Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }),
		changes: Type.Array(amendmentChange, { minItems: 1, maxItems: WORKFLOW_LIMITS.maxListItems }),
		alignInputGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("start"),
		expectedRevision: Type.Integer({ minimum: 1 }),
		taskId: Type.String(),
		transport: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference })),
		basis: Type.Optional(Type.Object({
			scope: Type.Optional(Type.Array(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }), { maxItems: WORKFLOW_LIMITS.maxListItems })),
			fingerprint: Type.Optional(Type.String({ maxLength: 256 })),
			fingerprintState: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("unavailable")])),
		}, { additionalProperties: false })),
		alignInputGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("record"),
		expectedRevision: Type.Integer({ minimum: 1 }),
		attemptId: Type.Optional(Type.String()),
		transport: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference })),
		attempt: Type.Optional(Type.Object({
			state: Type.Union([Type.Literal("reported"), Type.Literal("failed"), Type.Literal("interrupted"), Type.Literal("unknown")]),
			outcome: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }),
		}, { additionalProperties: false })),
		taskDisposition: Type.Optional(Type.Object({
			disposition: Type.Union([Type.Literal("pending"), Type.Literal("blocked")]),
			reason: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxReason })),
			blockClass: Type.Optional(Type.Union([Type.Literal("needs_authority"), Type.Literal("missing_capability"), Type.Literal("non_convergence")])),
			nextUnblockCondition: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.maxReason })),
		}, { additionalProperties: false })),
		evidence: Type.Optional(Type.Object({
			provenance: Type.Union([Type.Literal("host_observed"), Type.Literal("agent_declared"), Type.Literal("user_declared"), Type.Literal("review")]),
			subject: Type.Object({
				kind: Type.Union([Type.Literal("task"), Type.Literal("criterion"), Type.Literal("workset")]),
				id: Type.String(),
			}, { additionalProperties: false }),
			scope: Type.Optional(Type.Array(Type.String({ maxLength: WORKFLOW_LIMITS.maxReference }), { maxItems: WORKFLOW_LIMITS.maxListItems })),
			fingerprint: Type.Optional(Type.String({ maxLength: 256 })),
			fingerprintState: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("unavailable")])),
			checkIdentity: Type.String({ maxLength: WORKFLOW_LIMITS.maxCheckIdentity }),
			result: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
			exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
			artifactReferences: Type.Optional(Type.Array(Type.String({ maxLength: WORKFLOW_LIMITS.maxArtifactReference }), { maxItems: WORKFLOW_LIMITS.maxListItems })),
			attemptId: Type.Optional(Type.String()),
			observationId: Type.Optional(Type.String({ maxLength: 128 })),
			managed: Type.Optional(Type.Object({
				handle: Type.String({ maxLength: 128 }),
				episode: Type.Integer({ minimum: 0 }),
				action: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("continue"), Type.Literal("inspect"), Type.Literal("apply"), Type.Literal("close")])),
				candidateId: Type.Optional(Type.String({ maxLength: 128 })),
			}, { additionalProperties: false })),
		}, { additionalProperties: false })),
		alignInputGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("assess"),
		expectedRevision: Type.Integer({ minimum: 1 }),
		subject: Type.Object({
			kind: Type.Union([Type.Literal("task"), Type.Literal("criterion")]),
			id: Type.String(),
		}, { additionalProperties: false }),
		verdict: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unresolved_verification")]),
		evidenceIds: Type.Array(Type.String(), { maxItems: WORKFLOW_LIMITS.maxListItems }),
		rationale: Type.String({ maxLength: WORKFLOW_LIMITS.maxRationale }),
		alignInputGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("pause"), expectedRevision: Type.Integer({ minimum: 1 }), reason: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }) }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("resume"), expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("close"),
		expectedRevision: Type.Integer({ minimum: 1 }),
		outcome: Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("superseded")]),
		reason: Type.String({ maxLength: WORKFLOW_LIMITS.maxReason }),
		deliveryEvidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: WORKFLOW_LIMITS.maxListItems })),
	}, { additionalProperties: false }),
]);

export type WorkflowToolParams = Static<typeof operationParameters>;

// Providers require an object root, not the discriminated union used for local validation.
// Derive the flat declaration from the same operation schemas so bounds and fields stay in sync.
const parameters = (() => {
	const fields = new Map<string, { schemas: Map<string, TSchema>; used: string[]; required: string[] }>();
	for (const variant of operationParameters.anyOf) {
		for (const [name, schema] of Object.entries(variant.properties)) {
			const field = fields.get(name) ?? { schemas: new Map<string, TSchema>(), used: [], required: [] };
			field.schemas.set(JSON.stringify(schema), schema);
			field.used.push(variant.properties.operation.const);
			if (variant.required?.some((required) => required === name)) field.required.push(variant.properties.operation.const);
			fields.set(name, field);
		}
	}
	return Type.Object(Object.fromEntries([...fields].map(([name, field]) => {
		const schema = Type.Union([...field.schemas.values()], {
			description: `Used by: ${field.used.join(", ")}.${field.required.length ? ` Required for: ${field.required.join(", ")}.` : ""}`,
		});
		return [name, name === "operation" ? schema : Type.Optional(schema)];
	})), { additionalProperties: false });
})();

const truncate = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Bounded text projection: usable without any widget, never a second ledger. */
export function renderWorkflowView(view: WorkflowView): string {
	const lines: string[] = [];
	const workset = view.workset;
	if (!workset) return "workflow: no workset enrolled in this session branch.";
	lines.push(`workflow revision ${view.revision} workset ${workset.id} ${workset.disposition}${workset.closeOutcome === undefined ? "" : ` (${workset.closeOutcome})`}`);
	lines.push(`goal r${workset.goalRevision}: ${truncate(workset.goal, 200)}`);
	lines.push(`delivery: ${truncate(workset.deliveryEndpoint, 200)}`);
	lines.push(`alignment ${workset.alignment.state} at input generation ${workset.inputGeneration}; auto-review cap ${workset.reviewPolicy.maxAutomaticReviewsPerInputEpoch}`);
	if (workset.alignment.deliveryUnavailable) lines.push("Input origin is unconfirmed. Align the actual model context against existing authority; confirmation does not grant permission or replenish automatic review credit.");
	for (const criterion of view.criteria.slice(0, WORKFLOW_LIMITS.maxCriteria)) {
		lines.push(`criterion ${criterion.id} r${criterion.semanticRevision} ${criterion.disposition}${criterion.required ? " required" : ""}: ${truncate(criterion.outcome, 120)}`);
	}
	for (const task of view.tasks.slice(0, WORKFLOW_LIMITS.maxTasks)) {
		lines.push(`task ${task.id} r${task.semanticRevision} ${task.disposition}${task.ready ? " ready" : ""} covers=[${task.covers.join(",")}] deps=[${task.dependsOn.join(",")}]${task.currentAttemptId === undefined ? "" : ` attempt=${task.currentAttemptId}`}${task.lineage === undefined ? "" : ` ${task.lineage.relation}(${task.lineage.sourceIds.join(",")})`}: ${truncate(task.outcome, 120)}${task.reason === undefined ? "" : ` [${truncate(task.reason, 80)}]`}`);
	}
	for (const attempt of view.attempts.slice(0, WORKFLOW_LIMITS.maxAttempts)) {
		lines.push(`attempt ${attempt.id} ${attempt.state} task=${attempt.taskId} task-r${attempt.taskRevision} transport=${attempt.transport}`);
	}
	for (const evidence of view.evidence.slice(0, WORKFLOW_LIMITS.maxEvidence)) {
		lines.push(`evidence ${evidence.id} ${evidence.subject.kind}:${evidence.subject.id} ${evidence.provenance} ${evidence.result} ${evidence.freshness} ${truncate(evidence.identity, 80)}`);
	}
	if (view.deficits.length > 0) for (const deficit of view.deficits) lines.push(`deficit ${deficit.code}: ${truncate(deficit.message, 240)}`);
	if (view.records) lines.push(`records: ${truncate(JSON.stringify(view.records), 1200)}`);
	return lines.join("\n");
}

function renderMapping(mapping: Record<string, string> | undefined): string | undefined {
	const entries = Object.entries(mapping ?? {});
	if (entries.length === 0) return undefined;
	return `allocated ids: ${entries.map(([key, id]) => `${key}=${id}`).join(", ")}`;
}


// ---------------------------------------------------------------------------
// Host-observed fact resolution (WF-03)
// ---------------------------------------------------------------------------

export interface PrepareDeps {
	store: WorkflowStore;
	observations: ObservationIndex;
	cwd: string;
	now: string;
	sessionId: string;
	/** Last model-prepared input provenance, including before enrollment; not a receipt or model assertion. */
	deliveryUnavailable?: boolean;
	unrecordedInput?: boolean;
}

export type Prepared =
	| { ok: true; operation: WorkflowOperation; notices: string[] }
	| { ok: false; code: WorkflowErrorCode; message: string };

/** Canonical comparison spelling: cwd-relative when contained, absolute otherwise. */
function canonicalPath(value: string, cwd: string): string {
	const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
	const rel = relative(cwd, absolute);
	if (rel === "") return ".";
	if (rel.startsWith("..")) return absolute.replaceAll("\\", "/");
	return rel.replaceAll("\\", "/").replace(/\/+$/, "") || ".";
}

function canonicalScope(scope: readonly string[], cwd: string): string[] {
	return [...new Set(scope.map((entry) => canonicalPath(entry, cwd)))].sort();
}

function sameScope(left: readonly string[], right: readonly string[], cwd: string): boolean {
	const a = canonicalScope(left, cwd);
	const b = canonicalScope(right, cwd);
	return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function pathIntersects(left: string, right: string, cwd: string): boolean {
	const a = canonicalPath(left, cwd);
	const b = canonicalPath(right, cwd);
	if (a === "." || b === ".") return true;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Transport fact mapping; never claims a semantic test result the host did not report. */
function observedResult(observation: HostObservation, session: ManagedSessionObservation | undefined): "pass" | "fail" | "unknown" {
	const managed = observation.managed;
	if (managed) {
		if (managed.action === "apply") {
			if (session?.candidate?.status === "applied") return "pass";
			if (session?.candidate?.status === "partial" || session?.candidate?.status === "conflict") return "fail";
			return "unknown";
		}
		if (managed.status === "succeeded") return "pass";
		if (managed.status === "partial" || managed.status === "failed" || managed.status === "aborted") return "fail";
		return "unknown";
	}
	if (typeof observation.exitCode === "number") return observation.exitCode === 0 ? "pass" : "fail";
	return observation.isError ? "fail" : "unknown";
}

function managedCheckIdentity(observation: HostObservation): string {
	const managed = observation.managed;
	if (!managed) return `${observation.toolName}:${observation.toolCallId}`;
	return `${observation.toolName}:${observation.toolCallId}:${managed.action ?? "unknown"}:${managed.status}`;
}

async function resolveEvidence(
	input: NonNullable<RecordOperation["evidence"]>,
	deps: PrepareDeps,
	state: WorksetState | undefined,
): Promise<{ ok: true; evidence: NonNullable<RecordOperation["evidence"]>; notices: string[] } | { ok: false; code: WorkflowErrorCode; message: string }> {
	const resolved: NonNullable<RecordOperation["evidence"]> = { ...input };
	const notices: string[] = [];
	let observation: HostObservation | undefined;
	let session: ManagedSessionObservation | undefined;
	if (input.observationId !== undefined) {
		observation = deps.observations.get(input.observationId);
		if (!observation) {
			return { ok: false, code: "unknown_reference", message: `Observation ${input.observationId} was not observed from a host tool result in this session; only real tool results can be bound.` };
		}
	}
	if (input.managed !== undefined) {
		const observed = observation;
		if (observed) {
			const query = input.managed;
			const match = observed.managed?.sessions.find((candidate) => candidate.handle === query.handle && candidate.episode === query.episode
				&& (query.candidateId === undefined || candidate.candidate?.id === query.candidateId)
				&& (query.action === undefined || observed.managed?.action === query.action));
			if (!observed.managed || !match) {
				return { ok: false, code: "unknown_reference", message: `Observation ${observed.toolCallId} does not report ${query.handle}@${query.episode}${query.action === undefined ? "" : ` for ${query.action}`}.` };
			}
			session = match;
		} else {
			const found = deps.observations.findManaged({
				handle: input.managed.handle,
				episode: input.managed.episode,
				...(input.managed.action === undefined ? {} : { action: input.managed.action }),
				...(input.managed.candidateId === undefined ? {} : { candidateId: input.managed.candidateId }),
			});
			if (!found) {
				return { ok: false, code: "unknown_reference", message: `No observed csheng_subagent_sessions result reports ${input.managed.handle}@${input.managed.episode}${input.managed.action === undefined ? "" : ` for ${input.managed.action}`}.` };
			}
			observation = found.observation;
			session = found.session;
		}
	}
	if (!observation && input.observationId === undefined && input.managed === undefined && input.provenance === "host_observed") {
		return {
			ok: false,
			code: "invalid_payload",
			message: "host_observed provenance requires an observationId or managed reference from a real host tool result; use agent_declared for an agent reading.",
		};
	}
	if (observation) {
		if (!session && observation.managed && observation.managed.sessions.length > 0) session = observation.managed.sessions[0];
		resolved.provenance = "host_observed";
		resolved.checkIdentity = managedCheckIdentity(observation);
		resolved.result = observedResult(observation, session);
		if (observation.exitCode === undefined) delete resolved.exitCode;
		else resolved.exitCode = observation.exitCode;
		notices.push(`bound host observation ${observation.toolCallId} (${observation.toolName})`);
		// A result from another session or an abandoned branch is not this branch's execution.
		if (observation.sessionId !== "" && deps.sessionId !== "" && observation.sessionId !== deps.sessionId) {
			return {
				ok: false,
				code: "unknown_reference",
				message: `Observation ${observation.toolCallId} was reported in session ${observation.sessionId}, not the current session; record evidence from this branch.`,
			};
		}
	}
	const explicitScope = input.scope !== undefined && input.scope.length > 0 ? input.scope : undefined;
	const attemptId = input.attemptId ?? (input.subject.kind === "task" ? state?.tasks[input.subject.id]?.currentAttemptId : undefined);
	const attempt = attemptId === undefined ? undefined : state?.attempts[attemptId];
	let basis: EvidenceBasis;
	if (attempt) {
		// The basis captured when the attempt started is the execution basis; today's files cannot rebind it.
		if (explicitScope && !sameScope(explicitScope, attempt.basis.scope, deps.cwd)) {
			return {
				ok: false,
				code: "invalid_payload",
				message: `Declared scope ${explicitScope.join(", ")} does not match attempt ${attempt.id}'s captured basis (${attempt.basis.scope.join(", ")}); start a new attempt for a different basis.`,
			};
		}
		if (attempt.state === "interrupted") {
			return { ok: false, code: "invalid_transition", message: `Attempt ${attempt.id} was invalidated by a semantic change; start a new attempt before binding evidence.` };
		}
		if (observation && observation.at !== "" && attempt.startedAt !== "" && observation.at < attempt.startedAt) {
			return { ok: false, code: "invalid_payload", message: `Observation ${observation.toolCallId} was reported before attempt ${attempt.id} started and cannot verify it.` };
		}
		basis = { ...attempt.basis };
		notices.push(`inherited the attempt basis from ${attempt.id}`);
	} else if (observation) {
		// No captured execution basis: report the honest state instead of assigning today's fingerprint.
		basis = {
			scope: explicitScope ?? ["."],
			fingerprint: "unavailable",
			fingerprintState: "unavailable",
		};
	} else {
		const computed = await fingerprintScope(explicitScope, deps.cwd);
		basis = { scope: computed.scope, fingerprint: computed.fingerprint, fingerprintState: computed.state };
	}
	resolved.scope = basis.scope;
	resolved.fingerprint = basis.fingerprint;
	resolved.fingerprintState = basis.fingerprintState;
	return { ok: true, evidence: resolved, notices };
}

/** Recompute current bindings; returns the fingerprint map when any named evidence changed. */
async function changedFingerprints(state: WorksetState, evidenceIds: readonly string[], deps: PrepareDeps): Promise<Record<string, string> | undefined> {
	const fingerprints: Record<string, string> = {};
	let changed = false;
	for (const id of evidenceIds) {
		const evidence = state.evidence[id];
		if (!evidence || evidence.freshness !== "current" || evidence.basis.fingerprintState !== "current") continue;
		const computed = await fingerprintScope(evidence.basis.scope, deps.cwd);
		fingerprints[id] = computed.state === "current" ? computed.fingerprint : "unavailable";
		if (fingerprints[id] !== evidence.basis.fingerprint) changed = true;
	}
	return changed ? fingerprints : undefined;
}

function concurrentWriter(state: WorksetState, scopes: readonly string[], subjectId: string, cwd: string): string | undefined {
	for (const attempt of Object.values(state.attempts)) {
		if (attempt.worksetId !== state.workset.id || attempt.state !== "running" || attempt.taskId === subjectId) continue;
		const task = state.tasks[attempt.taskId];
		const writes = task && task.writeSurface.length > 0 ? task.writeSurface : ["."];
		if (scopes.length === 0) return attempt.id;
		if (writes.some((write) => scopes.some((scope) => pathIntersects(write, scope, cwd)))) return attempt.id;
	}
	return undefined;
}

/** Evidence that currently supports an accepted required criterion or an accepted task. */
function acceptanceEvidenceIds(state: WorksetState, deliveryIds: readonly string[]): string[] {
	const ids = new Set<string>(deliveryIds);
	for (const criterion of Object.values(state.criteria)) {
		if (criterion.worksetId !== state.workset.id || !criterion.required || criterion.retired !== undefined) continue;
		if (criterion.disposition !== "accepted" || criterion.decisionId === undefined) continue;
		for (const id of state.decisions[criterion.decisionId]?.evidenceIds ?? []) ids.add(id);
	}
	for (const task of Object.values(state.tasks)) {
		if (task.worksetId !== state.workset.id || task.disposition !== "accepted" || task.decisionId === undefined) continue;
		for (const id of state.decisions[task.decisionId]?.evidenceIds ?? []) ids.add(id);
	}
	return [...ids].sort();
}

export async function prepareOperation(operation: WorkflowOperation, deps: PrepareDeps): Promise<Prepared> {
	const state = deps.store.current();
	const notices: string[] = [];
	if (deps.unrecordedInput && operation.operation !== "inspect" && operation.operation !== "record"
		&& !(operation.operation === "align" && (operation.action === "pause" || operation.action === "cancel"))
		&& !(operation.operation === "close" && operation.outcome !== "completed")) {
		return { ok: false, code: "state_unavailable", message: "A model-bound input observation has not been persisted; retry context preparation before advancing workflow." };
	}
	if (operation.operation === "open") {
		const { deliveryUnavailable: _untrusted, ...input } = operation;
		return { ok: true, operation: { ...input, ...(deps.deliveryUnavailable ? { deliveryUnavailable: true } : {}) }, notices };
	}
	if (state && "expectedRevision" in operation && operation.expectedRevision !== state.revision) {
		return { ok: false, code: "stale_revision", message: `expectedRevision ${operation.expectedRevision} is stale; the current revision is ${state.revision}.` };
	}
	if (operation.operation === "start") {
		const computed = await fingerprintScope(operation.basis?.scope, deps.cwd);
		if (operation.transport?.startsWith("managed:")) {
			const match = /^managed:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):(\d+)$/.exec(operation.transport);
			if (!match) return { ok: false, code: "invalid_payload", message: "Managed transport must be spelled managed:<handle>:<episode>." };
			const found = deps.observations.findManaged({ handle: match[1]!, episode: Number(match[2]) });
			if (!found) {
				return { ok: false, code: "unknown_reference", message: `Managed transport ${operation.transport} was not observed from a csheng_subagent_sessions result; start the attempt without it or observe the child first.` };
			}
			notices.push(`bound managed transport ${operation.transport} to observation ${found.observation.toolCallId}`);
		}
		return {
			ok: true,
			operation: { ...operation, basis: { scope: computed.scope, fingerprint: computed.fingerprint, fingerprintState: computed.state } },
			notices,
		};
	}
	if (operation.operation === "record" && operation.transport?.startsWith("managed:")) {
		const match = /^managed:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):(\d+)$/.exec(operation.transport);
		if (!match) return { ok: false, code: "invalid_payload", message: "Managed transport must be spelled managed:<handle>:<episode>." };
		const found = deps.observations.findManaged({ handle: match[1]!, episode: Number(match[2]) });
		if (!found) {
			return { ok: false, code: "unknown_reference", message: `Managed transport ${operation.transport} was not observed from a csheng_subagent_sessions result.` };
		}
		notices.push(`bound managed transport ${operation.transport} to observation ${found.observation.toolCallId}`);
	}
	if (operation.operation === "record" && operation.evidence) {
		const resolved = await resolveEvidence(operation.evidence, deps, state);
		if (!resolved.ok) return resolved;
		return { ok: true, operation: { ...operation, evidence: resolved.evidence }, notices: [...notices, ...resolved.notices] };
	}
	if (operation.operation === "assess" || (operation.operation === "close" && operation.outcome === "completed")) {
		if (!state) return { ok: true, operation, notices };
		const evidenceIds = operation.operation === "assess" ? operation.evidenceIds : acceptanceEvidenceIds(state, operation.deliveryEvidenceIds ?? []);
		if (evidenceIds.length > WORKFLOW_LIMITS.maxCompletionChecks) {
			return {
				ok: false,
				code: "evidence_required",
				message: `Completion would need ${evidenceIds.length} basis re-checks, above the bounded completion check budget of ${WORKFLOW_LIMITS.maxCompletionChecks}; retire or consolidate superseded bindings before completing.`,
			};
		}
		if (operation.operation === "assess" && evidenceIds.length > 0) {
			const subjectId = operation.subject.id;
			const scopes = evidenceIds.map((id) => state.evidence[id]?.basis.scope ?? []).flat();
			const writer = concurrentWriter(state, scopes, subjectId, deps.cwd);
			if (writer) {
				return {
					ok: false,
					code: "attempt_open",
					message: `Attempt ${writer} is still running against an overlapping write surface; record it before judging ${subjectId}.`,
				};
			}
		}
		const changed = await changedFingerprints(state, evidenceIds, deps);
		if (changed) {
			const refreshed = deps.store.apply({ operation: "refresh", expectedRevision: state.revision, fingerprints: changed }, { now: deps.now, cwd: deps.cwd, sessionId: "" }, `refresh-${randomUUID()}`);
			const changedIds = Object.keys(changed);
			if (!refreshed.ok) return { ok: false, code: refreshed.code, message: refreshed.message };
			return {
				ok: false,
				code: "evidence_required",
				message: `The basis changed since it was bound: ${changedIds.join(", ")}. Re-record evidence against the current basis before judging.`,
			};
		}
	}
	return { ok: true, operation, notices };
}

export function registerWorkflowTool(pi: ExtensionAPI, store: WorkflowStore, observations: ObservationIndex, deliveryUnavailable: () => boolean = () => false, unrecordedInput: () => boolean = () => false): void {
	pi.registerTool({
		name: WORKFLOW_TOOL_NAME,
		label: "Workflow",
		description:
			"Own the task-level workflow for this session branch. The agent supplies intent, cohesive tasks and acceptance judgments; this tool owns ids, revisions, dependencies, readiness, evidence binding and the truthful completion predicate.",
		promptSnippet: "Track one workset of criteria, tasks, attempts, evidence and acceptance judgments.",
		promptGuidelines: [
			"Use csheng_workflow for ongoing multi-step work: open a workset from the plan or user intent, then inspect before every mutation.",
			"Every mutating call echoes expectedRevision from the latest workflow result; a stale call changes nothing and returns the current view.",
			"Record evidence with honest provenance: host observations are not tests, and an agent's reading is not a host exit code.",
			"Start an attempt before running a check: the attempt captures the basis, and host-observed evidence for a task without one is recorded as unavailable.",
			"close/completed fails with structured deficits until every required criterion is accepted, delivery evidence is current, no attempt is unresolved, and the delivered input is aligned.",
		],
		parameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const operation = validateToolArguments(
				{ name: WORKFLOW_TOOL_NAME, description: "Workflow operation", parameters: operationParameters },
				{ type: "toolCall", id: toolCallId, name: WORKFLOW_TOOL_NAME, arguments: params },
			) as WorkflowToolParams;
			const context = {
				now: new Date().toISOString(),
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
			};
			const prepared = await prepareOperation(operation, { store, observations, cwd: ctx.cwd, now: context.now, sessionId: context.sessionId, deliveryUnavailable: deliveryUnavailable(), unrecordedInput: unrecordedInput() });
			if (!prepared.ok) {
				const state = store.current();
				const view = state === undefined ? undefined : buildView(state);
				const text = [`workflow ${operation.operation} rejected: ${prepared.code}: ${prepared.message}`, ...(view === undefined ? [] : [renderWorkflowView(view)])].join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: { ok: false as const, operation: operation.operation, code: prepared.code, message: prepared.message, deficits: [], ...(view === undefined ? {} : { workflow: view }) },
				};
			}
			const result = store.apply(prepared.operation, context, toolCallId);
			if (result.ok) {
				const mapping = renderMapping(result.mapping);
				const header = `workflow ${operation.operation} ok at revision ${result.state.revision}`;
				const text = [header, mapping, ...prepared.notices, result.notice, renderWorkflowView(result.view)].filter((line): line is string => line !== undefined).join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: { ok: true as const, operation: operation.operation, revision: result.state.revision, workflow: result.view },
				};
			}
			const deficits = result.deficits ?? result.view?.deficits ?? [];
			const text = [
				`workflow ${operation.operation} rejected: ${result.code}: ${result.message}`,
				...(deficits.length === 0 ? [] : [`deficits: ${deficits.map((deficit) => `${deficit.code}(${deficit.ids.join(",")})`).join(", ")}`]),
				...(result.view === undefined ? [] : [renderWorkflowView(result.view)]),
			].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {
					ok: false as const,
					operation: operation.operation,
					code: result.code,
					message: result.message,
					deficits,
					...(result.view === undefined ? {} : { workflow: result.view }),
				},
			};
		},
	});

	pi.on("tool_result", (event) => {
		const custom = event as { toolName?: string; details?: unknown };
		if (custom.toolName !== WORKFLOW_TOOL_NAME) return;
		const details = custom.details as { ok?: boolean } | undefined;
		if (details?.ok === false) return { isError: true };
		return;
	});
}
