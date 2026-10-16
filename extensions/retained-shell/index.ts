import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { durationMsFromSeconds, timestampAfter } from "../shared/duration-timer.ts";
import { emptyLoopFacts, LOOP_FACTS_EVENT, LOOP_NOTICE_ACK, LOOP_SNAPSHOT_REQUEST, type LoopDisposition, type LoopExecution, type LoopFacts, type LoopNoticeAck, type LoopSnapshotRequest } from "../shared/loop-facts.ts";

import { createShellDelivery } from "./delivery.ts";
import { validateShellCall } from "./validate.ts";
import { createShellExecutionOwner, inShellScope, type ShellExecutionEvent, type ShellExecutionOwner, type ShellExecutionView, type ShellScope, type ShellStatus } from "./execution.ts";
import { registerJobsView, type JobsClaim } from "./jobs-view.ts";
import {
	DEFAULT_DEADLINE_SECONDS,
	DEFAULT_FOREGROUND_SECONDS,
	DEFAULT_WAIT_SECONDS,
	SHELL_EXECUTION_EVENT,
	SHELL_OWNER,
	shellClaim,
} from "./policy.ts";

export { SHELL_EXECUTION_EVENT, SHELL_OWNER, shellClaim };
export type { ShellExecutionEvent, ShellExecutionView, ShellStatus };

const parameters = Type.Object({
	command: Type.Optional(Type.String({ description: "Shell command. Required when starting an execution." })),
	timeout: Type.Optional(Type.Number({ description: "Execution deadline in seconds. Omitted uses 600. An explicit positive finite value is honored with no product cap. The process is killed at this deadline. It does not only stop waiting." })),
	action: Type.Optional(Type.Union([
		Type.Literal("run"),
		Type.Literal("inspect"),
		Type.Literal("wait"),
		Type.Literal("renew"),
		Type.Literal("cancel"),
	], { description: "run starts a command. inspect returns a snapshot for a specific diagnostic question. wait holds this call for a terminal result within waitSeconds. renew extends the execution deadline; cancel stops the execution. For completion alone after a running result, yield to the session notification instead of polling." })),
	executionId: Type.Optional(Type.String({ description: "Copy the execution_id returned by run and pair it with an explicit control action. This identifies the retained execution, not an OS process." })),
	background: Type.Optional(Type.Boolean({ description: "Return as soon as the execution is running. The process keeps going." })),
	deadlineSeconds: Type.Optional(Type.Number({ description: "Finite execution deadline in seconds for a new run, or the new deadline for renew. Omitted start uses 600. An explicit positive finite value is honored with no product cap and kills the process at that deadline." })),
	waitSeconds: Type.Optional(Type.Number({ description: "How long wait may hold this call. Omitted uses 180 seconds. An explicit positive finite value is honored with no product cap. Expiry or abort releases this call only and does not cancel or renew the execution." })),
	foregroundSeconds: Type.Optional(Type.Number({ description: "How long a non-background run may hold this call before returning while the execution continues. Omitted uses 2 seconds. An explicit positive finite value is honored with no product cap." })),
});

const outputSchema = Type.Object({
	output: Type.String(),
	truncated: Type.Boolean(),
	execution_id: Type.String(),
	status: Type.String(),
	exit_code: Type.Union([Type.Number(), Type.Null()]),
	wall_time_seconds: Type.Number(),
	deadline_at: Type.Union([Type.String(), Type.Null()]),
	notification: Type.String(),
});

const NOTIFICATION = "This execution is still active under the same execution_id. Continue independent work, or finish this model turn with the task pending so the session can deliver its terminal notification. Use inspect for a specific diagnostic question; for completion alone, rely on the notification rather than repeated snapshots. Assess the terminal status and exit_code before reporting the outcome.";

export function bindRetainedShell(pi: ExtensionAPI, owner: ShellExecutionOwner = createDefaultOwner(pi)): void {
	const delivery = createShellDelivery();
	const openStarts = new Set<string>();
	const openWaits = new Set<string>();
	let decided = false;
	let jobsClaim: JobsClaim = "inactive";
	let context: ExtensionContext | undefined;
	const jobs = registerJobsView(pi, owner, () => jobsClaim);
	const dispositions = new Map<string, "pending" | "returning" | "observed">();
	const shellFacts = (): LoopFacts => {
		if (!context) return emptyLoopFacts("retained-shell", "unknown");
		if (!decided || jobsClaim === "inactive" || jobsClaim === "other-owner") {
			return emptyLoopFacts("retained-shell", decided ? "inactive" : "unknown", context.sessionManager.getSessionId(), context.sessionManager.getLeafId());
		}
		const scope = scopeOf(context);
		const listed = owner.list(scope);
		const executions = listed.map((view) => executionFact(view, dispositionFor(view.executionId, delivery, dispositions)));
		const listedIds = new Set(listed.map((view) => view.executionId));
		for (const fact of delivery.pending(scope)) {
			if (listedIds.has(fact.executionId) || dispositions.get(fact.executionId) === "observed") continue;
			executions.push({
				id: fact.executionId,
				phase: "terminal",
				status: fact.status,
				exitCode: fact.exitCode,
				summary: `Shell execution ${fact.executionId} finished with status ${fact.status}, exit_code ${fact.exitCode === null ? "unknown" : String(fact.exitCode)}. This is the same execution, not a second tool result.\n${fact.outputTail}`.trim(),
				disposition: "pending",
			});
		}
		return {
			version: 1,
			producer: "retained-shell",
			availability: "ready",
			sessionId: scope.sessionId,
			branchAnchor: scope.branchAnchor,
			generation: String(executions.length),
			executions,
		};
	};
	const publish = (): void => { try { pi.events.emit(LOOP_FACTS_EVENT, shellFacts()); } catch { /* Fact publication cannot change the process. */ } };
	pi.events.on(LOOP_SNAPSHOT_REQUEST, (raw) => {
		const accept = (raw as Partial<LoopSnapshotRequest> | undefined)?.accept;
		if (typeof accept === "function") accept(shellFacts());
	});
	pi.events.on(LOOP_NOTICE_ACK, (raw) => {
		const ack = raw as Partial<LoopNoticeAck> | undefined;
		if (ack?.version !== 1 || ack.producer !== "retained-shell" || !Array.isArray(ack.ids)) return;
		delivery.acknowledge(ack.ids);
		for (const id of ack.ids) dispositions.set(id, "observed");
		publish();
	});
	pi.events.on(SHELL_EXECUTION_EVENT, (raw) => {
		const event = raw as ShellExecutionEvent;
		if (event.phase === "unavailable") { publish(); return; }
		if (!event.executionId || !context) return;
		const scope = scopeOf(context);
		if (!inShellScope(event, scope)) return;
		const terminal = event.phase === "exited" || event.phase === "cancelled" || event.phase === "deadline" || event.phase === "interrupted";
		const open = (event.toolCallId !== null && openStarts.has(event.toolCallId)) || openWaits.has(event.executionId);
		if (terminal) {
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
		const claim = shellClaim(ctx.mode, source);
		if (claim === "leave-native") {
			decided = true;
			jobsClaim = "inactive";
			return;
		}
		if (claim === "other-owner") {
			decided = true;
			jobsClaim = "other-owner";
			try { pi.events.emit(SHELL_EXECUTION_EVENT, unavailableEvent(ctx)); } catch { /* Unavailable notice is optional. */ }
			return;
		}
		decided = true;
		jobsClaim = "ready";
		pi.registerTool(createRetainedBashTool(pi, owner, openStarts, openWaits, delivery));
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
			return { block: true, reason: "Retained shell is unavailable in this mode. Use native foreground bash with timeout; no command was started." };
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "bash") return;
		const details = event.result?.details as { executionId?: string; status?: string } | undefined;
		if (!details?.executionId || details.status === "running" || details.status === "rejected") return;
		delivery.notePull(details.executionId);
		dispositions.set(details.executionId, "observed");
		publish();
	});
	pi.on("session_shutdown", async () => { jobs.unbind(); await owner.shutdown(); });
}

export default function retainedShellExtension(pi: ExtensionAPI): void {
	bindRetainedShell(pi);
}

function createDefaultOwner(pi: ExtensionAPI): ShellExecutionOwner {
	return createShellExecutionOwner({
		spawnSpec: () => {
			const shellPath = pi.getSettings().shellPath;
			return getShellConfig(typeof shellPath === "string" ? shellPath : undefined);
		},
		onEvent: (event) => { pi.events.emit(SHELL_EXECUTION_EVENT, event); },
	});
}

function createRetainedBashTool(
	pi: ExtensionAPI,
	owner: ShellExecutionOwner,
	openStarts: Set<string>,
	openWaits: Set<string>,
	delivery: ReturnType<typeof createShellDelivery>,
) {
	void pi;
	return {
		name: "bash",
		label: "bash",
		description: "Execute shell commands and manage retained executions. Start with {\"command\":\"bun test\"}. In TUI/RPC, work still running after the foreground window returns status=running with an execution_id. Keep that id, advance independent work, or finish the model turn with the task pending; the session delivers completion separately. For a specific diagnostic question, inspect with {\"action\":\"inspect\",\"executionId\":\"exec_example\"}. To await a terminal result within one call, choose the wait action with executionId and optional waitSeconds. inspect is an immediate snapshot, not a completion-wait loop. Control actions are structured fields; command contains shell code. Use foregroundSeconds for the initial observation window, waitSeconds for wait, and timeout/deadlineSeconds for the process lifetime. Wait expiry releases only the observation call. renew extends the execution deadline; cancel stops the execution. Judge the outcome from terminal status and exit_code.",
		promptSnippet: "Execute bash. After a running result, do independent work or finish the turn with the execution pending; completion arrives through a session notification.",
		promptGuidelines: [
			"After bash returns running, keep its execution_id and advance independent work. If only execution-dependent work remains, finish the model turn with tasks unfinished; the terminal notification can resume work.",
			"Use inspect for a specific diagnostic question requiring fresh output. For completion alone, rely on the notification rather than repeated snapshots or another shell command.",
			"Use wait when holding one call for a terminal result is useful. Its default observation budget is 180 seconds; explicit positive finite durations are honored. Expiry or abort leaves the execution and deadline unchanged.",
			"Manage the same execution with action and executionId: renew extends its deadline, cancel stops it. Assess terminal status and exit_code before reporting success; the original running call has already returned.",
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
				const validated = validateShellCall(params);
				if (!validated.ok) return failed(validated.message);
				if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
					return failed("Retained shell is unavailable in this mode. The native foreground shell was not started.");
				}
				const action = params.action ?? "run";
				if (action === "inspect" || action === "wait" || action === "renew" || action === "cancel") {
					const executionId = params.executionId;
					if (!executionId) return failed(`action ${action} requires executionId`);
					if (action === "inspect") {
						const view = owner.inspect(executionId, scope);
						return view ? resultOf(view, false) : failed(`Unknown shell execution: ${executionId}`);
					}
					if (action === "wait") {
						openWaits.add(executionId);
						try {
							const view = await owner.wait(executionId, scope, {
								...(signal ? { signal } : {}),
								waitMs: durationMsFromSeconds(params.waitSeconds, DEFAULT_WAIT_SECONDS),
							});
							return resultOf(view, false);
						} finally { openWaits.delete(executionId); }
					}
					if (action === "renew") {
						if (params.deadlineSeconds === undefined) return failed("renew requires deadlineSeconds for the same execution");
						const deadlineMs = durationMsFromSeconds(params.deadlineSeconds, params.deadlineSeconds);
						timestampAfter(Date.now(), deadlineMs);
						return resultOf(owner.renew(executionId, scope, deadlineMs), false);
					}
					return resultOf(await owner.cancel(executionId, scope), false);
				}
				if (!params.command) return failed("command is required to start a shell execution");
				const requested = [params.deadlineSeconds, params.timeout].filter((value): value is number => value !== undefined);
				const deadlineMs = durationMsFromSeconds(requested.length === 0 ? undefined : Math.min(...requested), DEFAULT_DEADLINE_SECONDS);
				timestampAfter(Date.now(), deadlineMs);
				const foregroundWindowMs = params.background ? 0 : durationMsFromSeconds(params.foregroundSeconds, DEFAULT_FOREGROUND_SECONDS);
				openStarts.add(toolCallId);
				try {
					const view = await owner.start({
						command: params.command,
						cwd: ctx.cwd,
						env: commandEnv(ctx),
						sessionId: scope.sessionId,
						branchAnchor: scope.branchAnchor,
						toolCallId,
						deadlineMs,
						foregroundWindowMs,
						...(signal ? { signal } : {}),
					});
					return resultOf(view, false);
				} finally { openStarts.delete(toolCallId); }
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

function scopeOf(ctx: ExtensionContext): ShellScope {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		branchAnchor: ctx.sessionManager.getLeafId(),
		branchIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
	};
}

function resultOf(view: ShellExecutionView, forceError: boolean) {
	const failedStatus = view.status === "cancelled" || view.status === "deadline" || view.status === "interrupted" || (view.status === "exited" && view.exitCode !== 0);
	return {
		content: [{ type: "text" as const, text: renderView(view) }],
		details: {
			executionId: view.executionId,
			status: view.status,
			exitCode: view.exitCode,
			truncated: view.truncated,
			deadlineAt: new Date(view.deadlineAt).toISOString(),
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

function renderView(view: ShellExecutionView): string {
	const lines = [
		`status: ${view.status}`,
		`execution_id: ${view.executionId}`,
		`owner: ${view.owner}`,
		`deadline: ${new Date(view.deadlineAt).toISOString()}`,
		`exit_code: ${view.exitCode === null ? "unknown" : String(view.exitCode)}`,
		view.truncated ? "output: truncated" : "output: complete",
		view.output || "(no output)",
	];
	if (view.status === "running") lines.push(NOTIFICATION);
	else if (view.status !== "exited") lines.push("Execution ended without a successful exit.");
	return lines.join("\n");
}

function structured(view: ShellExecutionView) {
	return {
		output: view.output,
		truncated: view.truncated,
		execution_id: view.executionId,
		status: view.status,
		exit_code: view.exitCode,
		wall_time_seconds: Math.max(0, Math.round((Date.now() - view.startedAt) / 100) / 10),
		deadline_at: new Date(view.deadlineAt).toISOString(),
		notification: view.status === "running" ? "idle-wake-or-next-request" : "returned",
	};
}

function dispositionFor(executionId: string, delivery: ReturnType<typeof createShellDelivery>, remembered: Map<string, LoopDisposition>): LoopDisposition | undefined {
	if (remembered.get(executionId) === "observed" || delivery.inspectable(executionId)?.consumed === true || delivery.inspectable(executionId)?.suppressed === true) return "observed";
	const fact = delivery.inspectable(executionId);
	if (fact?.returning || remembered.get(executionId) === "returning") return "returning";
	if (fact && fact.status !== "running") return "pending";
	return remembered.get(executionId);
}

function executionFact(view: ShellExecutionView, remembered: LoopDisposition | undefined): LoopExecution {
	const terminal = view.status !== "running";
	const disposition = terminal ? remembered ?? "pending" : "pending";
	return {
		id: view.executionId,
		phase: terminal ? "terminal" : "running",
		status: view.status,
		exitCode: view.exitCode,
		summary: terminal && disposition === "pending" ? `Shell execution ${view.executionId} finished with status ${view.status}, exit_code ${view.exitCode === null ? "unknown" : String(view.exitCode)}. This is the same execution, not a second tool result.\n${view.output}`.trim() : "",
		disposition,
	};
}

function unavailableEvent(ctx: ExtensionContext): ShellExecutionEvent {
	return {
		version: 1,
		executionId: "",
		owner: SHELL_OWNER,
		sessionId: ctx.sessionManager.getSessionId(),
		branchAnchor: ctx.sessionManager.getLeafId(),
		toolCallId: null,
		phase: "unavailable",
		status: "unavailable",
		exitCode: null,
		deadlineAt: null,
		truncated: false,
		outputTail: "",
		notification: "wake-unavailable",
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
