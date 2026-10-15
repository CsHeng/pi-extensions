import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { durationMsFromSeconds, timestampAfter } from "../shared/duration-timer.ts";
import { registerSettlementBarrier, releaseModelWake, reserveModelWake } from "../shared/settlement.ts";

import { createShellDelivery } from "./delivery.ts";
import { createShellExecutionOwner, type ShellExecutionEvent, type ShellExecutionOwner, type ShellExecutionView, type ShellScope, type ShellStatus } from "./execution.ts";
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
	], { description: "run starts a command. inspect reads one execution immediately for one concrete progress question, not polling. wait waits without stopping or renewing it. renew extends that same execution. cancel stops it." })),
	executionId: Type.Optional(Type.String({ description: "Stable execution id returned by run. Not a process id." })),
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

const NOTIFICATION = "Running is not success and this call will not receive a second tool result. A later terminal is delivered once on an idle wake or the next model request. inspect is for one concrete progress question, not polling. If no independent work can run, end this turn with the execution pending and rely on that notification. Do not claim success or mark the task blocked merely to wait.";

export function bindRetainedShell(pi: ExtensionAPI, owner: ShellExecutionOwner = createDefaultOwner(pi)): void {
	const delivery = createShellDelivery();
	const openStarts = new Set<string>();
	const openWaits = new Set<string>();
	let decided = false;
	let context: ExtensionContext | undefined;
	const barrier = registerSettlementBarrier(pi, {
		command: "csheng-shell-wait",
		tool: "bash",
		enabled: () => context !== undefined && delivery.hasDeliverable(scopeOf(context)),
	});
	const requestIdle = (ctx: ExtensionContext): void => {
		context = ctx;
		if (!delivery.hasDeliverable(scopeOf(ctx)) || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		barrier.arm();
		if (barrier.waiting) {
			barrier.schedule((idle) => { void sendWake(idle); });
			return;
		}
		if (ctx.isIdle()) void sendWake(ctx);
	};
	const sendWake = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted || !ctx.isProjectTrusted() || barrier.aborted) return;
		if (!delivery.hasDeliverable(scopeOf(ctx)) || !pi.getActiveTools().includes("bash") || !reserveModelWake(pi, ctx)) return;
		const content = delivery.preview(scopeOf(ctx));
		if (!content) { releaseModelWake(pi); return; }
		try {
			await pi.sendMessage({ customType: SHELL_EXECUTION_EVENT, content, display: false, details: { version: 1 } }, { triggerTurn: true });
		} catch {
			releaseModelWake(pi);
			delivery.fence();
		}
	};
	pi.events.on(SHELL_EXECUTION_EVENT, (raw) => {
		const event = raw as ShellExecutionEvent;
		if (event.phase !== "exited" && event.phase !== "cancelled" && event.phase !== "deadline" && event.phase !== "interrupted") return;
		const open = (event.toolCallId !== null && openStarts.has(event.toolCallId)) || openWaits.has(event.executionId);
		if (open) delivery.noteReturning(event);
		else {
			delivery.noteReady(event);
			if (context) requestIdle(context);
		}
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
			return;
		}
		if (claim === "other-owner") {
			decided = true;
			try { pi.events.emit(SHELL_EXECUTION_EVENT, unavailableEvent(ctx)); } catch { /* Unavailable notice is optional. */ }
			return;
		}
		decided = true;
		pi.registerTool(createRetainedBashTool(pi, owner, openStarts, openWaits, delivery));
	};
	const switchScope = (ctx: ExtensionContext): void => {
		context = ctx;
		delivery.fence();
		decide(ctx);
		void owner.interruptOthers(scopeOf(ctx));
	};
	pi.on("session_start", (_event, ctx) => { switchScope(ctx); });
	pi.on("session_tree", (_event, ctx) => { switchScope(ctx); });
	pi.on("before_agent_start", (_event, ctx) => { context = ctx; decide(ctx); });
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.signal?.aborted) return;
		// Reserve before a co-loaded reminder command sends, so its context hook can merge into this turn.
		if (ctx.isIdle() && delivery.hasDeliverable(scopeOf(ctx))) void sendWake(ctx);
		else requestIdle(ctx);
	});
	pi.on("input", (event) => { if (event.source === "interactive" || event.source === "rpc") delivery.fence(); });
	pi.on("agent_end", (event) => {
		if (event.messages.some((message) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))) delivery.fence();
	});
	pi.on("context_with_system", (event, ctx) => {
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === SHELL_EXECUTION_EVENT));
		if (ctx.signal?.aborted || !ctx.isProjectTrusted()) return { messages };
		const content = delivery.preview(scopeOf(ctx));
		if (content) {
			messages.push({ role: "custom", customType: SHELL_EXECUTION_EVENT, content, display: false, timestamp: Date.now() });
			delivery.project(scopeOf(ctx));
		}
		return { messages };
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
	});
	pi.on("session_shutdown", async () => { await owner.shutdown(); });
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
		description: "Execute a bash command. In TUI/RPC, a command that is still running after the foreground window returns status running and keeps the same execution. The default execution deadline is 600 seconds. timeout and deadlineSeconds select an explicit positive finite deadline, the shorter one wins, and it is not clamped to a product cap. That deadline kills the process. Omitted waitSeconds is 180 and omitted foregroundSeconds is 2; an explicit positive finite value is honored with no product cap. inspect reads one execution immediately for one concrete progress question, not polling, and never waits. wait expiry or abort releases this call only and does not cancel or renew the execution. A running result is not success. If no independent work can run, end the turn with the execution pending and rely on the one terminal notification. Do not claim success or mark the task blocked merely to wait.",
		promptSnippet: "Execute bash. A long TUI/RPC command can return while that same execution continues. inspect is one concrete progress question, not polling. If no independent work can run, end the turn and rely on the terminal notification.",
		promptGuidelines: [
			"A running bash result is not a successful exit and does not get another result on the same call id.",
			"inspect reads the current snapshot for one concrete progress question, not polling. It does not wait.",
			"wait observes without cancelling or renewing. Omitted waitSeconds is 180; an explicit positive finite duration is honored with no product cap.",
			"If no independent work can run, end the turn with the execution pending and rely on the one terminal notification. Do not claim success or mark the task blocked merely to wait.",
			"renew extends that same execution. cancel is the only action that stops it. Do not start a second command to poll the first.",
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
	if (view.status !== "exited") lines.push("This is not a successful exit.");
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
