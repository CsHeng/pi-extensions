import assert from "node:assert/strict";
import test from "node:test";

import {
	initTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import sessionIdFooter, {
	addSessionIdToFooterLine,
} from "../extensions/session-id-footer/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
type FooterFactory = (
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Component;

class FakePi {
	readonly handlers = new Map<string, Handler>();

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
		cwd: "/workspace",
		hasUI: mode === "tui",
		mode,
		model: {
			id: "test-model",
			provider: "test-provider",
			contextWindow: 100_000,
			reasoning: true,
		},
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
		modelRegistry: {
			getProvider: () => undefined,
			isUsingOAuth: () => false,
		},
		sessionManager: {
			getCwd: () => "/workspace",
			getEntries: () => [],
			getSessionId: () => "01a0672f-5b80-714b-bcd3-e5367125d9a4",
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

test("adds the complete session id to the first built-in footer line", async () => {
	const pi = new FakePi();
	sessionIdFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("tui");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	const factory = getFooterFactory();
	assert.ok(factory);

	initTheme("dark", false);
	const footer = factory(tui, identityTheme, footerData);
	const lines = footer.render(120);
	assert.equal(
		stripAnsi(lines[0] ?? ""),
		"/workspace • session: 01a0672f-5b80-714b-bcd3-e5367125d9a4",
	);
	assert.equal(stripAnsi(lines[2] ?? ""), "fast-gpt");

	await invoke(pi, "model_select", {
		model: {
			id: "next-model",
			provider: "test-provider",
			contextWindow: 100_000,
			reasoning: true,
		},
	}, ctx);
	const updatedLines = footer.render(120);
	assert.match(stripAnsi(updatedLines[1] ?? ""), /next-model • high$/);
});

test("keeps the session id visible when the original line needs truncation", () => {
	const result = addSessionIdToFooterLine(
		"/a/very/long/project/path",
		"12345678",
		24,
	);

	assert.equal(stripAnsi(result), "/... • session: 12345678");
});

test("does not install a custom footer outside TUI mode", async () => {
	const pi = new FakePi();
	sessionIdFooter(pi as unknown as ExtensionAPI);
	const { ctx, getFooterFactory } = context("rpc");

	await invoke(pi, "session_start", { reason: "startup" }, ctx);
	assert.equal(getFooterFactory(), undefined);
});
