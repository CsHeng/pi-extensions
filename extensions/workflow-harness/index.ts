import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { admitRootRole } from "./activation.ts";
import { consumeExactUserAuthority, issueExactUserAuthority, loadAuthoritySettings } from "./authority.ts";
import { buildChildDispatch } from "./child-dispatch.ts";
import { acceptWorkerResult, completeVerifiedTask, recordObservedOperation, recordVerification, retryTask, startTaskAttempt } from "./execution.ts";
import { admitNormalization } from "./normalization.ts";
import { freezeProposal } from "./proposal.ts";
import { completePendingChild, markPendingChildDispatched, replaySessionState, schedulePendingChild } from "./replay.ts";
import { consumeReviewBatch, nextReviewBatch, recordFormalReview, recordStandaloneReview, recordWorkerRequestedReview } from "./review-policy.ts";
import { admitFocusedRepair, adjudicateReview, completeFocusedRepair } from "./review-result.ts";
import { newSessionState, SESSION_ENTRY_TYPE, updateSessionState, type HarnessSessionStateV1, type SelectedWorker } from "./session-state.ts";
import { settle } from "./settlement.ts";
import { correlateSkillRead, explicitSkillSelection, snapshotSkills, type SkillCapability } from "./skill-discovery.ts";
import { initialProgress } from "./task-graph.ts";
import { gateToolCall } from "./tool-policy.ts";

export const WORKFLOW_HARNESS_STATUS_COMMAND = "workflow-harness-status";
export const WORKFLOW_RUN_COMMAND = "workflow-run";
export const WORKFLOW_REVIEW_COMMAND = "workflow-review";
export const WORKFLOW_AUTHORIZE_COMMAND = "workflow-authorize";
export const WORKFLOW_APPROVE_COMMAND = "workflow-approve";
export const HARNESS_TOOLS = [
	"workflow_activate", "workflow_submit_graph", "workflow_update_task", "workflow_complete_stage",
	"workflow_submit_review", "workflow_adjudicate_review", "workflow_complete_repair", "workflow_settle",
] as const;

const ROLES = ["design", "planning", "implementation", "none"] as const;
const STATUS_KEY = "workflow-harness";

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function textResult(text: string, details: unknown = {}): { content: [{ type: "text"; text: string }]; details: unknown } {
	return { content: [{ type: "text", text }], details };
}

function reviewWorker(skills: readonly SkillCapability[]): SkillCapability | null {
	const matches = skills.filter((skill) => /\b(review|inspect|assess|audit)\b/i.test(skill.description));
	return matches.length === 1 ? matches[0] ?? null : null;
}

function activeTask(state: HarnessSessionStateV1) {
	const attempt = state.execution.attempts.find((item) => item.attemptId === state.execution.activeAttemptId);
	return state.graph?.tasks.find((task) => task.taskId === attempt?.taskId);
}

function publicStatus(state: HarnessSessionStateV1 | undefined, authorityError: string | undefined): string {
	if (authorityError) return "blocked: invalid local authority settings";
	if (!state) return "pass-through";
	return `${state.lifecycle}; role=${state.formalRole}; graph=${state.graph ? "admitted" : "none"}; pending=${state.pendingChild ? "child" : "none"}; settled=${state.settled}`;
}

/** Register one generic extension that owns the entire mechanical workflow boundary. */
export default function workflowHarness(pi: ExtensionAPI): void {
	let state: HarnessSessionStateV1 | undefined;
	let pendingRequest = "";
	let pendingExplicitSkill: SkillCapability | undefined;
	let observedRootSkill: SkillCapability | undefined;
	let workspaceRoot = "";
	let authorityError: string | undefined;
	const pendingOperations = new Map<string, string>();

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.mode === "tui") ctx.ui.notify(message, level);
	}

	function persist(next: HarnessSessionStateV1): void {
		state = next;
		pi.appendEntry(SESSION_ENTRY_TYPE, next);
	}

	function refresh(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Workflow · ${publicStatus(state, authorityError)}`));
	}

	async function activate(role: typeof ROLES[number], selectedName: string | undefined, artifactPaths: readonly string[], kind: "explicit-role" | "root-skill-selection", expectedSnapshotSha256?: string): Promise<HarnessSessionStateV1> {
		if (state && !state.settled) throw new Error("a managed workflow is already active");
		if (!pendingRequest.trim()) throw new Error("activation requires one current root request");
		const snapshot = snapshotSkills(pi.getCommands());
		if (expectedSnapshotSha256 && expectedSnapshotSha256 !== snapshot.sha256) throw new Error("root Skill resolution is stale");
		const selected = selectedName ? snapshot.skills.find((skill) => skill.name === selectedName) : pendingExplicitSkill;
		if (selectedName && !selected) throw new Error("selected worker is absent from the current Pi Skill snapshot");
		if (kind === "root-skill-selection" && (![pendingExplicitSkill?.name, observedRootSkill?.name].includes(selected?.name))) throw new Error("root Skill activation lacks observable user selection provenance");
		const requestId = digest({ request: pendingRequest, workspaceRoot }).slice(0, 32);
		const proposal = await freezeProposal(workspaceRoot, [{ role: "user", text: pendingRequest }], artifactPaths);
		const admission = admitRootRole(requestId, kind, role, 0, digest({ proposal: proposal.sha256, snapshot: snapshot.sha256, selected: selected?.name ?? null }));
		const workers: SelectedWorker[] = selected ? [{ intent: role === "none" ? "implementation" : role, name: selected.name, description: selected.description, sourcePath: selected.sourcePath }] : [];
		return updateSessionState(newSessionState(requestId, workspaceRoot), {
			lifecycle: "normalize", formalRole: role, stageOrdinal: admission.stageOrdinal,
			stageInstanceId: admission.stageInstanceId, admissionKind: admission.kind,
			admissionSha256: admission.admissionSha256, skillSnapshotSha256: snapshot.sha256, proposal, workers,
		});
	}

	function childState(dispatch: ReturnType<typeof buildChildDispatch>, taskId: string | null, attemptId: string | null): NonNullable<HarnessSessionStateV1["pendingChild"]> {
		return {
			dispatchId: dispatch.dispatchId,
			intent: dispatch.intent,
			expectedTool: dispatch.expectedTool,
			status: "scheduled",
			command: dispatch.command,
			brief: dispatch.brief,
			taskId,
			attemptId,
		};
	}

	pi.registerTool({
		name: "workflow_activate", label: "Activate Managed Workflow",
		description: "Admit the current root request after current Pi Skill discovery.",
		promptSnippet: "Activate only a current user root; extension children cannot activate roots",
		parameters: Type.Object({
			formalRole: Type.Union(ROLES.map((role) => Type.Literal(role))),
			selectedName: Type.String({ minLength: 1, maxLength: 96 }),
			snapshotSha256: Type.String({ minLength: 64, maxLength: 64 }),
			artifactPaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			if (authorityError) throw new Error(authorityError);
			persist(await activate(params.formalRole, params.selectedName, params.artifactPaths, "root-skill-selection", params.snapshotSha256));
			return textResult("Managed workflow activated; normalize a complete typed graph before mutation.", { requestId: state?.requestId, proposalSha256: state?.proposal?.sha256 });
		},
	});

	pi.registerTool({
		name: "workflow_submit_graph", label: "Submit Workflow Graph",
		description: "Submit one closed task graph bound to the frozen proposal and semantic completeness result.",
		promptSnippet: "Deterministic graph admission precedes every managed mutation",
		parameters: Type.Object({
			proposalSha256: Type.String({ minLength: 64, maxLength: 64 }), graph: Type.Any(),
			semanticCheck: Type.Object({ omittedWork: Type.Array(Type.String()), inventedWork: Type.Array(Type.String()), unauthorizedReordering: Type.Array(Type.String()) }, { additionalProperties: false }),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			if (!state?.proposal || state.lifecycle !== "normalize") throw new Error("graph submission is unavailable in the current lifecycle state");
			const graph = admitNormalization({ schemaVersion: 1, ...params }, state.proposal.sha256);
			if (graph.requestId !== state.requestId) throw new Error("graph request ID does not match the active root");
			if (graph.approved) throw new Error("graph approval is a separate direct controller transition");
			if (state.formalRole !== "none" && graph.rootFormalRole !== state.formalRole) throw new Error("graph root role conflicts with observed root admission");
			persist(updateSessionState(state, { graph, progress: initialProgress(graph), lifecycle: "approval" }));
			return textResult(`Graph ${graph.graphId} admitted with ${graph.tasks.length} task(s).`, { graphId: graph.graphId });
		},
	});

	pi.registerTool({
		name: "workflow_update_task", label: "Update Managed Task",
		description: "Start a ready task, submit its typed worker result, record an independent oracle, or complete verified work.",
		promptSnippet: "Only typed task actions advance harness-owned attempts",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("worker-result"), Type.Literal("verify"), Type.Literal("retry"), Type.Literal("complete")]),
			taskId: Type.String({ minLength: 1, maxLength: 96 }), attemptId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
			outcome: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("blocked"), Type.Literal("needs-input")])),
			evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 32 })),
			observedOperationIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 128 })),
			oracle: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), passed: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			if (!state?.graph) throw new Error("no graph is admitted");
			if (params.action === "start") {
				if (!state.graph.approved || state.lifecycle !== "execute") throw new Error("task start requires a separately approved graph");
				const started = startTaskAttempt(state.graph, state.progress, state.execution, params.taskId);
				const task = state.graph.tasks.find((item) => item.taskId === params.taskId)!;
				const selected = state.workers.find((worker) => worker.intent === "implementation");
				const worker = selected ? { name: selected.name, description: selected.description, sourcePath: selected.sourcePath } : null;
				const dispatch = buildChildDispatch(state.requestId, "implementation", `Execute task ${task.taskId} attempt ${started.attempt.ordinal}. Writes are limited to ${task.writePaths.join(", ") || "none"}. Return only through workflow_update_task action worker-result for attempt ${started.attempt.attemptId}.`, "workflow_update_task", worker);
				const next = updateSessionState(state, { lifecycle: "execute", progress: started.progress, execution: started.execution });
				persist(schedulePendingChild(next, childState(dispatch, task.taskId, started.attempt.attemptId)));
				return { ...textResult(`Started ${params.taskId} attempt ${started.attempt.ordinal}.`, { attemptId: started.attempt.attemptId }), terminate: true };
			}
			if (params.action === "worker-result") {
				if (!params.attemptId || !params.outcome || !params.evidence || !params.observedOperationIds) throw new Error("worker-result fields are incomplete");
				if (!state.pendingChild || state.pendingChild.expectedTool !== "workflow_update_task" || state.pendingChild.attemptId !== params.attemptId || state.pendingChild.taskId !== params.taskId) throw new Error("worker result lacks an exact active child dispatch");
				const execution = acceptWorkerResult(state.execution, { taskId: params.taskId, attemptId: params.attemptId, outcome: params.outcome, evidence: params.evidence, observedOperationIds: params.observedOperationIds });
				const withoutChild = completePendingChild(state, state.pendingChild.dispatchId);
				persist(updateSessionState(withoutChild, { execution, lifecycle: params.outcome === "pass" ? "verify" : "execute" }));
				return { ...textResult(`Recorded typed worker outcome ${params.outcome}.`), terminate: true };
			}
			if (params.action === "verify") {
				if (!params.oracle || params.passed === undefined) throw new Error("verification fields are incomplete");
				persist(updateSessionState(state, { execution: recordVerification(state.graph, state.execution, params.taskId, params.oracle, params.passed), lifecycle: "verify" }));
				return textResult(`Recorded independent verification for ${params.taskId}.`);
			}
			if (params.action === "retry") {
				const retried = retryTask(state.graph, state.progress, state.execution, params.taskId);
				persist(updateSessionState(state, { progress: retried.progress, execution: retried.execution, lifecycle: retried.exhausted ? "blocked" : "execute", terminalOutcome: retried.exhausted ? "non-convergent" : null }));
				return textResult(retried.exhausted ? "Attempt budget exhausted with typed non-convergent outcome." : "Task returned to ready state for its bounded retry.");
			}
			const complete = completeVerifiedTask(state.graph, state.progress, state.execution, params.taskId);
			let reasons = state.reviewReasons;
			const task = state.graph.tasks.find((item) => item.taskId === params.taskId);
			if (task?.review.required) reasons = recordStandaloneReview(reasons, state.proposal?.sha256 ?? digest(state.graph), `task:${params.taskId}`);
			persist(updateSessionState(state, { progress: complete.progress, execution: complete.execution, reviewReasons: reasons, lifecycle: "assess" }));
			return textResult(`Completed verified task ${params.taskId}; assessment is controller-owned.`);
		},
	});

	pi.registerTool({
		name: "workflow_complete_stage", label: "Complete Managed Stage",
		description: "Record a bounded stage target and enqueue one formal review reason when applicable.",
		promptSnippet: "Formal review is keyed once by the stable stage instance",
		parameters: Type.Object({ artifactPaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 128 }), acceptanceKey: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
		async execute(_id, params) {
			if (!state?.proposal || state.settled || state.stageCompleted) throw new Error("no incomplete active stage");
			const active = state;
			if (active.formalRole !== "none" && params.artifactPaths.length === 0) throw new Error("formal stage completion requires exact workspace artifact targets");
			if (active.graph && !active.graph.terminalTaskIds.every((taskId) => active.progress[taskId]?.status === "complete")) throw new Error("stage completion requires terminal graph work");
			const frozen = await freezeProposal(workspaceRoot, active.proposal!.messages, params.artifactPaths);
			const stageTarget = { sha256: frozen.sha256, acceptanceKey: params.acceptanceKey, artifacts: frozen.artifacts };
			const reasons = active.stageInstanceId ? recordFormalReview(active.reviewReasons, active.stageInstanceId, stageTarget.sha256, params.acceptanceKey) : active.reviewReasons;
			persist(updateSessionState(active, { stageTarget, stageCompleted: true, reviewReasons: reasons, lifecycle: reasons.some((reason) => reason.status === "pending") ? "assess" : "verify" }));
			return { ...textResult(reasons.length > active.reviewReasons.length ? "Formal review reason recorded." : "No automatic review reason applies."), terminate: true };
		},
	});

	pi.registerTool({
		name: "workflow_submit_review", label: "Submit Managed Review",
		description: "Submit typed candidate findings for the pending read-only review dispatch.",
		promptSnippet: "Review evidence never grants repair authority by itself",
		parameters: Type.Object({
			dispatchId: Type.String({ minLength: 1, maxLength: 256 }), targetSha256: Type.String({ minLength: 64, maxLength: 64 }), acceptanceKey: Type.String({ minLength: 1, maxLength: 256 }),
			outcome: Type.Union([Type.Literal("pass"), Type.Literal("findings"), Type.Literal("blocked")]),
			findings: Type.Array(Type.Object({ findingId: Type.String({ minLength: 1, maxLength: 96 }), severity: Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("minor")]), evidence: Type.String({ minLength: 1, maxLength: 2000 }), withinSlice: Type.Boolean(), proposedRepairPaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 }) }, { additionalProperties: false }), { maxItems: 64 }),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			if (!state?.pendingChild || state.pendingChild.dispatchId !== params.dispatchId) throw new Error("review result is stale or not pending");
			const batch = nextReviewBatch(state.reviewReasons);
			if (!batch || batch.dispatchId !== params.dispatchId || batch.targetSha256 !== params.targetSha256 || batch.acceptanceKey !== params.acceptanceKey) throw new Error("review result does not match the frozen target");
			const result = { ...params, findings: params.findings.map((item) => ({ ...item })) };
			const withoutChild = completePendingChild(state, params.dispatchId);
			persist(updateSessionState(withoutChild, { execution: { ...state.execution, pendingReviewResult: result }, lifecycle: "assess" }));
			return { ...textResult(`Review ${params.outcome} evidence recorded; controller adjudication remains pending.`), terminate: true };
		},
	});

	pi.registerTool({
		name: "workflow_adjudicate_review", label: "Adjudicate Managed Review",
		description: "Accept or reject bounded candidate findings after the read-only reviewer has returned.",
		promptSnippet: "Only the controller may admit one same-slice repair",
		parameters: Type.Object({ dispatchId: Type.String({ minLength: 1, maxLength: 256 }), acceptedFindingIds: Type.Array(Type.String({ minLength: 1, maxLength: 96 }), { maxItems: 64 }) }, { additionalProperties: false }),
		async execute(_id, params) {
			if (!state?.execution.pendingReviewResult || state.pendingChild) throw new Error("no review evidence is ready for controller adjudication");
			const result = state.execution.pendingReviewResult;
			if (result.dispatchId !== params.dispatchId) throw new Error("review adjudication is stale");
			const batch = nextReviewBatch(state.reviewReasons);
			if (!batch || batch.dispatchId !== params.dispatchId) throw new Error("review reason is stale or already consumed");
			const baseExecution = { ...state.execution, pendingReviewResult: null };
			const judged = adjudicateReview(baseExecution, result, params.acceptedFindingIds);
			let execution = judged.execution;
			let next = updateSessionState(state, { execution, reviewReasons: consumeReviewBatch(state.reviewReasons, batch), lifecycle: result.outcome === "blocked" ? "blocked" : "verify", terminalOutcome: result.outcome === "blocked" ? "blocked" : null });
			if (judged.adjudication.acceptedFindingIds.length > 0) {
				const task = state.graph?.tasks.find((item) => result.findings.some((finding) => finding.proposedRepairPaths.some((path) => item.writePaths.some((scope) => path === scope || path.startsWith(`${scope}/`)))));
				if (!task) throw new Error("accepted review repair has no admitted same-slice task");
				execution = admitFocusedRepair(execution, result, judged.adjudication, task);
				const selected = state.workers.find((worker) => worker.intent === "implementation");
				const worker = selected ? { name: selected.name, description: selected.description, sourcePath: selected.sourcePath } : null;
				const dispatch = buildChildDispatch(state.requestId, "implementation", `Apply only accepted findings ${judged.adjudication.acceptedFindingIds.join(", ")} inside task ${task.taskId}. Return through workflow_complete_repair action worker-result for ${execution.repairContext?.attemptId}.`, "workflow_complete_repair", worker);
				next = schedulePendingChild(updateSessionState(state, { execution, reviewReasons: consumeReviewBatch(state.reviewReasons, batch), lifecycle: "execute" }), childState(dispatch, task.taskId, execution.repairContext?.attemptId ?? null));
			}
			persist(next);
			return { ...textResult(`Controller adjudicated review; accepted repairs: ${judged.adjudication.acceptedFindingIds.length}.`), terminate: judged.adjudication.acceptedFindingIds.length > 0 };
		},
	});

	pi.registerTool({
		name: "workflow_complete_repair", label: "Complete Focused Repair",
		description: "Close the one admitted same-slice repair after focused verification evidence exists.",
		promptSnippet: "Repair cannot expand its accepted finding set",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("worker-result"), Type.Literal("verify"), Type.Literal("complete")]),
			findingIds: Type.Array(Type.String({ minLength: 1, maxLength: 96 }), { minItems: 1, maxItems: 64 }),
			evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 32 })),
			observedOperationIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 128 })),
			oracle: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
			passed: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			if (!state?.graph || !state.execution.repairContext) throw new Error("no focused repair is active");
			const repair = state.execution.repairContext;
			if (params.action === "worker-result") {
				if (!state.pendingChild || state.pendingChild.attemptId !== repair.attemptId || !params.evidence || !params.observedOperationIds) throw new Error("repair worker result lacks an exact child dispatch");
				const execution = acceptWorkerResult(state.execution, { taskId: repair.taskId, attemptId: repair.attemptId, outcome: "pass", evidence: params.evidence, observedOperationIds: params.observedOperationIds });
				const withoutChild = completePendingChild(state, state.pendingChild.dispatchId);
				persist(updateSessionState(withoutChild, { execution, lifecycle: "verify" }));
				return { ...textResult("Focused repair worker evidence recorded; fresh verification is required."), terminate: true };
			}
			if (params.action === "verify") {
				if (!params.oracle || params.passed === undefined) throw new Error("repair verification fields are incomplete");
				persist(updateSessionState(state, { execution: recordVerification(state.graph, state.execution, repair.taskId, params.oracle, params.passed), lifecycle: "verify" }));
				return textResult("Recorded fresh focused-repair verification.");
			}
			persist(updateSessionState(state, { execution: completeFocusedRepair(state.execution, params.findingIds), lifecycle: "verify" }));
			return textResult("Focused repair completed after fresh admitted verification.");
		},
	});

	pi.registerTool({
		name: "workflow_settle", label: "Settle Managed Workflow",
		description: "Settle only after graph work, review, repair, child calls, and verification converge.",
		promptSnippet: "Assistant prose cannot settle managed state",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			if (!state) throw new Error("no active workflow");
			const result = settle({
				graph: state.graph, progress: state.progress, execution: state.execution,
				reviewReasons: state.reviewReasons, pendingChild: state.pendingChild,
				formalRole: state.formalRole, stageInstanceId: state.stageInstanceId,
				stageCompleted: state.stageCompleted, stageTargetSha256: state.stageTarget?.sha256 ?? null,
			});
			persist(updateSessionState(state, { lifecycle: "settle", terminalOutcome: result.outcome, settled: true }));
			return { ...textResult("Workflow settled with typed pass outcome.", result), terminate: true };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		workspaceRoot = ctx.cwd;
		try {
			state = replaySessionState(ctx.sessionManager.getBranch());
		} catch {
			state = updateSessionState(newSessionState("replay-blocked", ctx.cwd), { lifecycle: "blocked", terminalOutcome: "blocked" });
			persist(state);
		}
		try {
			const settingsRoot = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
			const parsed = JSON.parse(await readFile(join(settingsRoot, "settings.json"), "utf8")) as Record<string, unknown>;
			if (parsed.workflowHarness !== undefined) loadAuthoritySettings(parsed.workflowHarness);
			authorityError = undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") authorityError = undefined;
			else authorityError = error instanceof Error ? error.message : "invalid local authority settings";
		}
		refresh(ctx);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") {
			if (state?.pendingChild && state.pendingChild.intent !== "review") {
				const selected = explicitSkillSelection(event.text, snapshotSkills(pi.getCommands()));
				if (selected && /\b(review|inspect|assess|audit)\b/i.test(selected.description)) {
					const targetSha256 = state.stageTarget?.sha256 ?? state.proposal?.sha256;
					if (!targetSha256) return { action: "handled" };
					persist(updateSessionState(state, { reviewReasons: recordWorkerRequestedReview(state.reviewReasons, state.stageInstanceId, targetSha256, state.stageTarget?.acceptanceKey ?? `child:${state.pendingChild.dispatchId}`) }));
					return { action: "handled" };
				}
			}
			return { action: "continue" };
		}
		pendingRequest = event.text;
		pendingExplicitSkill = explicitSkillSelection(event.text, snapshotSkills(pi.getCommands()));
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (!state || state.settled) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n## Managed Workflow Boundary\n\nRequest ${state.requestId} is in ${state.lifecycle}. The host owns graph admission, authority, attempts, review dispatch, repair, replay, verification, and settlement. Use only workflow_* typed tools to advance mechanical state; prose and child output are evidence only.` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state) {
			observedRootSkill = correlateSkillRead(event.toolName, event.input, snapshotSkills(pi.getCommands())) ?? observedRootSkill;
			return undefined;
		}
		if (state.settled) return undefined;
		if ((HARNESS_TOOLS as readonly string[]).includes(event.toolName)) {
			if (state.pendingChild && event.toolName !== state.pendingChild.expectedTool) return { block: true, reason: "child actor may call only its exact typed result tool", terminate: true };
			return undefined;
		}
		const task = activeTask(state);
		const authority = state.execution.exactUserAuthorities.find((item) => !item.consumed && item.taskId === task?.taskId && item.toolName === event.toolName);
		const decision = gateToolCall(event.toolName, event.input, {
			workspaceRoot: ctx.cwd,
			lifecycle: state.lifecycle,
			...(task ? { task } : {}),
			...(state.execution.activeAttemptId ? { attemptId: state.execution.activeAttemptId } : {}),
			...(authority ? { exactUserAuthority: authority } : {}),
		});
		if (!decision.allow) {
			notify(ctx, decision.reason ?? "blocked by managed workflow", "warning");
			return { block: true, reason: decision.reason ?? "blocked by managed workflow" };
		}
		if (decision.operation) {
			let execution = recordObservedOperation(state.execution, decision.operation);
			if (authority && decision.operation.suspendedContainment) execution = { ...execution, exactUserAuthorities: execution.exactUserAuthorities.map((item) => item.authorityId === authority.authorityId ? consumeExactUserAuthority(item) : item) };
			persist(updateSessionState(state, { execution }));
			pendingOperations.set(event.toolCallId, decision.operation.operationId);
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => { pendingOperations.delete(event.toolCallId); });

	pi.on("agent_end", async () => {
		if (!state || state.settled) return;
		if (state.pendingChild) {
			if (state.pendingChild.status === "dispatched") return;
			const pending = state.pendingChild;
			const message = `${pending.command ? `${pending.command}\n\n` : ""}${pending.brief}\n\nChild marker: ${JSON.stringify({ schemaVersion: 1, runId: state.requestId, dispatchId: pending.dispatchId, rootActivation: false })}`;
			persist(markPendingChildDispatched(state, pending.dispatchId));
			pi.sendUserMessage(message, { deliverAs: "followUp", expandPromptTemplates: true });
			return;
		}
		if (state.execution.pendingReviewResult) {
			if (state.lifecycle === "assess") {
				persist(updateSessionState(state, { lifecycle: "approval" }));
				pi.sendUserMessage(`Review evidence ${state.execution.pendingReviewResult.dispatchId} is ready. As controller, call workflow_adjudicate_review with accepted finding IDs only after evidence adjudication.`, { deliverAs: "followUp" });
			}
			return;
		}
		const batch = nextReviewBatch(state.reviewReasons);
		if (!batch) return;
		const worker = reviewWorker(snapshotSkills(pi.getCommands()).skills);
		const targetRefs = state.stageTarget?.artifacts.map((item) => `${item.path}@${item.sha256}`).join(", ") || "digest-only standalone target";
		const dispatch = buildChildDispatch(state.requestId, "review", `Review frozen target ${batch.targetSha256} (${targetRefs}) against ${batch.acceptanceKey}. Return candidate findings only through workflow_submit_review using dispatch ${batch.dispatchId}. Do not adjudicate, schedule another review, or reopen upstream phases.`, "workflow_submit_review", worker);
		const pending = { ...childState(dispatch, null, null), dispatchId: batch.dispatchId };
		const scheduled = schedulePendingChild(state, pending);
		persist(markPendingChildDispatched(scheduled, batch.dispatchId));
		const message = `${pending.command ? `${pending.command}\n\n` : ""}${pending.brief}\n\nChild marker: ${JSON.stringify({ schemaVersion: 1, runId: state.requestId, dispatchId: pending.dispatchId, rootActivation: false })}`;
		pi.sendUserMessage(message, { deliverAs: "followUp", expandPromptTemplates: true });
	});

	pi.on("agent_settled", async (_event, ctx) => { refresh(ctx); });

	pi.registerCommand(WORKFLOW_HARNESS_STATUS_COMMAND, {
		description: "Inspect generic workflow state without exposing request content",
		handler: async (_args, ctx) => { notify(ctx, publicStatus(state, authorityError), authorityError ? "warning" : "info"); },
	});

	pi.registerCommand(WORKFLOW_RUN_COMMAND, {
		description: "Explicitly admit a root role: design, planning, implementation, or none",
		handler: async (args, ctx) => {
			const [role, selectedName] = args.trim().split(/\s+/, 2);
			if (!ROLES.includes(role as typeof ROLES[number])) throw new Error("usage: /workflow-run design|planning|implementation|none [current-skill-name]");
			pendingRequest = args;
			persist(await activate(role as typeof ROLES[number], selectedName, [], "explicit-role"));
			notify(ctx, "Managed root admitted; graph normalization is next.");
			if (selectedName) pi.sendUserMessage(`/skill:${selectedName}`, { expandPromptTemplates: true });
		},
	});

	pi.registerCommand(WORKFLOW_APPROVE_COMMAND, {
		description: "Approve exactly the currently admitted graph as a direct controller transition",
		handler: async (args, ctx) => {
			if (!state?.graph || state.lifecycle !== "approval" || args.trim() !== state.graph.graphId) throw new Error("usage: /workflow-approve <current-graph-id>");
			let changes: Partial<HarnessSessionStateV1> = { graph: { ...state.graph, approved: true }, lifecycle: "execute" };
			if (state.formalRole === "none" && state.graph.rootFormalRole !== "none") {
				const admission = admitRootRole(state.requestId, "approved-graph", state.graph.rootFormalRole, state.stageOrdinal, digest({ proposal: state.proposal?.sha256, graph: state.graph }));
				changes = { ...changes, formalRole: state.graph.rootFormalRole, admissionKind: admission.kind, admissionSha256: admission.admissionSha256, stageInstanceId: admission.stageInstanceId };
			}
			persist(updateSessionState(state, changes));
			notify(ctx, `Graph ${state.graph.graphId} approved; ready task execution may begin.`);
		},
	});

	pi.registerCommand(WORKFLOW_REVIEW_COMMAND, {
		description: "Start one independent standalone workspace-artifact review without creating an upstream lifecycle",
		handler: async (args, ctx) => {
			const [artifactPath, acceptanceKey = "standalone"] = args.trim().split(/\s+/, 2);
			if (!artifactPath) throw new Error("usage: /workflow-review <workspace-artifact-path> [acceptance-key]");
			const frozen = await freezeProposal(ctx.cwd, [{ role: "user", text: "standalone bounded review" }], [artifactPath]);
			const requestId = digest({ targetSha256: frozen.sha256, acceptanceKey }).slice(0, 32);
			persist(updateSessionState(newSessionState(requestId, ctx.cwd), { lifecycle: "assess", stageCompleted: true, stageTarget: { sha256: frozen.sha256, acceptanceKey, artifacts: frozen.artifacts }, reviewReasons: recordStandaloneReview([], frozen.sha256, acceptanceKey) }));
			notify(ctx, "Standalone review admitted without an upstream stage.");
		},
	});

	pi.registerCommand(WORKFLOW_AUTHORIZE_COMMAND, {
		description: "Authorize one exact uncontained tool input for one active task and record suspended containment",
		handler: async (args, ctx) => {
			if (!state) throw new Error("no active workflow");
			const first = args.indexOf(" ");
			const second = first < 0 ? -1 : args.indexOf(" ", first + 1);
			if (first < 1 || second < 0) throw new Error("usage: /workflow-authorize <task-id> <tool-name> <json-input>");
			const taskId = args.slice(0, first);
			const toolName = args.slice(first + 1, second);
			const toolInput = JSON.parse(args.slice(second + 1)) as unknown;
			const authority = issueExactUserAuthority({ authorityId: digest({ requestId: state.requestId, taskId, toolName, toolInput, ordinal: state.execution.exactUserAuthorities.length }), taskId, toolName, toolInput, source: "user" });
			persist(updateSessionState(state, { execution: { ...state.execution, exactUserAuthorities: [...state.execution.exactUserAuthorities, authority] } }));
			notify(ctx, "One exact operation authorized; path containment will be marked suspended if used.", "warning");
		},
	});
}
