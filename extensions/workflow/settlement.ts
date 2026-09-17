import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_TOOL_NAME } from "./contracts.ts";
import { isUserInputSource } from "./host-adapter.ts";

const WAIT_COMMAND = "csheng-workflow-wait";

/** A public command-context wait, armed before settlement, not a timer or isIdle barrier. */
export interface SettlementBarrier {
	/** Register a synchronous final eligibility check; returns false when no real waiter exists. */
	schedule(review: (ctx: ExtensionContext) => void): boolean;
}

interface RunWait {
	token: string;
	sessionId: string | undefined;
	signal: AbortSignal;
	waiting: boolean;
	request?: { epoch: number; review: (ctx: ExtensionContext) => void };
}

export function registerSettlementBarrier(pi: ExtensionAPI): SettlementBarrier {
	let current: RunWait | undefined;
	let inputEpoch = 0;
	const invalidate = () => { current = undefined; };
	pi.registerCommand(WAIT_COMMAND, {
		description: "Internal workflow settlement waiter; not a user continuation command",
		handler: async (args, ctx) => {
			const run = current;
			// A model/user command cannot create a lease, reuse one, or arm after the idle flag flips.
			if (!run || args !== run.token || run.waiting || ctx.isIdle()) return;
			run.waiting = true;
			try {
				await ctx.waitForIdle();
			} catch {
				if (current === run) invalidate();
				return;
			}
			run.waiting = false;
			if (current !== run || run.signal.aborted || ctx.sessionManager.getSessionId() !== run.sessionId
				|| !ctx.isIdle() || ctx.hasPendingMessages()) return;
			const request = run.request;
			delete run.request;
			if (request?.epoch === inputEpoch) request.review(ctx);
		},
	});
	pi.on("agent_start", (_event, ctx) => {
		invalidate();
		if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.isProjectTrusted()
			|| !pi.getActiveTools().includes(WORKFLOW_TOOL_NAME) || !ctx.signal || ctx.isIdle()) return;
		current = { token: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), signal: ctx.signal, waiting: false };
		// Public extension-command dispatch is checked before streaming input queueing. It must
		// not be awaited here: the command's wait is waiting for this event/run to finish.
		pi.sendUserMessage(`/${WAIT_COMMAND} ${current.token}`, { expandPromptTemplates: true });
	});
	pi.on("input", (event) => {
		if (!isUserInputSource(event.source)) return;
		inputEpoch += 1;
		if (current) delete current.request;
	});
	pi.on("session_start", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("session_shutdown", invalidate);
	return {
		schedule(review) {
			if (!current?.waiting || current.signal.aborted || current.request) return false;
			current.request = { epoch: inputEpoch, review };
			return true;
		},
	};
}
