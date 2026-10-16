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

/** One idle-start reservation shared by co-loaded extensions, not an execution scheduler.
 * Keep it through preflight until request preparation or explicit invalidation. */
interface WakeState { sessionId?: string; listening?: boolean }
const wakeStates = new WeakMap<ExtensionAPI["events"], WakeState>();
const WAKE_STATE_EVENT = "csheng.model-wake.state";
function wakeState(pi: ExtensionAPI): WakeState {
	const cached = wakeStates.get(pi.events);
	if (cached) return cached;
	// Pi exposes a different events facade to each extension. Resolve the one
	// ephemeral lease through their shared public bus, not facade identity.
	let shared: WakeState | undefined;
	pi.events.emit(WAKE_STATE_EVENT, { accept: (state: WakeState) => { shared = state; } });
	const state = shared ?? {};
	if (!shared) pi.events.on(WAKE_STATE_EVENT, request => {
		const accept = (request as { accept?: (state: WakeState) => void })?.accept;
		if (typeof accept === "function") accept(state);
	});
	wakeStates.set(pi.events, state);
	return state;
}
export function reserveModelWake(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const state = wakeState(pi);
	if (!state.listening) {
		state.listening = true;
		const clear = () => { delete state.sessionId; };
		// Every extension must observe the lease through request preparation, regardless
		// of factory load order. Synthetic providers may omit transport hooks.
		pi.on("before_provider_request", clear);
		pi.on("message_start", event => { if (event.message.role === "assistant") clear(); });
		pi.on("input", event => { if (event.source === "interactive" || event.source === "rpc") clear(); });
		pi.on("agent_end", event => { if (event.messages.some(message => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason))) clear(); });
		pi.on("session_start", clear);
		pi.on("session_tree", clear);
		pi.on("session_shutdown", clear);
	}
	const sessionId = ctx.sessionManager.getSessionId();
	if (state.sessionId === sessionId) return false;
	if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted || !ctx.isProjectTrusted()) return false;
	state.sessionId = sessionId;
	return true;
}
export function modelWakeReserved(pi: ExtensionAPI, ctx: ExtensionContext): boolean { return wakeState(pi).sessionId === ctx.sessionManager.getSessionId(); }
export function releaseModelWake(pi: ExtensionAPI): void { delete wakeState(pi).sessionId; }

interface RunWait {
	token: string;
	sessionId: string | undefined;
	signal: AbortSignal;
	waiting: boolean;
	request?: { epoch: number; review: (ctx: ExtensionContext) => void };
}

export function registerSettlementBarrier(pi: ExtensionAPI, options: { command: string; tool?: string; enabled: () => boolean; compaction?: boolean }): SettlementBarrier {
	let current: RunWait | undefined;
	let active: ExtensionContext | undefined;
	let activeSignal: AbortSignal | undefined;
	let inputEpoch = 0;
	const invalidate = () => { current = undefined; active = undefined; activeSignal = undefined; };
	const arm = (): boolean => {
		const ctx = active;
		if (!ctx || !options.enabled() || (ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.isProjectTrusted()
			|| (options.tool !== undefined && !pi.getActiveTools().includes(options.tool)) || !activeSignal || activeSignal.aborted || ctx.isIdle()) return false;
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
