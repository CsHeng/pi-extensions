import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MANAGED_LIMITS, SUBAGENT_SESSION_TOOL_NAME, type SessionView } from "./session-contracts.ts";

export const MANAGED_CONTEXT_TYPE = "csheng-managed-session-index";

/** Metadata only. This is neither persisted history nor an instruction to resume work. */
export function managedContextIndex(views: readonly SessionView[]): string | undefined {
	if (views.length > MANAGED_LIMITS.maxSessions) throw new Error("managed_index_limit");
	const active = views.filter((view) => view.state !== "closed").sort((left, right) => left.handle < right.handle ? -1 : 1);
	if (!active.length) return undefined;
	const lines = active.map((view) => {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(view.handle) || !Number.isSafeInteger(view.episode) || view.episode < 0) throw new Error("managed_index_invalid");
		const route = view.result?.route ?? view.route;
		const scalar = (value: string) => value.replace(/\s+/g, " ").slice(0, 300);
		return `${view.handle} role=${view.role} episode=${view.episode} stored=${view.state} report=${view.reportComplete ? "complete" : "incomplete"} candidate=${view.candidate?.status ?? "none"}${route ? ` route=${scalar(route.provider)}/${scalar(route.model)} thinking=${scalar(route.thinking)}` : ""}`;
	});
	return `Stored local-task index; idle means no running process. Use ${SUBAGENT_SESSION_TOOL_NAME} inspect before continuing or applying; never replay an unknown request automatically.\n${lines.join("\n")}`;
}

export function registerManagedContext(pi: ExtensionAPI, list: (ctx: ExtensionContext) => Promise<readonly SessionView[]>): void {
	pi.on("context", async (event, ctx) => {
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === MANAGED_CONTEXT_TYPE));
		if (!ctx.isProjectTrusted() || !pi.getActiveTools().includes(SUBAGENT_SESSION_TOOL_NAME)) return { messages };
		let content: string | undefined;
		try { content = managedContextIndex(await list(ctx)); }
		catch { content = "Stored local-task index is unavailable. Inspect explicitly before mutation; do not infer a resumable session or replay work."; }
		if (content) messages.push({ role: "custom", customType: MANAGED_CONTEXT_TYPE, content, display: false, timestamp: Date.now() });
		return { messages };
	});
}
