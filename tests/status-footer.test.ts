import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import statusFooter, {
	collectUsageTotals,
	formatTokens,
	formatWorkdir,
	isUsingSubscription,
	parseMcpCounts,
	renderFooterLines,
} from "../extensions/status-footer/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
type FooterFactory = (
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Component & { dispose?(): void };

class FakePi {
	readonly handlers = new Map<string, Handler>();
	readonly eventHandlers = new Map<string, (data: unknown) => void>();
	readonly events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			this.eventHandlers.set(channel, handler);
			return () => this.eventHandlers.delete(channel);
		},
		emit: (channel: string, data: unknown) => {
			this.eventHandlers.get(channel)?.(data);
		},
	};

	on(name: string, handler: Handler): void {
		this.handlers.set(name, handler);
	}
}

function context(mode: ExtensionContext["mode"]): {
	ctx: ExtensionContext;
	getFooterFactory: () => FooterFactory | undefined;
} {
	let footerFactory: FooterFactory | undefined;
	const ctx = {
		cwd: "/workspace/project",
		hasUI: mode === "tui",
		mode,
		model: {
			id: "grok-4.6",
			name: "Grok 4.6",
			provider: "xai",
			contextWindow: 500_000,
			reasoning: true,
		},
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 229_000, contextWindow: 500_000, percent: 45.9 }),
		modelRegistry: {
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
			isUsingOAuth: () => true,
		},
		sessionManager: {
			getCwd: () => "/tmp/later",
			getHeader: () => ({ cwd: "/workspace/project" }),
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: 421_000,
							output: 43_000,
							cacheRead: 8_600_000,
							cacheWrite: 0,
							cost: { total: 5.378 },
						},
					},
				},
			],
			getSessionId: () => "01a08555-9ee8-72b3-9af1-481c7d4b58e1",
			getSessionName: () => undefined,
		},
		ui: {
			setFooter: (factory: FooterFactory | undefined) => {
				footerFactory = factory;
			},
		},
	} as unknown as ExtensionContext;

	return { ctx, getFooterFactory: () => footerFactory };
}

async function invoke(
	pi: FakePi,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<unknown> {
	const handler = pi.handlers.get(eventName);
	if (!handler) throw new Error(`missing handler ${eventName}`);
	return handler(event, ctx);
}

const identityTheme = {
	fg: (_tone: string, text: string) => text,
} as unknown as Theme;

const footerData = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map([["mode", "fast-gpt"]]),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
} satisfies ReadonlyFooterDataProvider;

function branchFooterData(current: () => string | null): {
	provider: ReadonlyFooterDataProvider;
	emitBranchChange: () => void;
} {
	const callbacks = new Set<() => void>();
	return {
		provider: {
			getGitBranch: current,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: (callback: () => void) => {
				callbacks.add(callback);
				return () => callbacks.delete(callback);
			},
		} satisfies ReadonlyFooterDataProvider,
		emitBranchChange: () => {
			// Snapshot first: a callback may unsubscribe while it runs.
			for (const callback of [...callbacks]) callback();
		},
	};
}

const tui = {
	requestRender: () => {},
} as unknown as TUI;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formats token counts with k and M compact units", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_200), "1.2k");
	assert.equal(formatTokens(50_000), "50k");
	assert.equal(formatTokens(3_300_000), "3.3M");
});

test("abbreviates a home-relative original workdir", () => {
	assert.equal(formatWorkdir("/home/csheng/workspace/pi-extensions", "/home/csheng"), "~/workspace/pi-extensions");
	assert.equal(formatWorkdir("/workspace/project", "/home/csheng"), "/workspace/project");
});

test("sums session usage and takes cache hit from the latest assistant prompt", () => {
	const usage = collectUsageTotals([
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 400,
					cacheWrite: 0,
					cost: { total: 0.1 },
				},
			},
		},
		{
			type: "compaction",
			usage: {
				input: 10,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 50,
					output: 5,
					cacheRead: 950,
					cacheWrite: 0,
					cost: { total: 0.02 },
				},
			},
		},
	]);

	assert.equal(usage.input, 160);
	assert.equal(usage.output, 29);
	assert.equal(usage.cacheRead, 1_350);
	assert.equal(usage.cost, 0.13);
	assert.equal(usage.cacheHitPercent?.toFixed(1), "95.0");
});

test("counts enabled MCP servers from an adapter snapshot", () => {
	assert.deepEqual(
		parseMcpCounts({
			servers: [{ disabled: false }, { disabled: true }, { name: "ok" }],
		}),
		{ enabled: 2, all: 3 },
	);
});

test("renders one compact footer line without extension statuses", () => {
	const lines = renderFooterLines(
		{
			modelName: "Grok 4.6",
			thinkingLevel: "high",
			reasoning: true,
			provider: "xai",
			usingSubscription: true,
			workdir: "/workspace/project",
			gitBranch: "main",
			mcp: { enabled: 2, all: 2 },
			contextTokens: 229_000,
			contextWindow: 500_000,
			contextPercent: 45.9,
			sessionId: "01a08555-9ee8-72b3-9af1-481c7d4b58e1",
			usage: {
				input: 952_000,
				output: 62_000,
				cacheRead: 13_000_000,
				cacheWrite: 0,
				cost: 8.979,
				cacheHitPercent: 99.7,
			},
		},
		200,
		identityTheme,
	);

	assert.equal(lines.length, 1);
	assert.equal(
		stripAnsi(lines[0] ?? ""),
		"Grok 4.6 high (xai sub) | /workspace/project (main) | 01a08555-9ee8-72b3-9af1-481c7d4b58e1 | ↑952k ↓62k R13M CH99.7% $8.979 | 229k/500k (45.9%) | MCP 2/2",
	);
});

test("places a lightning mark after thinking when fast-gpt is requested", () => {
	const withThinking = renderFooterLines(
		{
			modelName: "GPT-5.4",
			thinkingLevel: "high",
			reasoning: true,
			fastGpt: true,
			provider: "openai",
			usingSubscription: true,
			workdir: "/workspace/project",
			gitBranch: null,
			mcp: undefined,
			contextTokens: 12_000,
			contextWindow: 200_000,
			contextPercent: 6.0,
			sessionId: "01a08555-9ee8-72b3-9af1-481c7d4b58e1",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.01,
				cacheHitPercent: undefined,
			},
		},
		200,
		identityTheme,
	);
	assert.equal(
		stripAnsi(withThinking[0] ?? ""),
		"GPT-5.4 high \u26A1 (openai sub) | /workspace/project | 01a08555-9ee8-72b3-9af1-481c7d4b58e1 | \u2191100 \u219320 $0.010 | 12k/200k (6.0%)",
	);

	const withoutThinking = renderFooterLines(
		{
			modelName: "GPT-5.4",
			thinkingLevel: "off",
			reasoning: false,
			fastGpt: true,
			provider: "openai",
			usingSubscription: false,
			workdir: "/workspace/project",
			gitBranch: null,
			mcp: undefined,
			contextTokens: 12_000,
			contextWindow: 200_000,
			contextPercent: 6.0,
			sessionId: "01a08555-9ee8-72b3-9af1-481c7d4b58e1",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.01,
				cacheHitPercent: undefined,
			},
		},
		200,
		identityTheme,
	);
	assert.match(stripAnsi(withoutThinking[0] ?? ""), /^GPT-5\.4 \u26A1 \|/);
});

test("wraps field by field when a single line cannot fit", () => {
	const input = {
		modelName: "Grok 4.6",
		thinkingLevel: "high",
		reasoning: true,
		provider: "xai",
		usingSubscription: true,
		workdir: "/workspace/project",
		gitBranch: "main",
		mcp: { enabled: 2, all: 2 },
		contextTokens: 229_000,
		contextWindow: 500_000,
		contextPercent: 45.9,
		sessionId: "01a08555-9ee8-72b3-9af1-481c7d4b58e1",
		usage: {
			input: 952_000,
			output: 62_000,
			cacheRead: 13_000_000,
			cacheWrite: 0,
			cost: 8.979,
			cacheHitPercent: 99.7,
		},
	};

	const wide = renderFooterLines(input, 200, identityTheme);
	assert.equal(wide.length, 1);

	const wrapped = renderFooterLines(input, 100, identityTheme);
	assert.equal(wrapped.length, 2);
	const [row1 = "", row2 = ""] = wrapped.map((line) => stripAnsi(line));
	// The session id flows up into row 1's remaining whitespace (flat greedy fill).
	assert.equal(
		row1,
		"Grok 4.6 high (xai sub) | /workspace/project (main) | 01a08555-9ee8-72b3-9af1-481c7d4b58e1",
	);
	assert.equal(
		row2,
		"↑952k ↓62k R13M CH99.7% $8.979 | 229k/500k (45.9%) | MCP 2/2",
	);
	for (const line of wrapped) assert.ok(visibleWidth(line) <= 100);

	// Below that fit, the uuid wraps to its own row and metrics follow on the next.
	const shrunk = renderFooterLines(input, 88, identityTheme);
	assert.equal(shrunk.length, 3);
	for (const line of shrunk) assert.ok(visibleWidth(line) <= 88);
	assert.ok((stripAnsi(shrunk[1] ?? "")).includes("01a08555-9ee8-72b3-9af1-481c7d4b58e1"));
	assert.equal(stripAnsi(shrunk[2] ?? ""), "229k/500k (45.9%) | MCP 2/2");
});

test("keeps every field when wrapping into more rows on very narrow terminals", () => {
	const lines = renderFooterLines({
		modelName: "Grok 4.6",
		thinkingLevel: "high",
		reasoning: true,
		provider: "xai",
		usingSubscription: true,
		workdir: "/workspace/project",
		gitBranch: "main",
		mcp: { enabled: 2, all: 2 },
		contextTokens: 229_000,
		contextWindow: 500_000,
		contextPercent: 45.9,
		sessionId: "01a08555-9ee8-72b3-9af1-481c7d4b58e1",
		usage: {
			input: 952_000,
			output: 62_000,
			cacheRead: 13_000_000,
			cacheWrite: 0,
			cost: 8.979,
			cacheHitPercent: 99.7,
		},
	}, 60, identityTheme);
	assert.ok(lines.length >= 3);
	const all = lines.map((line) => stripAnsi(line)).join("\n");
	for (const part of [
		"Grok 4.6 high (xai sub)",
		"/workspace/project (main)",
		"01a08555-9ee8-72b3-9af1-481c7d4b58e1",
		"↑952k ↓62k R13M CH99.7% $8.979",
		"229k/500k (45.9%)",
		"MCP 2/2",
	]) {
		assert.ok(all.includes(part), part);
	}
	for (const line of lines) assert.ok(visibleWidth(line) <= 60);
});

test("classifies coding-plan api-key providers as subscriptions", () => {
	const ctx = {
		modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined },
	} as unknown as ExtensionContext;
	assert.equal(isUsingSubscription(ctx, { provider: "zai-coding-cn" } as ExtensionContext["model"]), true);
	assert.equal(isUsingSubscription(ctx, { provider: "kimi-coding" } as ExtensionContext["model"]), true);
	assert.equal(isUsingSubscription(ctx, { provider: "deepseek" } as ExtensionContext["model"]), false);
	// OAuth providers keep the registry-flag path.
	const oauthCtx = {
		modelRegistry: {
			isUsingOAuth: () => true,
			getProvider: (id: string) =>
				id === "openai-codex" ? { auth: { oauth: { isSubscription: true } } } : undefined,
		},
	} as unknown as ExtensionContext;
	assert.equal(isUsingSubscription(oauthCtx, { provider: "openai-codex" } as ExtensionContext["model"]), true);
	assert.equal(isUsingSubscription(oauthCtx, { provider: "shanqu" } as ExtensionContext["model"]), false);
});

test("actual footer preserves the UUID whenever it fits alone", () => {
	const sessionId = "01a08555-9ee8-72b3-9af1-481c7d4b58e1";
	for (const modelName of ["Grok 4.6", "long-model-name-".repeat(20)]) {
		for (const width of [0, 20, 36, 40, 60, 80, 120]) {
			const lines = renderFooterLines({
				modelName, thinkingLevel: "high", reasoning: true, provider: "xai", usingSubscription: true,
				workdir: "/workspace/project", gitBranch: "main", mcp: { enabled: 2, all: 2 }, sessionId,
				contextTokens: 229_000, contextWindow: 500_000, contextPercent: 45.9,
				usage: { input: 952_000, output: 62_000, cacheRead: 13_000_000, cacheWrite: 0, cost: 8.979, cacheHitPercent: 99.7 },
			}, width, identityTheme);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
			if (width >= sessionId.length) {
				const all = lines.map((line) => stripAnsi(line)).join("\n");
				assert.ok(all.includes(sessionId));
			}
		}
	}
});

test("shows the Pi-provided git branch and follows branch changes", async () => {
	const pi = new FakePi();
	statusFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("tui");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	const factory = getFooterFactory();
	assert.ok(factory);

	let branch: string | null = "main";
	const { provider, emitBranchChange } = branchFooterData(() => branch);
	let renders = 0;
	const countingTui = {
		requestRender: () => {
			renders += 1;
		},
	} as unknown as TUI;

	const footer = factory(countingTui, identityTheme, provider);
	assert.match(stripAnsi(footer.render(240)[0] ?? ""), /\| \/workspace\/project \(main\) \|/);

	branch = "feature/footer";
	emitBranchChange();
	assert.equal(renders, 1);
	assert.match(stripAnsi(footer.render(240)[0] ?? ""), /\(feature\/footer\)/);

	footer.dispose?.();
	emitBranchChange();
	assert.equal(renders, 1);
});

test("installs the compact footer in TUI mode and refreshes MCP counts", async () => {
	const pi = new FakePi();
	statusFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("tui");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	const factory = getFooterFactory();
	assert.ok(factory);

	const footer = factory(tui, identityTheme, footerData);
	const beforeMcp = footer.render(220);
	assert.equal(beforeMcp.length, 1);
	assert.equal(
		stripAnsi(beforeMcp[0] ?? ""),
		"Grok 4.6 high (xai sub) | /workspace/project | 01a08555-9ee8-72b3-9af1-481c7d4b58e1 | ↑421k ↓43k R8.6M CH95.3% $5.378 | 229k/500k (45.9%)",
	);

	pi.events.emit("pi-mcp-adapter/status/v1", {
		servers: [{ disabled: false }, { disabled: false }],
	});
	assert.equal(
		stripAnsi(footer.render(220)[0] ?? ""),
		"Grok 4.6 high (xai sub) | /workspace/project | 01a08555-9ee8-72b3-9af1-481c7d4b58e1 | ↑421k ↓43k R8.6M CH95.3% $5.378 | 229k/500k (45.9%) | MCP 2/2",
	);

	await invoke(pi, "thinking_level_select", { level: "medium" }, ctx);
	assert.match(footer.render(160)[0] ?? "", /medium/);
});

test("compacts the fast-gpt keyed status after thinking and ignores other statuses", async () => {
	const pi = new FakePi();
	statusFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("tui");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	const factory = getFooterFactory();
	assert.ok(factory);

	let statuses = new Map([["mode", "fast-gpt"]]);
	const provider = {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	} satisfies ReadonlyFooterDataProvider;

	const footer = factory(tui, identityTheme, provider);
	assert.equal(stripAnsi(footer.render(220)[0] ?? "").includes("\u26A1"), false);

	statuses = new Map([["fast-gpt", "fast-gpt"], ["plan-mode", "plan"]]);
	const line = stripAnsi(footer.render(220)[0] ?? "");
	assert.match(line, /Grok 4\.6 high \u26A1 \(xai sub\)/);
	assert.equal(line.includes("fast-gpt"), false);
	assert.equal(line.includes("plan-mode"), false);
	assert.equal(line.includes("plan"), false);
});

test("does not install a custom footer outside TUI mode", async () => {
	const pi = new FakePi();
	statusFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("rpc");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	assert.equal(getFooterFactory(), undefined);
});
