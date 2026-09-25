import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A public command-context wait, armed before settlement, not a timer or isIdle barrier. */
export interface SettlementBarrier {
	/** Arm while the current run is active, including when work is enrolled mid-run. */
	arm(): boolean;
	/** A prearmed public wait is still crossing settlement/compaction consumers. */
	readonly waiting: boolean;
	/** Captured agent/compaction lease, including the idle-before-failure-consumers window. */
	readonly aborted: boolean;
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

export function registerSettlementBarrier(pi: ExtensionAPI, options: { command: string; tool: string; enabled: () => boolean; compaction?: boolean }): SettlementBarrier {
	let current: RunWait | undefined;
	let active: ExtensionContext | undefined;
	let activeSignal: AbortSignal | undefined;
	let inputEpoch = 0;
	const invalidate = () => { current = undefined; active = undefined; activeSignal = undefined; };
	const arm = (): boolean => {
		const ctx = active;
		if (!ctx || !options.enabled() || (ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.isProjectTrusted()
			|| !pi.getActiveTools().includes(options.tool) || !activeSignal || activeSignal.aborted || ctx.isIdle()) return false;
		if (current && current.signal === activeSignal && current.sessionId === ctx.sessionManager.getSessionId()) return true;
		current = { token: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), signal: activeSignal, waiting: false };
		// Dispatch before settlement, never a timer or a late isIdle surrogate.
		pi.sendUserMessage(`/${options.command} ${current.token}`, { expandPromptTemplates: true });
		return true;
	};
	pi.registerCommand(options.command, {
		description: "Internal settlement waiter; not a user continuation command",
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
		active = ctx; activeSignal = ctx.signal;
		arm();
	});
	if (options.compaction) pi.on("session_before_compact", (event, ctx) => {
		invalidate(); active = ctx; activeSignal = event.signal; arm();
	});
	pi.on("input", (event) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		inputEpoch += 1;
		if (current) delete current.request;
	});
	pi.on("session_start", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("session_shutdown", invalidate);
	return {
		arm,
		get waiting() { return current?.waiting === true && !current.signal.aborted; },
		get aborted() { return activeSignal?.aborted === true; },
		schedule(review) {
			if (!current?.waiting || current.signal.aborted || current.request) return false;
			current.request = { epoch: inputEpoch, review };
			return true;
		},
	};
}
