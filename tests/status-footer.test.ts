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
	addSessionIdToFooterLine,
	collectUsageTotals,
	formatTokens,
	formatWorkdir,
	parseMcpCounts,
	renderFooterLines,
} from "../extensions/status-footer/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
type FooterFactory = (
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Component;

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

test("keeps the session id visible when the original line needs truncation", () => {
	const result = addSessionIdToFooterLine(
		"↑421k ↓43k R8.6M CH99.9% $5.378 | 229k/500k (45.9%)",
		"12345678",
		28,
	);

	assert.equal(stripAnsi(result), "↑421k ↓43k R8.... | 12345678");
	assert.ok(visibleWidth(result) <= 28);
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
		"Grok 4.6 high (xai sub) | /workspace/project | 01a08555-9ee8-72b3-9af1-481c7d4b58e1 | ↑952k ↓62k R13M CH99.7% $8.979 | 229k/500k (45.9%) | MCP 2/2",
	);
});

test("actual footer preserves the UUID whenever it fits alone", () => {
	const sessionId = "01a08555-9ee8-72b3-9af1-481c7d4b58e1";
	for (const modelName of ["Grok 4.6", "long-model-name-".repeat(20)]) {
		for (const width of [0, 20, 36, 40, 60, 80, 120]) {
			const [line = ""] = renderFooterLines({
				modelName, thinkingLevel: "high", reasoning: true, provider: "xai", usingSubscription: true,
				workdir: "/workspace/project", mcp: { enabled: 2, all: 2 }, sessionId,
				contextTokens: 229_000, contextWindow: 500_000, contextPercent: 45.9,
				usage: { input: 952_000, output: 62_000, cacheRead: 13_000_000, cacheWrite: 0, cost: 8.979, cacheHitPercent: 99.7 },
			}, width, identityTheme);
			assert.ok(visibleWidth(line) <= width);
			if (width >= sessionId.length) assert.ok(stripAnsi(line).includes(sessionId));
		}
	}
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

test("does not install a custom footer outside TUI mode", async () => {
	const pi = new FakePi();
	statusFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("rpc");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	assert.equal(getFooterFactory(), undefined);
});
