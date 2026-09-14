import {
	HANDOFF_RESULT_SCHEMA_VERSION,
	handoffErrorMessage,
	HARD_LIMITS,
	initialHandoffMachine,
	ownsLiveHandle,
	transitionHandoff,
	utf8Bytes,
	type BeginHandoffInput,
	type BridgeStatus,
	type CancelHandoffInput,
	type ContinueHandoffInput,
	type HandoffAction,
	type HandoffErrorCode,
	type HandoffMachine,
	type HandoffMode,
	type HandoffResult,
	type HandoffToolInput,
	type PublicHandoffHandle,
	type RouteEvidence,
	type WaitHandoffInput,
	type WorkspaceStatus,
} from "./contracts.ts";
import { getLaunchProfile, loadLaunchConfig, type LaunchConfigLoadResult } from "./config.ts";
import {
	buildHandoffPrompt,
	createHandoffId,
	parseRecipientReturn,
	readCanonicalPlan,
} from "./envelope.ts";
import { HerdrClient, type AgentSnapshot } from "./herdr-client.ts";
import {
	assertManagedParent,
	captureBaseline,
	inspectPostflight,
	resolveGitIdentity,
	validateAllowedWrites,
	validateCreatedWorktree,
	validateRecipientWorktree,
	type WorkspaceBaseline,
} from "./workspace.ts";

export interface CoordinatorContext {
	cwd: string;
	signal?: AbortSignal;
	trusted: boolean;
}

export interface CoordinatorDependencies {
	client: HerdrClient;
	loadLaunchConfig(): Promise<LaunchConfigLoadResult>;
	now(): number;
	createHandoffId?(): string;
}

interface Fingerprint {
	paneId: string;
	workspaceId: string;
	tabId: string;
	kind?: string;
	sessionFingerprint?: string;
	worktreeRoot: string;
	commonDir: string;
}

interface Session {
	token: string;
	handoffId: string;
	mode: HandoffMode;
	planSha256: string;
	allowedWrites: string[];
	fingerprint: Fingerprint;
	handle: PublicHandoffHandle;
	baseline?: WorkspaceBaseline;
	routeEvidence: RouteEvidence;
	recipientCwd: string;
}

function agentName(handoffId: string): string {
	return `h${handoffId.replaceAll("-", "").slice(0, 31)}`;
}

export class HandoffCoordinator {
	private readonly dependencies: CoordinatorDependencies;
	private machine: HandoffMachine = initialHandoffMachine();
	private session: Session | undefined;
	private active = false;

	constructor(dependencies: CoordinatorDependencies) {
		this.dependencies = dependencies;
	}

	status(): { active: boolean; handle?: PublicHandoffHandle; machine: HandoffMachine } {
		return {
			active: this.active,
			...(this.session === undefined ? {} : { handle: this.session.handle }),
			machine: this.machine,
		};
	}

	async dispatch(input: HandoffToolInput, ctx: CoordinatorContext): Promise<HandoffResult> {
		if (!ctx.trusted) {
			return this.fail(input.action, this.session?.mode ?? "delegate-return", this.session?.handoffId ?? "", this.session?.planSha256 ?? "", this.dependencies.now(), "invalid_handoff_request");
		}
		if (input.action === "begin") return this.begin(input, ctx);
		if (input.action === "continue") return this.continue(input, ctx);
		if (input.action === "wait") return this.wait(input, ctx);
		return this.cancel(input, ctx);
	}

	async shutdown(): Promise<void> {
		if (!this.active || this.machine.mode === "transfer" || !this.session) {
			this.active = false;
			return;
		}
		await this.interruptActive("cancel_confirmed");
	}

	async abortActive(): Promise<void> {
		if (this.active) await this.interruptActive("cancel_confirmed");
	}

	private async begin(input: BeginHandoffInput, ctx: CoordinatorContext): Promise<HandoffResult> {
		const started = this.dependencies.now();
		const handoffId = this.dependencies.createHandoffId?.() ?? createHandoffId();
		const blocked = this.beginBlocked();
		if (blocked) return this.fail("begin", input.mode, handoffId, "", started, blocked);
		this.active = true;
		this.machine = initialHandoffMachine();
		this.session = undefined;
		try {
			const preflight = await this.dependencies.client.preflight();
			if (!preflight.ok) return this.fail("begin", input.mode, handoffId, "", started, preflight.code);
			if (utf8Bytes(input.request.objective) > HARD_LIMITS.maxObjectiveBytes) {
				return this.fail("begin", input.mode, handoffId, "", started, "invalid_handoff_request");
			}
			let parentRoot: string;
			let allowedWrites: string[];
			try {
				const parent = await resolveGitIdentity(ctx.cwd);
				parentRoot = parent.worktreeRoot;
				allowedWrites = await validateAllowedWrites(parentRoot, input.request.allowedWrites);
			} catch (error) {
				return this.fail("begin", input.mode, handoffId, "", started, codeOf(error));
			}
			const plan = await readCanonicalPlan(parentRoot, input.request.plan);
			if (!plan.ok) return this.fail("begin", input.mode, handoffId, "", started, plan.code);
			const prompt = buildHandoffPrompt({
				handoffId,
				mode: input.mode,
				request: { ...input.request, allowedWrites },
				canonicalPlan: plan.plan,
			});
			if (!prompt.ok) return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, prompt.code);

			const transition = this.apply(input.mode === "transfer" ? "begin_transfer" : "begin_delegate");
			if (!transition) return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, "handoff_active");
			const submitted = this.apply("prompt_submitted");
			if (!submitted) return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, "herdr_protocol_error");

			const resolved = input.target.type === "start-and-ask"
				? await this.startRecipient(input, ctx, handoffId)
				: await this.existingRecipient(input, ctx);
			if (!resolved.ok) {
				this.machine = initialHandoffMachine();
				return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, resolved.code);
			}
			try {
				allowedWrites = await validateAllowedWrites(resolved.recipientCwd, allowedWrites);
			} catch (error) {
				this.machine = initialHandoffMachine();
				return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, codeOf(error));
			}

			let baseline: WorkspaceBaseline | undefined;
			if (input.mode === "delegate-return") {
				try {
					baseline = await captureBaseline(resolved.recipientCwd, allowedWrites);
				} catch (error) {
					this.machine = initialHandoffMachine();
					return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, codeOf(error));
				}
			} else {
				try {
					await validateRecipientWorktree(ctx.cwd, resolved.recipientCwd, "transfer");
				} catch (error) {
					this.machine = initialHandoffMachine();
					return this.fail("begin", input.mode, handoffId, plan.plan.planSha256, started, codeOf(error));
				}
			}

			this.session = {
				token: createHandoffId(),
				handoffId,
				mode: input.mode,
				planSha256: plan.plan.planSha256,
				allowedWrites,
				fingerprint: resolved.fingerprint,
				handle: publicHandle(createHandleToken(), resolved.agent, resolved.recipientCwd),
				...(baseline === undefined ? {} : { baseline }),
				routeEvidence: input.target.type === "start-and-ask" ? "launch-profile" : "externally_configured_unverified",
				recipientCwd: resolved.recipientCwd,
			};
			this.session.handle.token = this.session.token;

			const timeoutMs = input.waitTimeoutMs ?? HARD_LIMITS.defaultWaitMs;
			const prompted = await this.dependencies.client.promptAgent({
				target: resolved.agent.name ?? resolved.agent.paneId,
				text: prompt.prompt.prompt,
				mode: input.mode,
				timeoutMs,
				...optionalSignal(ctx.signal),
			});
			return await this.settleAfterPrompt("begin", started, ctx, prompted);
		} finally {
			this.active = false;
		}
	}

	private async continue(input: ContinueHandoffInput, ctx: CoordinatorContext): Promise<HandoffResult> {
		const started = this.dependencies.now();
		const prepared = await this.prepareOwned("continue", input.handle, started, input.intent === "repair" ? "continue_repair" : "continue_clarification");
		if (!prepared.ok) return prepared.result;
		this.active = true;
		try {
			const submitted = this.apply("prompt_submitted");
			if (!submitted) return this.fail("continue", prepared.session.mode, prepared.session.handoffId, prepared.session.planSha256, started, "herdr_protocol_error");
			if (utf8Bytes(input.message) > HARD_LIMITS.maxContinueMessageBytes) {
				this.apply("operation_failed");
				return this.fail("continue", prepared.session.mode, prepared.session.handoffId, prepared.session.planSha256, started, "invalid_handoff_request");
			}
			if (!prepared.session.baseline) {
				this.apply("operation_failed");
				return this.fail("continue", prepared.session.mode, prepared.session.handoffId, prepared.session.planSha256, started, "baseline_unavailable");
			}
			const beforeContinuation = await inspectPostflight(prepared.session.baseline, prepared.session.recipientCwd);
			if (beforeContinuation.error) {
				this.apply("operation_failed");
				return this.result("continue", started, {
					bridgeStatus: "failed",
					workspaceStatus: beforeContinuation.status,
					workspace: {
						status: beforeContinuation.status,
						changedPaths: beforeContinuation.changedPaths,
						violations: beforeContinuation.violations,
					},
					error: beforeContinuation.error,
				});
			}
			try {
				prepared.session.baseline = await captureBaseline(prepared.session.recipientCwd, prepared.session.allowedWrites);
			} catch (error) {
				this.apply("operation_failed");
				return this.fail("continue", prepared.session.mode, prepared.session.handoffId, prepared.session.planSha256, started, codeOf(error));
			}
			const prompted = await this.dependencies.client.promptAgent({
				target: prepared.session.handle.recipientName ?? prepared.session.handle.paneId,
				text: input.message,
				mode: "delegate-return",
				timeoutMs: input.waitTimeoutMs ?? HARD_LIMITS.defaultWaitMs,
				...optionalSignal(ctx.signal),
			});
			return await this.settleAfterPrompt("continue", started, ctx, prompted);
		} finally {
			this.active = false;
		}
	}

	private async wait(input: WaitHandoffInput, ctx: CoordinatorContext): Promise<HandoffResult> {
		const started = this.dependencies.now();
		const prepared = await this.prepareOwned("wait", input.handle, started, "recovery_wait");
		if (!prepared.ok) return prepared.result;
		this.active = true;
		try {
			const waited = await this.dependencies.client.waitAgent({
				target: prepared.session.handle.recipientName ?? prepared.session.handle.paneId,
				timeoutMs: input.waitTimeoutMs,
				...optionalSignal(ctx.signal),
			});
			if (ctx.signal?.aborted) return await this.interruptActive("cancel_confirmed", started);
			if (!waited.ok) {
				if (ctx.signal?.aborted) return await this.interruptActive("cancel_confirmed", started);
				return await this.afterPromptFailure("wait", started, waited.code);
			}
			return await this.refreshAndSettle("wait", started, prepared.session);
		} finally {
			this.active = false;
		}
	}

	private async cancel(input: CancelHandoffInput, _ctx: CoordinatorContext): Promise<HandoffResult> {
		const started = this.dependencies.now();
		const prepared = await this.prepareOwned("cancel", input.handle, started, "cancel_requested");
		if (!prepared.ok) return prepared.result;
		this.active = true;
		try {
			return await this.interruptActive("cancel_confirmed", started);
		} finally {
			this.active = false;
		}
	}

	private beginBlocked(): HandoffErrorCode | undefined {
		if (this.active) return "handoff_active";
		if (this.machine.unresolvedCancellation) return "cancel_unconfirmed";
		if (this.session && ownsLiveHandle(this.machine) && this.machine.status !== "returned") return "handoff_active";
		return undefined;
	}

	private async startRecipient(input: BeginHandoffInput, ctx: CoordinatorContext, handoffId: string): Promise<
		{ ok: true; agent: AgentSnapshot; fingerprint: Fingerprint; recipientCwd: string } | { ok: false; code: HandoffErrorCode }
	> {
		if (input.target.type !== "start-and-ask") return { ok: false, code: "invalid_handoff_request" };
		const loaded = await this.dependencies.loadLaunchConfig();
		if (!loaded.ok) return { ok: false, code: loaded.code };
		const profile = getLaunchProfile(loaded.config, input.target.profileId);
		if (!profile.ok) return { ok: false, code: profile.code };
		try {
			const parent = await assertManagedParent(ctx.cwd);
			const created = await this.dependencies.client.createLinkedWorktree({
				cwd: parent.worktreeRoot,
				...(parent.head === undefined ? {} : { base: parent.head }),
				...optionalSignal(ctx.signal),
			});
			if (!created.ok) return created;
			const recipient = await validateCreatedWorktree(parent, created.value.checkoutPath, created.value.isLinkedWorktree);
			const name = agentName(handoffId);
			const started = await this.dependencies.client.startAgent({
				name,
				kind: profile.profile.kind,
				paneId: created.value.paneId,
				args: profile.profile.args,
				...(profile.profile.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: profile.profile.startupTimeoutMs }),
				...optionalSignal(ctx.signal),
			});
			if (!started.ok) return started;
			if (started.value.paneId !== created.value.paneId || started.value.workspaceId !== created.value.workspaceId || started.value.tabId !== created.value.tabId) {
				return { ok: false, code: "stale_handle" };
			}
			if (!started.value.sessionFingerprint) return { ok: false, code: "agent_unknown" };
			if (started.value.kind !== profile.profile.kind) return { ok: false, code: "agent_kind_mismatch" };
			if (started.value.status !== "idle" && started.value.status !== "done") {
				if (started.value.status === "blocked") return { ok: false, code: "agent_auth_blocked" };
				return { ok: false, code: "agent_not_ready" };
			}
			const live = await this.dependencies.client.getAgent(name);
			if (!live.ok) return live;
			if (
				live.value.paneId !== started.value.paneId
				|| live.value.workspaceId !== started.value.workspaceId
				|| live.value.tabId !== started.value.tabId
				|| live.value.kind !== started.value.kind
				|| live.value.sessionFingerprint !== started.value.sessionFingerprint
			) return { ok: false, code: "stale_handle" };
			if (!live.value.cwd || !live.value.sessionFingerprint) return { ok: false, code: "agent_unknown" };
			const liveIdentity = await resolveGitIdentity(live.value.cwd);
			if (liveIdentity.worktreeRoot !== recipient.worktreeRoot || liveIdentity.commonDir !== recipient.commonDir) {
				return { ok: false, code: "workspace_mismatch" };
			}
			if (live.value.status !== "idle" && live.value.status !== "done") {
				if (live.value.status === "blocked") return { ok: false, code: "agent_auth_blocked" };
				return { ok: false, code: "agent_not_ready" };
			}
			return {
				ok: true,
				agent: live.value,
				fingerprint: fingerprintOf(live.value, recipient.worktreeRoot, recipient.commonDir),
				recipientCwd: created.value.checkoutPath,
			};
		} catch (error) {
			return { ok: false, code: codeOf(error) };
		}
	}

	private async existingRecipient(input: BeginHandoffInput, ctx: CoordinatorContext): Promise<
		{ ok: true; agent: AgentSnapshot; fingerprint: Fingerprint; recipientCwd: string } | { ok: false; code: HandoffErrorCode }
	> {
		if (input.target.type !== "message-existing") return { ok: false, code: "invalid_handoff_request" };
		const agent = await this.dependencies.client.getAgent(input.target.target);
		if (!agent.ok) return agent;
		if (agent.value.paneId === this.dependencies.client.callerPaneId()) return { ok: false, code: "self_target_rejected" };
		if (agent.value.kind !== input.target.kind) return { ok: false, code: "agent_kind_mismatch" };
		if (agent.value.status === "working") return { ok: false, code: "agent_busy" };
		if (agent.value.status === "blocked") return { ok: false, code: "agent_blocked" };
		if (agent.value.status === "unknown") return { ok: false, code: "agent_unknown" };
		if (agent.value.status !== "idle" && agent.value.status !== "done") return { ok: false, code: "agent_not_ready" };
		if (!agent.value.sessionFingerprint) return { ok: false, code: "agent_unknown" };
		if (!agent.value.cwd) return { ok: false, code: "workspace_mismatch" };
		try {
			const validated = await validateRecipientWorktree(ctx.cwd, agent.value.cwd, input.mode);
			return {
				ok: true,
				agent: agent.value,
				fingerprint: fingerprintOf(agent.value, validated.recipient.worktreeRoot, validated.recipient.commonDir),
				recipientCwd: agent.value.cwd,
			};
		} catch (error) {
			return { ok: false, code: codeOf(error) };
		}
	}

	private async prepareOwned(
		action: HandoffAction,
		token: string,
		started: number,
		event: Parameters<typeof transitionHandoff>[1],
	): Promise<{ ok: true; session: Session } | { ok: false; result: HandoffResult }> {
		if (this.active) return { ok: false, result: this.fail(action, this.session?.mode ?? "delegate-return", this.session?.handoffId ?? "", this.session?.planSha256 ?? "", started, "handoff_active") };
		if (!this.session || this.session.token !== token) {
			return { ok: false, result: this.fail(action, this.session?.mode ?? "delegate-return", this.session?.handoffId ?? "", this.session?.planSha256 ?? "", started, "stale_handle") };
		}
		const live = await this.revalidate(this.session);
		if (!live.ok) {
			this.apply("identity_mismatch");
			return { ok: false, result: this.fail(action, this.session.mode, this.session.handoffId, this.session.planSha256, started, live.code) };
		}
		if (!this.apply(event)) {
			const code = this.machine.status === "transferred" ? "ownership_transferred" : "continuation_budget_exhausted";
			return { ok: false, result: this.fail(action, this.session.mode, this.session.handoffId, this.session.planSha256, started, this.machine.status === "transferred" ? "ownership_transferred" : code) };
		}
		return { ok: true, session: this.session };
	}

	private async settleAfterPrompt(
		action: HandoffAction,
		started: number,
		ctx: CoordinatorContext,
		prompted: { ok: true; value: AgentSnapshot } | { ok: false; code: HandoffErrorCode },
	): Promise<HandoffResult> {
		if (ctx.signal?.aborted) return await this.interruptActive("cancel_confirmed", started);
		if (!prompted.ok) {
			if (ctx.signal?.aborted) return await this.interruptActive("cancel_confirmed", started);
			return await this.afterPromptFailure(action, started, prompted.code);
		}
		const session = this.session;
		if (!session) return this.fail(action, "delegate-return", "", "", started, "herdr_protocol_error");
		return await this.refreshAndSettle(action, started, session);
	}

	private async refreshAndSettle(action: HandoffAction, started: number, session: Session): Promise<HandoffResult> {
		const agent = await this.dependencies.client.getAgent(session.handle.recipientName ?? session.handle.paneId);
		if (!agent.ok) return await this.afterPromptFailure(action, started, agent.code);
		const live = await this.matchesFingerprint(session, agent.value);
		if (!live.ok) {
			this.apply("identity_mismatch");
			return this.fail(action, session.mode, session.handoffId, session.planSha256, started, live.code);
		}
		return await this.afterPrompt(action, started, agent.value);
	}

	private async revalidate(session: Session): Promise<{ ok: true } | { ok: false; code: HandoffErrorCode }> {
		const agent = await this.dependencies.client.getAgent(session.handle.recipientName ?? session.handle.paneId);
		if (!agent.ok) return { ok: false, code: "stale_handle" };
		return await this.matchesFingerprint(session, agent.value);
	}

	private async matchesFingerprint(session: Session, agent: AgentSnapshot): Promise<{ ok: true } | { ok: false; code: HandoffErrorCode }> {
		if (!agent.cwd || !agent.sessionFingerprint) return { ok: false, code: "stale_handle" };
		try {
			const identity = await resolveGitIdentity(agent.cwd);
			if (
				agent.paneId !== session.fingerprint.paneId
				|| agent.workspaceId !== session.fingerprint.workspaceId
				|| agent.tabId !== session.fingerprint.tabId
				|| agent.kind !== session.fingerprint.kind
				|| agent.sessionFingerprint !== session.fingerprint.sessionFingerprint
				|| identity.worktreeRoot !== session.fingerprint.worktreeRoot
				|| identity.commonDir !== session.fingerprint.commonDir
			) {
				return { ok: false, code: "stale_handle" };
			}
			return { ok: true };
		} catch {
			return { ok: false, code: "stale_handle" };
		}
	}

	private async afterPrompt(action: HandoffAction, started: number, agent: AgentSnapshot): Promise<HandoffResult> {
		const session = this.session;
		if (!session) return this.fail(action, "delegate-return", "", "", started, "herdr_protocol_error");
		if (session.mode === "transfer") {
			if (agent.status !== "working") {
				this.apply("operation_failed");
				return this.fail(action, session.mode, session.handoffId, session.planSha256, started, "herdr_protocol_error");
			}
			this.apply("observed_working");
			return this.result(action, started, {
				bridgeStatus: "transferred",
				workspaceStatus: "not_inspected",
				lifecycleState: agent.status,
				...optionalSequence(agent.stateChangeSeq),
			});
		}
		if (agent.status === "working") {
			this.apply("observed_working");
			return this.fail(action, session.mode, session.handoffId, session.planSha256, started, "herdr_protocol_error");
		}
		if (agent.status === "blocked") {
			this.apply("settled_blocked");
			const collected = await this.collectReturn(action, started, agent);
			collected.bridgeStatus = "blocked";
			collected.error = { code: "handoff_blocked", message: handoffErrorMessage("handoff_blocked") };
			collected.lifecycleState = "blocked";
			return collected;
		}
		if (agent.status === "unknown") {
			this.apply("operation_failed");
			return this.fail(action, session.mode, session.handoffId, session.planSha256, started, "agent_unknown");
		}
		this.apply(agent.status === "done" ? "settled_done" : "settled_idle");
		return await this.collectReturn(action, started, agent);
	}

	private async afterPromptFailure(action: HandoffAction, started: number, code: HandoffErrorCode): Promise<HandoffResult> {
		const session = this.session;
		if (code === "handoff_timed_out") this.apply("timed_out");
		else this.apply("operation_failed");
		return this.fail(action, session?.mode ?? "delegate-return", session?.handoffId ?? "", session?.planSha256 ?? "", started, code);
	}

	private async collectReturn(action: HandoffAction, started: number, agent: AgentSnapshot): Promise<HandoffResult> {
		const session = this.session;
		if (!session?.baseline) return this.fail(action, session?.mode ?? "delegate-return", session?.handoffId ?? "", session?.planSha256 ?? "", started, "baseline_unavailable");
		const read = await this.dependencies.client.readRecentUnwrapped(session.handle.recipientName ?? session.handle.paneId);
		if (!read.ok) return this.fail(action, session.mode, session.handoffId, session.planSha256, started, read.code);
		const parsed = parseRecipientReturn(read.value.text, session.handoffId);
		const postflight = await inspectPostflight(session.baseline, session.recipientCwd);
		if (!parsed.ok) {
			return this.result(action, started, {
				bridgeStatus: "failed",
				workspaceStatus: postflight.status,
				lifecycleState: agent.status,
				...optionalSequence(agent.stateChangeSeq),
				workspace: { status: postflight.status, changedPaths: postflight.changedPaths, violations: postflight.violations },
				error: { code: parsed.code, message: handoffErrorMessage(parsed.code) },
			});
		}
		if (postflight.error) {
			return this.result(action, started, {
				bridgeStatus: "returned",
				agentOutcome: parsed.envelope.outcome,
				workspaceStatus: postflight.status,
				lifecycleState: agent.status,
				...optionalSequence(agent.stateChangeSeq),
				recipientReturn: parsed.envelope,
				workspace: { status: postflight.status, changedPaths: postflight.changedPaths, violations: postflight.violations },
				error: postflight.error,
			});
		}
		const claimed = new Set(parsed.envelope.changed_paths);
		const observed = new Set(postflight.changedPaths);
		const mismatch = parsed.envelope.changed_paths.some((path) => !observed.has(path))
			|| postflight.changedPaths.some((path) => !claimed.has(path) && session.allowedWrites.includes(path));
		if (mismatch) {
			return this.result(action, started, {
				bridgeStatus: "returned",
				agentOutcome: parsed.envelope.outcome,
				workspaceStatus: postflight.status,
				lifecycleState: agent.status,
				...optionalSequence(agent.stateChangeSeq),
				recipientReturn: parsed.envelope,
				workspace: { status: postflight.status, changedPaths: postflight.changedPaths, violations: postflight.violations },
				error: { code: "claim_mismatch", message: handoffErrorMessage("claim_mismatch") },
			});
		}
		return this.result(action, started, {
			bridgeStatus: "returned",
			agentOutcome: parsed.envelope.outcome,
			workspaceStatus: postflight.status,
			lifecycleState: agent.status,
			...optionalSequence(agent.stateChangeSeq),
			recipientReturn: parsed.envelope,
			workspace: { status: postflight.status, changedPaths: postflight.changedPaths, violations: postflight.violations },
		});
	}

	private async interruptActive(successEvent: "cancel_confirmed" | "cancel_unconfirmed", started = this.dependencies.now()): Promise<HandoffResult> {
		const session = this.session;
		if (!session) return this.fail("cancel", "delegate-return", "", "", started, "stale_handle");
		const live = await this.revalidate(session);
		if (!live.ok) {
			this.apply("identity_mismatch");
			return this.fail("cancel", session.mode, session.handoffId, session.planSha256, started, "stale_handle");
		}
		const interrupted = await this.dependencies.client.sendInterrupt(session.handle.recipientName ?? session.handle.paneId);
		if (!interrupted.ok) {
			this.apply("cancel_unconfirmed");
			return this.fail("cancel", session.mode, session.handoffId, session.planSha256, started, "cancel_unconfirmed");
		}
		const waited = await this.dependencies.client.waitAgent({
			target: session.handle.recipientName ?? session.handle.paneId,
			timeoutMs: HARD_LIMITS.cancelWaitMs,
		});
		if (!waited.ok) {
			this.apply("cancel_unconfirmed");
			return this.fail("cancel", session.mode, session.handoffId, session.planSha256, started, "cancel_unconfirmed");
		}
		this.apply(successEvent);
		let workspaceStatus: WorkspaceStatus = "not_inspected";
		let changedPaths: string[] = [];
		let violations: string[] = [];
		if (session.baseline) {
			const postflight = await inspectPostflight(session.baseline, session.recipientCwd);
			workspaceStatus = postflight.status;
			changedPaths = postflight.changedPaths;
			violations = postflight.violations;
		}
		if (successEvent === "cancel_confirmed") {
			const result = this.result("cancel", started, {
				bridgeStatus: "cancelled",
				workspaceStatus,
				workspace: { status: workspaceStatus, changedPaths, violations },
			});
			this.session = undefined;
			this.machine = initialHandoffMachine();
			return result;
		}
		return this.fail("cancel", session.mode, session.handoffId, session.planSha256, started, "cancel_unconfirmed");
	}

	private apply(event: Parameters<typeof transitionHandoff>[1]): boolean {
		const result = transitionHandoff(this.machine, event);
		if (!result.ok) return false;
		this.machine = result.machine;
		return true;
	}

	private fail(
		action: HandoffAction,
		mode: HandoffMode,
		handoffId: string,
		planSha256: string,
		started: number,
		code: HandoffErrorCode,
	): HandoffResult {
		const bridgeStatus: BridgeStatus = code === "handoff_timed_out" ? "timed_out" : code === "handoff_blocked" ? "blocked" : "failed";
		return this.result(action, started, {
			handoffId,
			mode,
			planSha256,
			bridgeStatus,
			workspaceStatus: code === "handoff_timed_out" || code === "handoff_blocked" ? "not_inspected" : "unavailable",
			error: { code, message: handoffErrorMessage(code) },
		});
	}

	private result(action: HandoffAction, started: number, overrides: Partial<HandoffResult> & { bridgeStatus: BridgeStatus; workspaceStatus: WorkspaceStatus }): HandoffResult {
		const session = this.session;
		const result: HandoffResult = {
			schemaVersion: HANDOFF_RESULT_SCHEMA_VERSION,
			handoffId: overrides.handoffId ?? session?.handoffId ?? "",
			mode: overrides.mode ?? session?.mode ?? "delegate-return",
			action,
			planSha256: overrides.planSha256 ?? session?.planSha256 ?? "",
			bridgeStatus: overrides.bridgeStatus,
			workspaceStatus: overrides.workspaceStatus,
			continuation: {
				clarifications: this.machine.clarificationUsed ? 1 : 0,
				repairs: this.machine.repairUsed ? 1 : 0,
				recoveryWaits: this.machine.recoveryWaitUsed ? 1 : 0,
			},
			durationMs: Math.max(0, this.dependencies.now() - started),
			...(session === undefined ? {} : {
				handle: session.handle,
				recipientKind: session.handle.recipientKind,
				...(session.handle.recipientName === undefined ? {} : { recipientName: session.handle.recipientName }),
				paneId: session.handle.paneId,
				workspaceId: session.handle.workspaceId,
				tabId: session.handle.tabId,
				checkoutKind: session.handle.checkoutKind,
				checkoutPath: session.handle.checkoutPath,
				routeEvidence: session.routeEvidence,
			}),
		};
		if (overrides.agentOutcome !== undefined) result.agentOutcome = overrides.agentOutcome;
		if (overrides.lifecycleState !== undefined) result.lifecycleState = overrides.lifecycleState;
		if (overrides.lifecycleSequence !== undefined) result.lifecycleSequence = overrides.lifecycleSequence;
		if (overrides.recipientReturn !== undefined) result.recipientReturn = overrides.recipientReturn;
		if (overrides.workspace !== undefined) result.workspace = overrides.workspace;
		if (overrides.error !== undefined) result.error = overrides.error;
		if (overrides.handle !== undefined) result.handle = overrides.handle;
		return result;
	}
}

function optionalSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
	return signal === undefined ? {} : { signal };
}

function optionalSequence(value: number | undefined): { lifecycleSequence?: number } {
	return value === undefined ? {} : { lifecycleSequence: value };
}

function createHandleToken(): string {
	return createHandoffId();
}

function publicHandle(token: string, agent: AgentSnapshot, checkoutPath: string): PublicHandoffHandle {
	const handle: PublicHandoffHandle = {
		token,
		paneId: agent.paneId,
		workspaceId: agent.workspaceId,
		tabId: agent.tabId,
		recipientKind: agent.kind ?? "unknown",
		checkoutKind: "linked-worktree",
		checkoutPath,
	};
	if (agent.name !== undefined) handle.recipientName = agent.name;
	return handle;
}

function fingerprintOf(agent: AgentSnapshot, worktreeRoot: string, commonDir: string): Fingerprint {
	const fingerprint: Fingerprint = {
		paneId: agent.paneId,
		workspaceId: agent.workspaceId,
		tabId: agent.tabId,
		worktreeRoot,
		commonDir,
	};
	if (agent.kind !== undefined) fingerprint.kind = agent.kind;
	if (agent.sessionFingerprint !== undefined) fingerprint.sessionFingerprint = agent.sessionFingerprint;
	return fingerprint;
}

function codeOf(error: unknown): HandoffErrorCode {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code as HandoffErrorCode;
	}
	return "herdr_protocol_error";
}
