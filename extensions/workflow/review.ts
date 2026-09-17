/**
 * Settlement reconciliation policy (WF-04).
 *
 * At a normal, successful settlement the workflow computes the remaining obligation contract
 * and, when a real deficit remains and the finite allowance permits, asks the same main agent to
 * reconcile. It never diagnoses why the model stopped, never replays interrupted work, and never
 * launches a second model. Automatic dispatch is limited to interactive/RPC hosts where a
 * follow-up turn can actually run; print/json startup would exit before it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_LIMITS, WORKFLOW_TOOL_NAME, type Deficit, type Task, type WorkflowErrorCode, type WorksetState } from "./contracts.ts";
import type { SettlementBarrier } from "./settlement.ts";
import { computeDeficits } from "./reducer.ts";
import type { WorkflowStore } from "./store.ts";

export const REVIEW_PROMPT_MARKER = "[workflow-reconciliation]";

export interface ReviewRuntime {
	lastRunStop: string | null;
	compactFailed: boolean;
	uiPromptDepth: number;
}

export interface ReviewPolicy {
	runtime: ReviewRuntime;
}

interface ReviewLease {
	worksetId: string;
	generation: number;
	fingerprint: string;
}

const waitingTask = (task: Task): boolean => (task.disposition === "blocked" && task.nextUnblockCondition !== undefined) || task.disposition === "paused";
const activeTask = (task: Task): boolean => task.disposition !== "superseded" && task.disposition !== "cancelled";

/** A deficit is actionable only when some remaining obligation lacks an explicit waiting disposition. */
export function hasActionableDeficit(state: WorksetState, deficits: readonly Deficit[]): boolean {
	if (deficits.length === 0) return false;
	if (deficits.some((deficit) => deficit.code === "needs_alignment" || deficit.code === "workset_not_active")) return false;
	const tasks = Object.values(state.tasks).filter((task) => task.worksetId === state.workset.id);
	if (deficits.some((deficit) => deficit.code === "open_attempts")) {
		if (Object.values(state.attempts).some((attempt) => attempt.worksetId === state.workset.id && attempt.state === "unknown")) return true;
	}
	if (tasks.some((task) => (task.disposition === "pending" || task.disposition === "awaiting_acceptance" || task.disposition === "running") && !waitingTask(task))) return true;
	const pendingCriteria = new Set(deficits.filter((deficit) => deficit.code === "unaccepted_criteria").flatMap((deficit) => deficit.ids));
	const unaccepted = Object.values(state.criteria).filter((criterion) => criterion.worksetId === state.workset.id && criterion.required && criterion.disposition !== "retired" && (criterion.disposition !== "accepted" || pendingCriteria.has(criterion.id)));
	if (unaccepted.some((criterion) => {
		const routes = tasks.filter((task) => activeTask(task) && task.covers.includes(criterion.id));
		return routes.length === 0 || routes.every((task) => task.disposition === "accepted");
	})) return true;
	if (deficits.some((deficit) => deficit.code === "missing_delivery_evidence")) {
		// Missing delivery evidence is actionable only when some active obligation is not waiting on
		// an external condition; otherwise the agent cannot legitimately produce it yet.
		const activeUnfinished = tasks.filter((task) => activeTask(task) && task.disposition !== "accepted");
		if (activeUnfinished.length === 0 || !activeUnfinished.every(waitingTask)) return true;
	}
	return false;
}

/** Structural progress only: no timestamps, revisions, id counters, or pending/running toggles. */
export function progressFingerprint(state: WorksetState): string {
	const payload = {
		goalRevision: state.workset.goalRevision,
		criteria: Object.values(state.criteria)
			.filter((criterion) => criterion.worksetId === state.workset.id)
			.map((criterion) => [criterion.id, criterion.semanticRevision, criterion.disposition, criterion.required])
			.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
		tasks: Object.values(state.tasks)
			.filter((task) => task.worksetId === state.workset.id)
			.map((task) => [task.id, task.semanticRevision, task.disposition === "running" ? "pending" : task.disposition, [...task.covers].sort(), [...task.dependsOn].sort()])
			.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
		// Allocated record ids are excluded: repeating the same recorded fact is not progress.
		evidence: [...new Set(Object.values(state.evidence)
			.filter((evidence) => evidence.worksetId === state.workset.id)
			.map((evidence) => JSON.stringify([evidence.subject.kind, evidence.subject.id, evidence.check.identity, evidence.check.result, evidence.freshness, evidence.basis.fingerprint])))].sort(),
		attempts: [...new Set(Object.values(state.attempts)
			.filter((attempt) => attempt.worksetId === state.workset.id && attempt.state !== "running")
			.map((attempt) => JSON.stringify([attempt.taskId, attempt.taskRevision, attempt.state, attempt.basis.fingerprintState, attempt.basis.fingerprint])))].sort(),
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function stopReasonOf(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; stopReason?: string } | undefined;
		if (message?.role === "assistant") return message.stopReason ?? "unknown";
	}
	return "unknown";
}

export function reviewPrompt(state: WorksetState, deficits: readonly Deficit[], lease: ReviewLease): string {
	const lines = [
		`${REVIEW_PROMPT_MARKER} workset ${lease.worksetId} revision ${state.revision}, delivered input generation ${lease.generation}.`,
		"Settlement left unresolved obligations:",
		...deficits.slice(0, 8).map((deficit) => `- ${deficit.code}: ${deficit.message.slice(0, 240)}`),
		"Choose one concrete action and call csheng_workflow:",
		"1. record work already completed with real evidence, then assess it;",
		"2. continue the authorized remaining work;",
		"3. amend or retire work that current user intent no longer requires;",
		"4. record a real block with its next unblock condition; or",
		"5. cancel the workset.",
		"Do not repeat the whole plan or rerun unchanged checks. Inspect first when the state is unclear.",
	];
	return lines.join("\n").slice(0, WORKFLOW_LIMITS.maxGoal);
}

export interface ReviewPolicyDeps {
	/** True while a model-prepared input observation has not committed; host queues are checked separately. */
	pendingHumanInput(): boolean;
	/** A command-context wait armed during the active run; absent/unarmed means no dispatch. */
	barrier?: SettlementBarrier;
}

const MISSING_HOST_CONTRACT = "host_contract_unavailable: no active public command waiter was established; automatic dispatch is disabled for this run";

export function registerReviewPolicy(pi: ExtensionAPI, store: WorkflowStore, deps: ReviewPolicyDeps): ReviewPolicy {
	const runtime: ReviewRuntime = { lastRunStop: null, compactFailed: false, uiPromptDepth: 0 };
	const recordBlocked = (state: WorksetState, fingerprint: string, reason: string): void => {
		if (state.workset.review.lastFingerprint === fingerprint && state.workset.review.pausedReason === reason) return;
		store.apply(
			{ operation: "review", expectedRevision: state.revision, action: "blocked", fingerprint, reason },
			{ now: new Date().toISOString(), cwd: "", sessionId: "" },
			`review-blocked-${randomUUID()}`,
		);
	};
	pi.on("agent_end", (event) => {
		runtime.lastRunStop = stopReasonOf(event.messages);
	});
	pi.on("session_compact_failed", () => {
		runtime.compactFailed = true;
	});
	pi.on("session_compact", () => {
		runtime.compactFailed = false;
	});
	pi.on("ui_prompt_start", () => {
		runtime.uiPromptDepth += 1;
	});
	pi.on("ui_prompt_end", () => {
		runtime.uiPromptDepth = Math.max(0, runtime.uiPromptDepth - 1);
	});
	const reconcile = (ctx: ExtensionContext, canDispatch: boolean): void => {
		const state = store.current();
		if (!state || state.workset.disposition !== "active") return;
		if (state.workset.alignment.state !== "aligned") return;
		if (canDispatch && (!ctx.isProjectTrusted() || !pi.getActiveTools().includes(WORKFLOW_TOOL_NAME))) return;
		if (runtime.lastRunStop !== "stop" || runtime.compactFailed || runtime.uiPromptDepth > 0) return;
		if (ctx.hasPendingMessages() || deps.pendingHumanInput()) return;
		const deficits = computeDeficits(state);
		if (!hasActionableDeficit(state, deficits)) return;
		const fingerprint = progressFingerprint(state);
		const review = state.workset.review;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
			recordBlocked(state, fingerprint, `mode_unsupported: automatic reconciliation does not run in ${ctx.mode} mode`);
			return;
		}
		if (review.lastFingerprint === fingerprint) {
			recordBlocked(state, fingerprint, "no_progress: the obligation contract did not change since the last review decision");
			return;
		}
		if (review.used >= state.workset.reviewPolicy.maxAutomaticReviewsPerInputEpoch) {
			recordBlocked(state, fingerprint, "allowance_exhausted: the finite automatic-review allowance is spent for this input generation");
			return;
		}
		if (!canDispatch) {
			recordBlocked(state, fingerprint, MISSING_HOST_CONTRACT);
			return;
		}
		const lease: ReviewLease = { worksetId: state.workset.id, generation: state.workset.inputGeneration, fingerprint };
		const recorded = store.apply(
			{ operation: "review", expectedRevision: state.revision, action: "dispatched", fingerprint },
			{ now: new Date().toISOString(), cwd: "", sessionId: "" },
			`review-${lease.generation}-${lease.fingerprint.slice(0, 12)}`,
		);
		if (!recorded.ok) return;
		pi.sendUserMessage(reviewPrompt(recorded.state, deficits, lease));
	};
	pi.on("agent_settled", (_event, ctx) => {
		// Final eligibility, state, UI and budget checks happen after ALL settlement consumers.
		if (deps.barrier?.schedule((settledContext) => reconcile(settledContext, true))) return;
		reconcile(ctx, false);
	});

	return { runtime };
}

/** Typed compatibility result for hosts where automatic dispatch is not supported. */
export function reviewCompatibilityError(mode: string): { code: WorkflowErrorCode; message: string } {
	return { code: "invalid_transition", message: `Automatic reconciliation requires an interactive or RPC host; current mode is ${mode}.` };
}
