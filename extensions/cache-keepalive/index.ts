import { calculateCost, type Api, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Idle prompt-cache keepalive.
 *
 * Pi 1.5.0 idle cache warming stops once the context holds a rebuilt message
 * (custom_message, compaction or branch summary). While Pi's `cacheWarming`
 * setting is "streaming", Pi still warms during runs and this extension covers
 * only the idle phase: it replays the last real provider payload with a
 * one-token response, on Pi's own schedule and economics.
 */
export const CACHE_KEEPALIVE_ENTRY_TYPE = "csheng-cache-keepalive";

const ENTRY_VERSION = 1 as const;
const IDLE_CONTINUATION_PROBABILITY = 0.15;
const MINIMUM_EXPECTED_SAVINGS = 0.05;
const MAX_IDLE_AGE_MS = 30 * 60_000;
const ERROR_TEXT_LIMIT = 200;

export interface KeepaliveClock {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

const realClock: KeepaliveClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		handle.unref?.();
		return handle;
	},
	clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Payload = Record<string, unknown>;
type AnyModel = Model<Api>;

interface Capture {
	payload: Payload;
	provider: string;
	modelId: string;
	sentAt: number;
}

interface Run {
	capture: Capture;
	ctx: ExtensionContext;
	model: AnyModel;
	ttlMs: number;
	delayMs: number;
	deadlineAt: number;
	timer?: unknown;
	controller?: AbortController | undefined;
}

export interface RefreshEconomics {
	promptTokens: number;
	warmCost: number;
	missCost: number;
	expectedSavings: number;
	warm: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same refresh delay Pi 1.5.0 uses: 90% of the lifetime, at least 10 s before expiry. */
export function refreshDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

export function promptCacheTtlMs(model: AnyModel, env: NodeJS.ProcessEnv = process.env): number | undefined {
	const retention = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	const seconds = model.promptCache?.[retention];
	return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

/** A one-token replay is valid only without a fixed thinking budget, as Pi requires. */
export function isReplayablePayload(payload: Payload, modelId: string): boolean {
	if (payload.model !== modelId || !Array.isArray(payload.messages)) return false;
	const thinking = payload.thinking;
	if (thinking === undefined) return true;
	return isRecord(thinking) && (thinking.type === "adaptive" || thinking.type === "disabled");
}

function price(model: AnyModel, tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>): number {
	const usage: Usage = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

/** Pi 1.5.0 idle economics: warm when 15% of the avoided rewrite exceeds the refresh by $0.05. */
export function refreshEconomics(model: AnyModel, promptTokens: number): RefreshEconomics {
	const hit = price(model, { cacheRead: promptTokens });
	const miss = price(model, model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens });
	const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
	const missCost = Math.max(0, miss - hit);
	const expectedSavings = IDLE_CONTINUATION_PROBABILITY * missCost - warmCost;
	return {
		promptTokens,
		warmCost,
		missCost,
		expectedSavings,
		warm: promptTokens > 0 && (hit > 0 || miss > 0) && expectedSavings >= MINIMUM_EXPECTED_SAVINGS,
	};
}

function lastPromptTokens(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

function cacheWarmingMode(pi: ExtensionAPI): string {
	const mode = (pi.getSettings() as { cacheWarming?: unknown }).cacheWarming;
	return typeof mode === "string" ? mode : "streaming";
}

function showNotices(pi: ExtensionAPI): boolean {
	return (pi.getSettings() as { showCacheMissNotices?: unknown }).showCacheMissNotices === true;
}

// Only the payload is sent; this context exists so the provider can build a request to replace.
function placeholderContext(): Context {
	return { systemPrompt: "", messages: [{ role: "user", content: ".", timestamp: Date.now() }] } as Context;
}

export function createCacheKeepalive(clock: KeepaliveClock = realClock): (pi: ExtensionAPI) => void {
	return function cacheKeepaliveExtension(pi: ExtensionAPI): void {
		let capture: Capture | undefined;
		let run: Run | undefined;

		function stop(): void {
			const current = run;
			run = undefined;
			if (!current) return;
			if (current.timer !== undefined) clock.clearTimer(current.timer);
			current.timer = undefined;
			current.controller?.abort();
		}

		function reset(): void {
			stop();
			capture = undefined;
		}

		function schedule(current: Run, at: number): void {
			if (at > current.capture.sentAt + MAX_IDLE_AGE_MS) {
				stop();
				return;
			}
			current.deadlineAt = at + Math.floor((current.ttlMs - current.delayMs) / 2);
			current.timer = clock.setTimer(() => void refresh(current), Math.max(0, at - clock.now()));
		}

		function record(current: Run, data: Record<string, unknown>): void {
			pi.appendEntry(CACHE_KEEPALIVE_ENTRY_TYPE, {
				version: ENTRY_VERSION,
				provider: current.model.provider,
				model: current.model.id,
				...data,
			});
		}

		async function refresh(current: Run): Promise<void> {
			current.timer = undefined;
			if (run !== current) return;
			if (clock.now() > current.deadlineAt || cacheWarmingMode(pi) !== "streaming") {
				stop();
				return;
			}
			const economics = refreshEconomics(current.model, lastPromptTokens(current.ctx));
			if (!economics.warm) {
				stop();
				return;
			}
			const startedAt = clock.now();
			const controller = new AbortController();
			current.controller = controller;
			let failure: string | undefined;
			let message: Awaited<ReturnType<ReturnType<ExtensionContext["modelRegistry"]["streamSimple"]>["result"]>> | undefined;
			try {
				message = await current.ctx.modelRegistry.streamSimple(current.model, placeholderContext(), {
					maxTokens: 1,
					maxRetries: 0,
					signal: controller.signal,
					sessionId: current.ctx.sessionManager.getSessionId(),
					onPayload: () => ({ ...current.capture.payload, max_tokens: 1 }),
				}).result();
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					failure = message.errorMessage ?? message.stopReason;
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			current.controller = undefined;
			if (run !== current || controller.signal.aborted) return;
			if (failure !== undefined || !message) {
				// By the next slot a short-lived entry has expired; a retry would pay a full rewrite.
				record(current, {
					outcome: "error",
					error: (failure ?? "no response").slice(0, ERROR_TEXT_LIMIT),
					...(message ? { usage: message.usage } : {}),
				});
				stop();
				return;
			}
			record(current, { outcome: "warmed", usage: message.usage, expectedSavings: economics.expectedSavings });
			if (showNotices(pi)) current.ctx.ui.notify(`Cache kept warm: $${message.usage.cost.total.toFixed(3)}`, "info");
			schedule(current, startedAt + current.delayMs);
		}

		function arm(ctx: ExtensionContext): void {
			stop();
			const captured = capture;
			const model = ctx.model as AnyModel | undefined;
			if (!captured || !ctx.hasUI || !model || cacheWarmingMode(pi) !== "streaming") return;
			if (model.provider !== captured.provider || model.id !== captured.modelId || model.api !== "anthropic-messages") return;
			if (!isReplayablePayload(captured.payload, model.id)) return;
			const ttlMs = promptCacheTtlMs(model);
			const delayMs = ttlMs === undefined ? undefined : refreshDelayMs(ttlMs);
			if (ttlMs === undefined || delayMs === undefined) return;
			const current: Run = { capture: captured, ctx, model, ttlMs, delayMs, deadlineAt: 0 };
			run = current;
			schedule(current, captured.sentAt + delayMs);
		}

		pi.on("before_provider_request", (event, ctx) => {
			const payload = event.payload;
			// Pi's own in-run warmer replays through this hook with a one-token response.
			if (!isRecord(payload) || payload.max_tokens === 1) return undefined;
			stop();
			const model = ctx.model;
			capture = model
				? { payload, provider: model.provider, modelId: model.id, sentAt: clock.now() }
				: undefined;
			return undefined;
		});

		pi.on("agent_settled", (_event, ctx) => arm(ctx));

		pi.on("input", () => reset());
		pi.on("agent_start", () => reset());
		pi.on("model_select", () => reset());
		pi.on("thinking_level_select", () => reset());
		pi.on("session_compact", () => reset());
		pi.on("session_tree", () => reset());
		pi.on("session_start", () => reset());
		pi.on("session_shutdown", () => reset());
	};
}

export default createCacheKeepalive();
