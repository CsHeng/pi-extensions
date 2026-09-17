import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPreparedInputTracker } from "../shared/prepared-input.ts";
import { MANAGED_LIMITS, SUBAGENT_SESSION_TOOL_NAME, type SessionView } from "./session-contracts.ts";

export const MANAGED_CONTEXT_TYPE = "csheng-managed-session-index";

const UNAVAILABLE_CONTEXT =
	"Stored local-task index is unavailable. Inspect explicitly before mutation; do not infer a resumable session or replay work.";

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

/** Ephemeral reference for a new model-bound native input or recovery boundary.
 * Receipts/queues do not open windows. Unknown native origin may show the same non-authorizing
 * index, never a claim of human intent. Known ordinary extension controls do not open windows.
 * Failed requests retain the window for retry; successful assistant output or settlement closes
 * it. Recovery can restore the reference without treating history as a new user input.
 */
export function registerManagedContext(pi: ExtensionAPI, list: (ctx: ExtensionContext) => Promise<readonly SessionView[]>): void {
	let pendingTurn = false;
	const tracker = createPreparedInputTracker();
	const openWindow = () => {
		pendingTurn = true;
	};
	pi.on("input", (event) => { tracker.received(event); });
	pi.on("before_agent_start", () => { tracker.prepare(); });
	pi.on("message_start", (event) => { tracker.observe(event.message); });
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (stopReason !== "error" && stopReason !== "aborted") pendingTurn = false;
	});
	pi.on("agent_settled", () => { pendingTurn = false; tracker.reset(); });
	pi.on("session_start", () => { tracker.reset(); openWindow(); });
	pi.on("session_tree", () => { tracker.reset(); openWindow(); });
	pi.on("session_compact", () => openWindow());
	pi.on("session_shutdown", () => { tracker.reset(); pendingTurn = false; });

	pi.on("context", async (event, ctx) => {
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === MANAGED_CONTEXT_TYPE));
		for (const input of tracker.peek(messages)) {
			if (input.provenance !== "extension") openWindow();
			tracker.commit([input.id]);
		}
		if (!pendingTurn) return { messages };
		if (!ctx.isProjectTrusted() || !pi.getActiveTools().includes(SUBAGENT_SESSION_TOOL_NAME)) return { messages };
		let content: string | undefined;
		try { content = managedContextIndex(await list(ctx)); }
		catch { content = UNAVAILABLE_CONTEXT; }
		if (content) messages.push({ role: "custom", customType: MANAGED_CONTEXT_TYPE, content, display: false, timestamp: Date.now() });
		else pendingTurn = false;
		return { messages };
	});
}
