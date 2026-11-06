import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createInteractionBoundary, latestAssistantFailed, type InteractionClose } from "./shared/interaction-boundary.ts";

const HOOK_TIMEOUT_MS = 5500;
const SUMMARY_MAX_CHARS = 300;
const UNAVAILABLE_PREFIX = "State unavailable: ";

type HookEvent = "UserPromptSubmit" | "Stop" | "StopFailure";

function assistantSummary(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.replace(/[\r\n]+/g, " ")
			.slice(0, SUMMARY_MAX_CHARS);
	}
	return "";
}

function invokeHook(eventName: HookEvent, ctx: ExtensionContext, summary = "", durationMs?: number): Promise<void> {
	return new Promise((resolve) => {
		const hookPath = join(process.env.HOME ?? "", ".local", "bin", "agent-bark-hook");
		const child = spawn(hookPath, ["pi"], {
			env: process.env,
			stdio: ["pipe", "ignore", "ignore"],
		});
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			child.kill();
			finish();
		}, HOOK_TIMEOUT_MS);

		child.on("error", finish);
		child.on("close", finish);
		child.stdin.on("error", () => {});
		child.stdin.end(
			JSON.stringify({
				hook_event_name: eventName,
				session_id: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				last_assistant_message: summary,
				...(durationMs === undefined ? {} : { duration_ms: Math.round(Math.max(0, durationMs)) }),
			}),
		);
	});
}

/** Hosts whose main loop can be resumed by asynchronous result delivery. */
const interactive = (ctx: ExtensionContext): boolean => ctx.mode === "tui" || ctx.mode === "rpc";

export default function (pi: ExtensionAPI): void {
	// This marker excludes child processes, not internal wake runs in the parent session.
	if (process.env.CSHENG_SUBAGENT_CHILD === "1") return;

	const now = () => performance.now();
	// Hook deliveries in flight; host handlers await them so the hook keeps its event order.
	let delivery: Promise<void> = Promise.resolve();
	const deliver = (send: () => Promise<void>): void => {
		delivery = delivery.then(send, send);
	};

	/**
	 * Notify when a person needs to look again: success or any failure of the whole
	 * interaction, judged by the same shared boundary that ends work timing. A person who
	 * aborted or typed already holds the session, so an interrupted interaction stays silent.
	 */
	const notifyClose = ({ span, status, totalMs }: InteractionClose<undefined>): void => {
		if (status === "interrupted") return;
		const ctx = span.ctx;
		const summary = assistantSummary(ctx);
		if (status === "settled") deliver(() => invokeHook("Stop", ctx, summary, totalMs));
		else deliver(() => invokeHook("StopFailure", ctx, status === "unavailable" ? (UNAVAILABLE_PREFIX + summary).slice(0, SUMMARY_MAX_CHARS) : summary, totalMs));
	};

	const boundary = createInteractionBoundary<undefined>({
		pi,
		now,
		createData: () => undefined,
		promoteData: () => undefined,
		onStart: span => deliver(() => invokeHook("UserPromptSubmit", span.ctx)),
		onClose: notifyClose,
	});

	// One-shot hosts never resume the main loop from asynchronous results, so a user run's
	// settlement ends its interaction there.
	let oneShotStartedAt: number | undefined;

	pi.on("input", (event, ctx) => {
		if (interactive(ctx)) boundary.input(event.source, ctx, now());
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (interactive(ctx)) {
			boundary.beforeAgentStart(event.messageType, ctx, now());
		} else {
			// Classify every start; a custom run never inherits an earlier user run.
			oneShotStartedAt = event.messageType === "user" ? now() : undefined;
			if (oneShotStartedAt !== undefined) deliver(() => invokeHook("UserPromptSubmit", ctx));
		}
		await delivery;
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (interactive(ctx)) boundary.toolStart(event.toolCallId, now());
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (interactive(ctx)) boundary.toolEnd((event as { result?: unknown }).result, now());
	});
	pi.on("ui_prompt_start", (_event, ctx) => {
		if (interactive(ctx)) boundary.promptStart(now());
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		if (interactive(ctx)) boundary.promptEnd(now());
	});
	pi.on("turn_end", (_event, ctx) => {
		if (interactive(ctx)) boundary.closePrompt(now());
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (interactive(ctx)) {
			boundary.settled(event.aborted === true, ctx, now());
		} else if (oneShotStartedAt !== undefined) {
			const startedAt = oneShotStartedAt;
			oneShotStartedAt = undefined;
			if (!event.aborted) {
				const failed = latestAssistantFailed(ctx);
				const summary = assistantSummary(ctx);
				deliver(() => invokeHook(failed ? "StopFailure" : "Stop", ctx, summary, now() - startedAt));
			}
		}
		await delivery;
	});

	// Session replacement must not inherit an earlier interaction or its notification.
	const reset = (): void => {
		boundary.reset();
		oneShotStartedAt = undefined;
	};
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", async () => {
		reset();
		// A final notification may have been decided just before shutdown; each hook call is bounded.
		await delivery;
	});
}
