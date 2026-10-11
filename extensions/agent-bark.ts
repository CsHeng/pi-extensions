import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HOOK_TIMEOUT_MS = 5500;
const SUMMARY_MAX_CHARS = 300;

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

function latestAssistantFailed(ctx: ExtensionContext): boolean {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "message" && entry.message.role === "assistant") {
			return entry.message.stopReason === "error";
		}
	}
	return false;
}

function invokeHook(eventName: HookEvent, ctx: ExtensionContext, summary = ""): Promise<void> {
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
			}),
		);
	});
}

export default function (pi: ExtensionAPI): void {
	if (process.env.CSHENG_SUBAGENT_CHILD === "1") return;

	pi.on("before_agent_start", async (_event, ctx) => {
		await invokeHook("UserPromptSubmit", ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await invokeHook(
			latestAssistantFailed(ctx) ? "StopFailure" : "Stop",
			ctx,
			assistantSummary(ctx),
		);
	});
}
