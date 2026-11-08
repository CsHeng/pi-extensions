import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	CACHE_KEEPALIVE_ENTRY_TYPE,
	createCacheKeepalive,
	refreshDelayMs,
	refreshEconomics,
	type KeepaliveClock,
} from "../extensions/cache-keepalive/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

class ManualClock implements KeepaliveClock {
	time = 0;
	private timers = new Map<number, { at: number; callback: () => void }>();
	private nextId = 1;

	now(): number { return this.time; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	get pending(): number { return this.timers.size; }

	/** Advance to `target`, firing due timers at their scheduled time. */
	async advanceTo(target: number): Promise<void> {
		for (;;) {
			const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.time = Math.max(this.time, due[1].at);
			due[1].callback();
			await flush();
		}
		this.time = Math.max(this.time, target);
	}

	/** Jump time without firing, then fire whatever is due late (a suspended process). */
	async jumpTo(target: number): Promise<void> {
		this.time = target;
		const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target);
		for (const [id, timer] of due) {
			this.timers.delete(id);
			timer.callback();
			await flush();
		}
	}
}

async function flush(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

interface StreamCall { options: Record<string, any> }

class FakePi {
	readonly handlers = new Map<string, Handler>();
	readonly entries: Array<{ customType: string; data: any }> = [];
	settings: Record<string, unknown> = { cacheWarming: "streaming" };

	on(name: string, handler: Handler): void { this.handlers.set(name, handler); }
	appendEntry(customType: string, data: unknown): void { this.entries.push({ customType, data }); }
	getSettings(): Record<string, unknown> { return { ...this.settings }; }
	registerTool(): never { throw new Error("cache-keepalive must not register model-facing tools"); }
	sendMessage(): never { throw new Error("cache-keepalive must not add context messages"); }
}

const MODEL = {
	provider: "jtc",
	id: "claude-test",
	api: "anthropic-messages",
	promptCache: { short: 300 },
	cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

function usage(cacheRead: number, cacheWrite = 0) {
	return { input: 2, output: 1, cacheRead, cacheWrite, totalTokens: cacheRead + cacheWrite + 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cacheRead * 0.25e-6 } };
}

interface Harness {
	pi: FakePi;
	clock: ManualClock;
	ctx: ExtensionContext;
	calls: StreamCall[];
	notices: string[];
	setResult(result: () => Promise<any>): void;
	emit(name: string, event?: unknown): unknown;
}

function harness(overrides: { model?: Record<string, unknown>; hasUI?: boolean; promptTokens?: number } = {}): Harness {
	const pi = new FakePi();
	const clock = new ManualClock();
	const calls: StreamCall[] = [];
	const notices: string[] = [];
	let result: () => Promise<any> = async () => ({ stopReason: "length", usage: usage(overrides.promptTokens ?? 400_000) });
	const model = { ...MODEL, ...overrides.model };
	const promptTokens = overrides.promptTokens ?? 400_000;
	const ctx = {
		hasUI: overrides.hasUI ?? true,
		mode: overrides.hasUI === false ? "json" : "tui",
		model,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [{ type: "message", message: { role: "assistant", usage: usage(promptTokens - 1_000, 1_000) } }],
		},
		modelRegistry: {
			streamSimple: (_model: unknown, _context: unknown, options: Record<string, any>) => {
				calls.push({ options });
				return { result: () => result() };
			},
		},
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
	createCacheKeepalive(clock)(pi as unknown as ExtensionAPI);
	return {
		pi, clock, ctx, calls, notices,
		setResult: next => { result = next; },
		emit: (name, event = {}) => {
			const handler = pi.handlers.get(name);
			if (!handler) throw new Error(`missing handler ${name}`);
			return handler(event, ctx);
		},
	};
}

function payload(extra: Record<string, unknown> = {}) {
	return { model: MODEL.id, max_tokens: 64_000, stream: true, system: [{ type: "text", text: "system" }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" }, ...extra };
}

async function settleAfterRequest(h: Harness, body: Record<string, unknown> = payload()): Promise<void> {
	h.emit("agent_start");
	const replaced = h.emit("before_provider_request", { payload: body });
	assert.equal(replaced, undefined, "real requests must not be rewritten");
	h.clock.time = 60_000;
	h.emit("agent_settled", { aborted: false });
}

test("refresh delay and economics match Pi's idle warmer", () => {
	assert.equal(refreshDelayMs(300_000), 270_000);
	assert.equal(refreshDelayMs(3_600_000), 3_240_000);
	assert.equal(refreshDelayMs(10_000), undefined);
	assert.equal(refreshEconomics(MODEL as never, 400_000).warm, true);
	assert.equal(refreshEconomics(MODEL as never, 5_000).warm, false);
	assert.equal(refreshEconomics(MODEL as never, 0).warm, false);
});

test("an idle session replays the last payload with one output token on Pi's schedule", async () => {
	const h = harness();
	const body = payload();
	const original = structuredClone(body);
	await settleAfterRequest(h, body);

	await h.clock.advanceTo(269_999);
	assert.equal(h.calls.length, 0);
	await h.clock.advanceTo(270_000);
	assert.equal(h.calls.length, 1);

	const options = h.calls[0]!.options;
	assert.equal(options.maxRetries, 0);
	assert.equal(options.sessionId, "session-1");
	assert.deepEqual(options.onPayload({ unrelated: true }), { ...original, max_tokens: 1 });
	assert.deepEqual(body, original, "the captured payload is not mutated");

	assert.equal(h.pi.entries.length, 1);
	assert.equal(h.pi.entries[0]!.customType, CACHE_KEEPALIVE_ENTRY_TYPE);
	assert.equal(h.pi.entries[0]!.data.outcome, "warmed");
	assert.equal(h.pi.entries[0]!.data.usage.cacheRead, 400_000);

	await h.clock.advanceTo(540_000);
	assert.equal(h.calls.length, 2);
});

test("warming ends 30 minutes after the last real request", async () => {
	const h = harness();
	await settleAfterRequest(h);
	await h.clock.advanceTo(2 * 60 * 60_000);
	assert.equal(h.calls.length, 6, "refreshes at 270 s steps up to 1620 s; 1890 s exceeds the limit");
	assert.equal(h.clock.pending, 0);
});

test("the extension stands down unless cacheWarming is streaming", async () => {
	for (const mode of ["idle", "off"]) {
		const h = harness();
		h.pi.settings = { cacheWarming: mode };
		await settleAfterRequest(h);
		await h.clock.advanceTo(600_000);
		assert.equal(h.calls.length, 0, mode);
	}
	const unset = harness();
	unset.pi.settings = {};
	await settleAfterRequest(unset);
	await unset.clock.advanceTo(270_000);
	assert.equal(unset.calls.length, 1, "Pi's default is streaming");

	const switched = harness();
	await settleAfterRequest(switched);
	switched.pi.settings = { cacheWarming: "idle" };
	await switched.clock.advanceTo(600_000);
	assert.equal(switched.calls.length, 0, "a switch back to the official warmer applies to a pending refresh");
});

test("headless sessions and ineligible requests are not warmed", async () => {
	const cases: Array<[string, Parameters<typeof harness>[0], Record<string, unknown>?]> = [
		["print/JSON mode", { hasUI: false }],
		["non-Anthropic API", { model: { api: "openai-responses" } }],
		["no declared cache lifetime", { model: { promptCache: undefined } }],
		["small prompt fails the economics", { promptTokens: 5_000 }],
		["fixed thinking budget", {}, { thinking: { type: "enabled", budget_tokens: 4_096 } }],
		["payload for another model", {}, { model: "other-model" }],
	];
	for (const [name, options, extra] of cases) {
		const h = harness(options);
		await settleAfterRequest(h, payload(extra));
		await h.clock.advanceTo(600_000);
		assert.equal(h.calls.length, 0, name);
		assert.equal(h.pi.entries.length, 0, name);
	}
});

test("user activity and context changes cancel a pending refresh", async () => {
	for (const event of ["input", "agent_start", "model_select", "thinking_level_select", "session_compact", "session_tree", "session_start", "session_shutdown"]) {
		const h = harness();
		await settleAfterRequest(h);
		h.emit(event);
		await h.clock.advanceTo(600_000);
		assert.equal(h.calls.length, 0, event);
	}
});

test("Pi's own one-token replays are not captured as requests", async () => {
	const h = harness();
	h.emit("agent_start");
	h.emit("before_provider_request", { payload: payload({ max_tokens: 1 }) });
	h.emit("agent_settled", { aborted: false });
	await h.clock.advanceTo(600_000);
	assert.equal(h.calls.length, 0);
});

test("a failed refresh is recorded once and not retried", async () => {
	const h = harness();
	h.setResult(async () => ({ stopReason: "error", errorMessage: "overloaded", usage: usage(0) }));
	await settleAfterRequest(h);
	await h.clock.advanceTo(2 * 60 * 60_000);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.pi.entries.map(entry => entry.data.outcome), ["error"]);
	assert.equal(h.pi.entries[0]!.data.error, "overloaded");
	assert.equal(h.pi.entries[0]!.data.usage.cacheRead, 0, "billed usage of a failed refresh is still recorded");
});

test("a late timer stops instead of rebuilding an expired cache", async () => {
	const h = harness();
	await settleAfterRequest(h);
	await h.clock.jumpTo(300_000);
	assert.equal(h.calls.length, 0);
	assert.equal(h.clock.pending, 0);
});

test("input during an in-flight refresh aborts it without recording", async () => {
	const h = harness();
	let resolve!: (value: unknown) => void;
	h.setResult(() => new Promise(next => { resolve = next; }));
	await settleAfterRequest(h);
	await h.clock.advanceTo(270_000);
	assert.equal(h.calls.length, 1);
	h.emit("input", { text: "next", source: "interactive" });
	assert.equal(h.calls[0]!.options.signal.aborted, true);
	resolve({ stopReason: "aborted", usage: usage(0) });
	await flush();
	assert.equal(h.pi.entries.length, 0);
	assert.equal(h.clock.pending, 0);
});

test("notices follow Pi's showCacheMissNotices setting", async () => {
	const quiet = harness();
	await settleAfterRequest(quiet);
	await quiet.clock.advanceTo(270_000);
	assert.deepEqual(quiet.notices, []);

	const loud = harness();
	loud.pi.settings = { cacheWarming: "streaming", showCacheMissNotices: true };
	await settleAfterRequest(loud);
	await loud.clock.advanceTo(270_000);
	assert.equal(loud.notices.length, 1);
	assert.match(loud.notices[0]!, /^Cache kept warm: \$/);
});
