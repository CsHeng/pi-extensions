import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { durationMsFromSeconds, timestampAfter } from "../shared/duration-timer.ts";
import { emptyProducerFacts, EXECUTION_FACTS_EVENT, NOTICE_ACK, EXECUTION_FACTS_REQUEST, noticeExecutionId, type NoticeDisposition, type ExecutionFact, type ProducerFacts, type NoticeAck, type ProducerFactsRequest } from "../shared/execution-facts.ts";
import { createMainLoopYield, yieldNote, type MainLoopYield, type YieldReason } from "../shared/main-loop-yield.ts";
import { formatPanelDuration } from "../shared/panel-rows.ts";

import { createBashDelivery } from "./delivery.ts";
import { validateBashCall } from "./validate.ts";
import { createBashExecutionOwner, inBashScope, type BashExecutionEvent, type BashExecutionOwner, type BashExecutionView, type BashScope, type BashStatus } from "./execution.ts";
import { registerJobsView, type JobsClaim } from "./jobs-view.ts";
import {
	DEFAULT_DEADLINE_SECONDS,
	DEFAULT_FOREGROUND_SECONDS,
	DEFAULT_WAIT_SECONDS,
	BASH_EXECUTION_EVENT,
	BASH_OWNER,
	bashClaim,
} from "./policy.ts";

export { BASH_EXECUTION_EVENT, BASH_OWNER, bashClaim };
export type { BashExecutionEvent, BashExecutionView, BashStatus };

const parameters = Type.Object({
	command: Type.Optional(Type.String({ description: "Shell command. Required when starting an execution." })),
	timeout: Type.Optional(Type.Number({ description: "Hard process lifetime in seconds for a new run; the process is killed at this time. Omitted means no kill time, and the checkpoint still applies." })),
	action: Type.Optional(Type.Union([
		Type.Literal("run"),
		Type.Literal("inspect"),
		Type.Literal("wait"),
		Type.Literal("renew"),
		Type.Literal("cancel"),
	], { description: "run starts a command. inspect returns a snapshot for a specific diagnostic question. wait holds this call for a terminal result within waitSeconds. renew moves the checkpoint of a running execution; cancel stops the execution. For completion alone after a running result, end the turn; the result notice resumes you." })),
	executionId: Type.Optional(Type.String({ description: "Copy the execution_id returned by run and pair it with an explicit control action. This identifies the job, not an OS process." })),
	background: Type.Optional(Type.Boolean({ description: "Return as soon as the execution is running. The process keeps going." })),
	deadlineSeconds: Type.Optional(Type.Number({ description: "Checkpoint in seconds for a new run (omitted: 600), or the next checkpoint for renew. At the checkpoint the process keeps running and the session sends one notice so you can renew, cancel or leave it running." })),
	waitSeconds: Type.Optional(Type.Number({ description: "How long wait may hold this call; omitted uses 180 seconds and explicit finite values are honored. The call also returns at the execution's checkpoint, or when a user steering message or another execution's notice is waiting. Returning never cancels or renews the execution." })),
	foregroundSeconds: Type.Optional(Type.Number({ description: "How long a non-background run may hold this call before returning status=running while the execution continues. Omitted uses 2 seconds; explicit finite values are honored. The call returns earlier when a user steering message or another execution's notice is waiting." })),
});

const outputSchema = Type.Object({
	output: Type.String(),
	truncated: Type.Boolean(),
	execution_id: Type.String(),
	status: Type.String(),
	exit_code: Type.Union([Type.Number(), Type.Null()]),
	wall_time_seconds: Type.Number(),
	deadline_at: Type.Union([Type.String(), Type.Null()]),
	timeout_at: Type.Union([Type.String(), Type.Null()]),
	overdue: Type.Boolean(),
	notice: Type.String(),
});

const RUNNING_GUIDANCE = "This execution is still active under the same execution_id. Continue independent work, or finish this model turn with the task pending so the session can deliver its result notice. Use inspect for a specific diagnostic question; for completion alone, rely on the result notice rather than repeated snapshots. Assess the terminal status and exit_code before reporting the outcome.";

export function bindAsyncBash(pi: ExtensionAPI, owner: BashExecutionOwner = createDefaultOwner(pi)): void {
	const delivery = createBashDelivery();
	const openStarts = new Set<string>();
	const openWaits = new Set<string>();
	let decided = false;
	let jobsClaim: JobsClaim = "inactive";
	let context: ExtensionContext | undefined;
	const jobs = registerJobsView(pi, owner, () => jobsClaim);
	const mainLoop = createMainLoopYield(pi);
	const dispositions = new Map<string, "pending" | "returning" | "observed">();
	/** Reached checkpoint per running execution; one notice each, retired by renew, terminal, observation or ack. */
	const checkpoints = new Map<string, { id: string; disposition: NoticeDisposition }>();
	const observeCheckpoint = (executionId: string, checkpointId?: string): void => {
		const current = checkpoints.get(executionId);
		if (current && (checkpointId === undefined || current.id === checkpointId)) current.disposition = "observed";
	};
	const bashFacts = (): ProducerFacts => {
		if (!context) return emptyProducerFacts("async-bash", "unknown");
		if (!decided || jobsClaim === "inactive" || jobsClaim === "other-owner") {
			return emptyProducerFacts("async-bash", decided ? "inactive" : "unknown", context.sessionManager.getSessionId(), context.sessionManager.getLeafId());
		}
		const scope = scopeOf(context);
		const listed = owner.list(scope);
		const executions = listed.map((view) => executionFact(view, dispositionFor(view.executionId, delivery, dispositions), checkpoints.get(view.executionId)));
		const listedIds = new Set(listed.map((view) => view.executionId));
		for (const fact of delivery.pending(scope)) {
			if (listedIds.has(fact.executionId) || dispositions.get(fact.executionId) === "observed") continue;
			executions.push({
				id: fact.executionId,
				...(fact.toolCallId ? { toolCallId: fact.toolCallId } : {}),
				phase: "terminal",
				status: fact.status,
				exitCode: fact.exitCode,
				summary: `Bash job ${fact.executionId} finished with status ${fact.status}, exit_code ${fact.exitCode === null ? "unknown" : String(fact.exitCode)}. This is the same execution, not a second tool result.\n${fact.outputTail}`.trim(),
				disposition: "pending",
			});
		}
		return {
			version: 1,
			producer: "async-bash",
			availability: "ready",
			sessionId: scope.sessionId,
			branchAnchor: scope.branchAnchor,
			generation: String(executions.length),
			executions,
		};
	};
	const publish = (): void => { try { pi.events.emit(EXECUTION_FACTS_EVENT, bashFacts()); } catch { /* Fact publication cannot change the process. */ } };
	pi.events.on(EXECUTION_FACTS_REQUEST, (raw) => {
		const accept = (raw as Partial<ProducerFactsRequest> | undefined)?.accept;
		if (typeof accept === "function") accept(bashFacts());
	});
	pi.events.on(NOTICE_ACK, (raw) => {
		const ack = raw as Partial<NoticeAck> | undefined;
		if (ack?.version !== 1 || ack.producer !== "async-bash" || !Array.isArray(ack.ids)) return;
		const terminalIds: string[] = [];
		for (const id of ack.ids) {
			const notice = noticeExecutionId(id);
			if (notice.checkpointId !== undefined) observeCheckpoint(notice.executionId, notice.checkpointId);
			else terminalIds.push(id);
		}
		delivery.acknowledge(terminalIds);
		for (const id of terminalIds) dispositions.set(id, "observed");
		publish();
	});
	pi.events.on(BASH_EXECUTION_EVENT, (raw) => {
		const event = raw as BashExecutionEvent;
		if (event.phase === "unavailable") { publish(); return; }
		if (!event.executionId || !context) return;
		const scope = scopeOf(context);
		if (!inBashScope(event, scope)) return;
		const terminal = event.phase === "exited" || event.phase === "cancelled" || event.phase === "timeout" || event.phase === "interrupted";
		const open = (event.toolCallId !== null && openStarts.has(event.toolCallId)) || openWaits.has(event.executionId);
		if (event.phase === "checkpoint") {
			// An open foreground window or wait returns this checkpoint itself; otherwise notify once.
			checkpoints.set(event.executionId, { id: `cp${event.checkpoint}`, disposition: open ? "returning" : "pending" });
		}
		if (event.phase === "renewed") observeCheckpoint(event.executionId);
		if (terminal) {
			// The terminal notice supersedes an undelivered "still running" checkpoint.
			checkpoints.delete(event.executionId);
			if (open) delivery.noteReturning(event);
			else delivery.noteReady(event);
			const current = dispositions.get(event.executionId);
			if (current !== "observed") dispositions.set(event.executionId, open || current === "returning" ? "returning" : "pending");
		}
		publish();
	});
	const decide = (ctx: ExtensionContext): void => {
		if (decided) return;
		let source: string | undefined;
		try {
			source = pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source;
		} catch {
			return;
		}
		const claim = bashClaim(ctx.mode, source);
		if (claim === "leave-native") {
			decided = true;
			jobsClaim = "inactive";
			return;
		}
		if (claim === "other-owner") {
			decided = true;
			jobsClaim = "other-owner";
			try { pi.events.emit(BASH_EXECUTION_EVENT, unavailableEvent(ctx)); } catch { /* Unavailable notice is optional. */ }
			return;
		}
		decided = true;
		jobsClaim = "ready";
		pi.registerTool(createAsyncBashTool(pi, owner, openStarts, openWaits, mainLoop));
	};
	const switchScope = (ctx: ExtensionContext): void => {
		context = ctx;
		delivery.fence();
		decide(ctx);
		jobs.bind(ctx);
		publish();
		void owner.interruptOthers(scopeOf(ctx)).then(() => publish());
	};
	pi.on("session_start", (_event, ctx) => { switchScope(ctx); });
	pi.on("session_tree", (_event, ctx) => { switchScope(ctx); });
	pi.on("before_agent_start", (_event, ctx) => { context = ctx; decide(ctx); jobs.ensure(ctx); });
	pi.on("input", (event) => { if (event.source === "interactive" || event.source === "rpc") delivery.fence(); });
	pi.on("agent_end", (event) => {
		if (event.messages.some((message) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))) delivery.fence();
	});
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || (ctx.mode !== "print" && ctx.mode !== "json")) return;
		if (pi.getAllTools().find(tool => tool.name === "bash")?.sourceInfo.source !== "builtin") return;
		const input = event.input as Record<string, unknown>;
		if (["action", "executionId", "background", "deadlineSeconds", "waitSeconds", "foregroundSeconds"].some(key => key in input)) {
			return { block: true, reason: "Async Bash is unavailable in this mode. Use native foreground bash with timeout; no command was started." };
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "bash") return;
		const details = event.result?.details as { executionId?: string; status?: string; overdue?: boolean; checkpoint?: number } | undefined;
		if (!details?.executionId || details.status === "rejected") return;
		if (details.status === "running") {
			// A returned overdue view shows the checkpoint to the model; it is not notified again.
			if (details.overdue && details.checkpoint) { observeCheckpoint(details.executionId, `cp${details.checkpoint}`); publish(); }
			return;
		}
		delivery.notePull(details.executionId);
		dispositions.set(details.executionId, "observed");
		publish();
	});
	pi.on("session_shutdown", async () => { jobs.unbind(); await owner.shutdown(); });
}

export default function asyncBashExtension(pi: ExtensionAPI): void {
	bindAsyncBash(pi);
}

function createDefaultOwner(pi: ExtensionAPI): BashExecutionOwner {
	return createBashExecutionOwner({
		// Pi owns shell discovery, spawn, streaming, teardown and shutdown tracking.
		// Reading settings per start keeps a changed shellPath effective for the next command.
		operations: () => {
			const shellPath = pi.getSettings().shellPath;
			return createLocalBashOperations(typeof shellPath === "string" ? { shellPath } : undefined);
		},
		onEvent: (event) => { pi.events.emit(BASH_EXECUTION_EVENT, event); },
	});
}

function createAsyncBashTool(
	pi: ExtensionAPI,
	owner: BashExecutionOwner,
	openStarts: Set<string>,
	openWaits: Set<string>,
	mainLoop: MainLoopYield,
) {
	return {
		name: "bash",
		label: "bash",
		description: "Execute shell commands and manage background jobs. Start with {\"command\":\"bun test\"}. In TUI/RPC, work still running after the foreground window returns status=running with an execution_id and keeps running. Keep that id, advance independent work, or finish the model turn with the task pending; the session delivers completion separately. Foreground windows and wait also return early, leaving the execution running, when the user sends a steering message or another execution's notice is ready. deadlineSeconds sets a checkpoint, not a kill: at the checkpoint the process keeps running and the session sends one checkpoint notice; renew moves the checkpoint, cancel stops the process, and leaving it running sends no further checkpoint notice. timeout sets a hard lifetime that kills the process; omit it unless the command must stop at a fixed limit. For a specific diagnostic question, inspect with {\"action\":\"inspect\",\"executionId\":\"exec_example\"}; inspect is an immediate snapshot, not a completion-wait loop. To await a terminal result within one call, choose the wait action with executionId and optional waitSeconds. Control actions are structured fields; command contains shell code. Judge the outcome from terminal status and exit_code.",
		promptSnippet: "Execute bash. After a running result, do independent work or finish the turn with the execution pending; completion arrives as a result notice.",
		promptGuidelines: [
			"After bash returns running, keep its execution_id and advance independent work. If only execution-dependent work remains, finish the model turn with tasks unfinished; the result notice can resume work.",
			"Use inspect for a specific diagnostic question requiring fresh output. For completion alone, rely on the result notice rather than repeated snapshots or another shell command.",
			"Use wait when holding one call for a terminal result is useful. Its default observation budget is 180 seconds; it also returns at the execution's checkpoint, for a user steering message, or when another execution's notice is ready. Returning leaves the execution running.",
			"A checkpoint notice means the execution passed deadlineSeconds and is still running: renew it with deadlineSeconds to keep it, cancel it, or leave it running without further checkpoint notices. Only timeout kills at a fixed time. Assess terminal status and exit_code before reporting success; the original running call has already returned.",
		],
		parameters,
		outputSchema,
		constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
		async execute(toolCallId: string, params: {
			command?: string;
			timeout?: number;
			action?: "run" | "inspect" | "wait" | "renew" | "cancel";
			executionId?: string;
			background?: boolean;
			deadlineSeconds?: number;
			waitSeconds?: number;
			foregroundSeconds?: number;
		}, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionToolContext) {
			const scope = scopeOf(ctx);
			try {
				const validated = validateBashCall(params);
				if (!validated.ok) return failed(validated.message);
				if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
					return failed("Async Bash is unavailable in this mode. The native foreground shell was not started.");
				}
				const action = params.action ?? "run";
				if (action === "inspect" || action === "wait" || action === "renew" || action === "cancel") {
					const executionId = params.executionId;
					if (!executionId) return failed(`action ${action} requires executionId`);
					if (action === "inspect") {
						const view = owner.inspect(executionId, scope);
						return view ? resultOf(view, false) : failed(`Unknown job: ${executionId}`);
					}
					if (action === "wait") {
						const waitMs = durationMsFromSeconds(params.waitSeconds, DEFAULT_WAIT_SECONDS);
						openWaits.add(executionId);
						// Notices about this execution come back on this result; others release the main loop.
						const window = mainLoop.open({ ignore: (ref) => ref.producer === "async-bash" && noticeExecutionId(ref.id).executionId === executionId });
						try {
							const view = await owner.wait(executionId, scope, {
								...(signal ? { signal } : {}),
								yieldSignal: window.signal,
								waitMs,
							});
							return resultOf(view, false, view.status === "running" ? window.reason : undefined);
						} finally { window.close(); openWaits.delete(executionId); }
					}
					if (action === "renew") {
						if (params.deadlineSeconds === undefined) return failed("renew requires deadlineSeconds for the same execution");
						const deadlineMs = durationMsFromSeconds(params.deadlineSeconds, params.deadlineSeconds);
						timestampAfter(Date.now(), deadlineMs);
						return resultOf(owner.renew(executionId, scope, deadlineMs), false);
					}
					return resultOf(await owner.cancel(executionId, scope), false);
				}
				if (!params.command) return failed("command is required to start a job");
				const deadlineMs = durationMsFromSeconds(params.deadlineSeconds, DEFAULT_DEADLINE_SECONDS);
				timestampAfter(Date.now(), deadlineMs);
				const timeoutMs = params.timeout === undefined ? undefined : durationMsFromSeconds(params.timeout, params.timeout);
				if (timeoutMs !== undefined) timestampAfter(Date.now(), timeoutMs);
				const foregroundWindowMs = params.background ? 0 : durationMsFromSeconds(params.foregroundSeconds, DEFAULT_FOREGROUND_SECONDS);
				// Apply the configured prefix exactly once, at the same point as Pi's native bash tool.
				const configuredPrefix = pi.getSettings().shellCommandPrefix;
				const commandPrefix = typeof configuredPrefix === "string" && configuredPrefix ? configuredPrefix : undefined;
				openStarts.add(toolCallId);
				const window = foregroundWindowMs > 0 ? mainLoop.open({ ignore: (ref) => ref.toolCallId === toolCallId }) : undefined;
				try {
					const view = await owner.start({
						command: params.command,
						...(commandPrefix ? { commandPrefix } : {}),
						cwd: ctx.cwd,
						env: commandEnv(ctx),
						sessionId: scope.sessionId,
						branchAnchor: scope.branchAnchor,
						toolCallId,
						deadlineMs,
						...(timeoutMs !== undefined ? { timeoutMs } : {}),
						foregroundWindowMs,
						...(signal ? { signal } : {}),
						...(window ? { yieldSignal: window.signal } : {}),
					});
					return resultOf(view, false, view.status === "running" ? window?.reason : undefined);
				} finally { window?.close(); openStarts.delete(toolCallId); }
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

function scopeOf(ctx: ExtensionContext): BashScope {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		branchAnchor: ctx.sessionManager.getLeafId(),
		branchIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
	};
}

function resultOf(view: BashExecutionView, forceError: boolean, yielded?: YieldReason) {
	const failedStatus = view.status === "cancelled" || view.status === "timeout" || view.status === "interrupted" || (view.status === "exited" && view.exitCode !== 0);
	return {
		content: [{ type: "text" as const, text: renderView(view, yielded) }],
		details: {
			executionId: view.executionId,
			status: view.status,
			exitCode: view.exitCode,
			truncated: view.truncated,
			deadlineAt: new Date(view.deadlineAt).toISOString(),
			...(view.timeoutAt !== null ? { timeoutAt: new Date(view.timeoutAt).toISOString() } : {}),
			...(view.status === "running" && view.overdue ? { overdue: true, checkpoint: view.checkpoint } : {}),
		},
		structuredContent: structured(view),
		isError: forceError || failedStatus,
	};
}

function failed(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { status: "rejected" },
		isError: true,
	};
}

function renderView(view: BashExecutionView, yielded?: YieldReason): string {
	const lines = [
		`status: ${view.status}`,
		`execution_id: ${view.executionId}`,
		`owner: ${view.owner}`,
		`checkpoint: ${new Date(view.deadlineAt).toISOString()}${view.status === "running" && view.overdue ? " (passed)" : ""}`,
		...(view.timeoutAt !== null ? [`timeout: ${new Date(view.timeoutAt).toISOString()}`] : []),
		`exit_code: ${view.exitCode === null ? "unknown" : String(view.exitCode)}`,
		view.truncated ? "output: truncated" : "output: complete",
		view.output || "(no output)",
	];
	if (view.status === "running") {
		const note = yieldNote(yielded);
		if (note) lines.push(note);
		if (view.overdue) lines.push(CHECKPOINT_GUIDANCE(view.executionId));
		lines.push(RUNNING_GUIDANCE);
	} else if (view.status !== "exited") lines.push("Execution ended without a successful exit.");
	return lines.join("\n");
}

const CHECKPOINT_GUIDANCE = (executionId: string) => `This execution passed its checkpoint and is still running; it is not killed. To keep it, renew with {"action":"renew","executionId":"${executionId}","deadlineSeconds":<seconds>}. To stop it, cancel it. Leaving it running sends no further checkpoint notice; its completion still arrives as a result notice.`;

const CHECKPOINT_TAIL_CHARS = 2_000;

/** One bounded attention notice: elapsed, output age, the choices, and recent output. */
function checkpointSummary(view: BashExecutionView, now = Date.now()): string {
	const elapsed = formatPanelDuration(Math.max(0, now - view.startedAt));
	const quiet = view.lastOutputAt === null ? "no output yet" : `last output ${formatPanelDuration(Math.max(0, now - view.lastOutputAt))} ago`;
	const tail = view.output.length > CHECKPOINT_TAIL_CHARS ? `…${view.output.slice(-CHECKPOINT_TAIL_CHARS)}` : view.output;
	return [`Bash job ${view.executionId} reached its checkpoint after ${elapsed} (${quiet}).`, CHECKPOINT_GUIDANCE(view.executionId), tail ? `Recent output:\n${tail}` : ""].filter(Boolean).join("\n");
}

function structured(view: BashExecutionView) {
	return {
		output: view.output,
		truncated: view.truncated,
		execution_id: view.executionId,
		status: view.status,
		exit_code: view.exitCode,
		wall_time_seconds: Math.max(0, Math.round((Date.now() - view.startedAt) / 100) / 10),
		deadline_at: new Date(view.deadlineAt).toISOString(),
		timeout_at: view.timeoutAt === null ? null : new Date(view.timeoutAt).toISOString(),
		overdue: view.status === "running" && view.overdue,
		notice: view.status === "running" ? "idle-wake-or-next-request" : "returned",
	};
}

function dispositionFor(executionId: string, delivery: ReturnType<typeof createBashDelivery>, remembered: Map<string, NoticeDisposition>): NoticeDisposition | undefined {
	if (remembered.get(executionId) === "observed" || delivery.inspectable(executionId)?.consumed === true || delivery.inspectable(executionId)?.suppressed === true) return "observed";
	const fact = delivery.inspectable(executionId);
	if (fact?.returning || remembered.get(executionId) === "returning") return "returning";
	if (fact && fact.status !== "running") return "pending";
	return remembered.get(executionId);
}

function executionFact(view: BashExecutionView, remembered: NoticeDisposition | undefined, checkpoint?: { id: string; disposition: NoticeDisposition }): ExecutionFact {
	const terminal = view.status !== "running";
	const disposition = terminal ? remembered ?? "pending" : "pending";
	return {
		...(!terminal && view.overdue && checkpoint ? { checkpoint: { id: checkpoint.id, disposition: checkpoint.disposition, summary: checkpoint.disposition === "pending" ? checkpointSummary(view) : "" } } : {}),
		id: view.executionId,
		...(view.toolCallId ? { toolCallId: view.toolCallId } : {}),
		phase: terminal ? "terminal" : "running",
		status: view.status,
		exitCode: view.exitCode,
		summary: terminal && disposition === "pending" ? `Bash job ${view.executionId} finished with status ${view.status}, exit_code ${view.exitCode === null ? "unknown" : String(view.exitCode)}. This is the same execution, not a second tool result.\n${view.output}`.trim() : "",
		disposition,
	};
}

function unavailableEvent(ctx: ExtensionContext): BashExecutionEvent {
	return {
		version: 1,
		executionId: "",
		owner: BASH_OWNER,
		sessionId: ctx.sessionManager.getSessionId(),
		branchAnchor: ctx.sessionManager.getLeafId(),
		toolCallId: null,
		phase: "unavailable",
		status: "unavailable",
		exitCode: null,
		deadlineAt: null,
		timeoutAt: null,
		overdue: false,
		checkpoint: 0,
		truncated: false,
		outputTail: "",
		notice: "wake-unavailable",
		label: "Bash",
		terminalAt: null,
		lastOutputAt: null,
	};
}

function commandEnv(ctx: ExtensionToolContext): NodeJS.ProcessEnv {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const binDir = join(getAgentDir(), "bin");
	const current = process.env[pathKey] ?? "";
	const path = current.split(delimiter).includes(binDir) ? current : [binDir, current].filter(Boolean).join(delimiter);
	const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: path };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}
