import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const FAST_GPT_STATUS_KEY = "fast-gpt";
const FAST_GPT_MARK = "\u26A1";

interface FooterState {
	model: ExtensionContext["model"];
	thinkingLevel: ExtensionContext["thinkingLevel"];
}

interface ActiveFooter {
	state: FooterState;
	requestRender?: () => void;
}

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitPercent: number | undefined;
	/** Prompt-token-weighted cache-hit rate over every assistant prompt in the session. */
	sessionCacheHitPercent?: number | undefined;
	/** Pi's /session "Cache Re-billed": counted misses, re-billed prompt tokens, and extra dollars. */
	rebillCount?: number;
	rebillTokens?: number;
	rebillCost?: number;
}

export interface McpCounts {
	enabled: number;
	all: number;
}

export interface FooterRenderInput {
	modelName: string;
	thinkingLevel: string | undefined;
	reasoning: boolean;
	fastGpt?: boolean;
	provider: string | undefined;
	usingSubscription: boolean;
	workdir: string;
	gitBranch: string | null;
	mcp: McpCounts | undefined;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	sessionId: string;
	usage: UsageSnapshot;
}

type ThemeLike = Pick<Theme, "fg">;

const POWERLINE = {
	model: "#d787af",
	path: "#00afaf",
	branch: "#5fd7af",
	session: "#b281d6",
	subscription: "#febc38",
	output: "#febc38",
	cacheRead: "#178fb9",
	cacheWrite: "#b281d6",
	cacheHit: "#89d281",
	input: "#89d281",
	cost: "#e4c00f",
} as const;

const RAINBOW = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9"];

function hexToAnsi(hex: string): string {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function hexFg(hex: string, text: string): string {
	return `${hexToAnsi(hex)}${text}\x1b[39m`;
}

function rainbow(text: string): string {
	let result = "";
	let colorIndex = 0;
	for (const character of text) {
		if (character === " " || character === ":") {
			result += character;
			continue;
		}
		result += hexToAnsi(RAINBOW[colorIndex % RAINBOW.length]!) + character;
		colorIndex += 1;
	}
	return `${result}\x1b[39m`;
}

interface UsageFields {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
}

/** Cache-read price lookup ($/M tokens), satisfied by Pi's model registry. */
export interface CacheReadPriceSource {
	find(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export { formatTokens } from "../shared/usage-format.ts";
import { formatTokens, promptCacheHit } from "../shared/usage-format.ts";

export function formatWorkdir(cwd: string, home: string | undefined = homedir()): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function collectUsageTotals(entries: readonly unknown[], models?: CacheReadPriceSource): UsageSnapshot {
	const usage: UsageSnapshot = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		cacheHitPercent: undefined,
		sessionCacheHitPercent: undefined,
	};
	let promptInput = 0;
	let promptCacheRead = 0;
	let promptCacheWrite = 0;
	const rebill: RebillTotals = { count: 0, tokens: 0, cost: 0 };
	// Previous effective request, mirroring Pi's cache-stats scan behind /session "Cache re-billed".
	let previous: { promptTokens: number; reportedCache: boolean } | undefined;

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as {
			type?: unknown;
			kind?: unknown;
			usage?: UsageFields;
			message?: { role?: unknown; provider?: unknown; model?: unknown; usage?: UsageFields };
		};

		let fields: UsageFields | undefined;
		if (record.type === "message" && record.message?.role === "assistant") {
			fields = record.message.usage;
			if (fields) {
				const input = numberOrZero(fields.input);
				const cacheRead = numberOrZero(fields.cacheRead);
				const cacheWrite = numberOrZero(fields.cacheWrite);
				usage.cacheHitPercent = promptCacheHit(input, cacheRead, cacheWrite);
				promptInput += input;
				promptCacheRead += cacheRead;
				promptCacheWrite += cacheWrite;
				previous = trackRebill(rebill, previous, fields, () => {
					const { provider, model } = record.message ?? {};
					if (!models || typeof provider !== "string" || typeof model !== "string") return 0;
					return numberOrZero(models.find(provider, model)?.cost.cacheRead) / 1_000_000;
				});
			}
		} else if (record.type === "message" && record.message?.role === "toolResult") {
			fields = record.message.usage;
		} else if (record.type === "branch_summary" || record.type === "compaction") {
			fields = record.usage;
			// The context legitimately changed; the next prompt is new content, not re-billed.
			previous = undefined;
		} else if (record.type === "usage" && record.kind === "cache_warm" && record.usage) {
			const promptTokens =
				numberOrZero(record.usage.input) + numberOrZero(record.usage.cacheRead) + numberOrZero(record.usage.cacheWrite);
			if (promptTokens > 0) previous = { promptTokens, reportedCache: true };
		}

		if (!fields) continue;
		usage.input += numberOrZero(fields.input);
		usage.output += numberOrZero(fields.output);
		usage.cacheRead += numberOrZero(fields.cacheRead);
		usage.cacheWrite += numberOrZero(fields.cacheWrite);
		usage.cost += numberOrZero(fields.cost?.total);
	}

	usage.sessionCacheHitPercent = promptCacheHit(promptInput, promptCacheRead, promptCacheWrite);
	usage.rebillCount = rebill.count;
	usage.rebillTokens = rebill.tokens;
	usage.rebillCost = rebill.cost;
	return usage;
}

/** Pi treats per-request misses at or below this as cache breakpoint granularity noise. */
const REBILL_NOISE_FLOOR_TOKENS = 1024;

interface RebillTotals {
	count: number;
	tokens: number;
	cost: number;
}

/**
 * One step of Pi's cache-miss detection (core/cache-stats, not a public export):
 * prompt tokens that were in the previous request's prompt but not read from cache,
 * priced at this request's paid rate minus its cache-read rate. Model switches count,
 * as in Pi. Returns the next previous-request state.
 */
function trackRebill(
	totals: RebillTotals,
	previous: { promptTokens: number; reportedCache: boolean } | undefined,
	fields: UsageFields,
	catalogReadPerToken: () => number,
): { promptTokens: number; reportedCache: boolean } | undefined {
	const input = numberOrZero(fields.input);
	const cacheRead = numberOrZero(fields.cacheRead);
	const cacheWrite = numberOrZero(fields.cacheWrite);
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return previous;
	const cacheActivity = cacheRead + cacheWrite > 0;
	if (previous && (cacheActivity || previous.reportedCache)) {
		const missed = Math.min(previous.promptTokens, promptTokens) - cacheRead;
		if (missed > REBILL_NOISE_FLOOR_TOKENS) {
			const paidTokens = input + cacheWrite;
			const paidPerToken =
				paidTokens > 0 ? (numberOrZero(fields.cost?.input) + numberOrZero(fields.cost?.cacheWrite)) / paidTokens : 0;
			const readPerToken = cacheRead > 0 ? numberOrZero(fields.cost?.cacheRead) / cacheRead : catalogReadPerToken();
			totals.count += 1;
			totals.tokens += missed;
			totals.cost += missed * Math.max(0, paidPerToken - readPerToken);
		}
	}
	return { promptTokens, reportedCache: (previous?.reportedCache ?? false) || cacheActivity };
}

export function parseMcpCounts(data: unknown): McpCounts | undefined {
	if (!data || typeof data !== "object") return undefined;
	const servers = (data as { servers?: unknown }).servers;
	if (!Array.isArray(servers)) return undefined;
	const all = servers.length;
	const enabled = servers.filter((server) => {
		if (!server || typeof server !== "object") return false;
		return (server as { disabled?: unknown }).disabled !== true;
	}).length;
	return { enabled, all };
}

function thinkingColor(level: string | undefined): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingOff";
	}
}

function contextColor(percent: number | null): ThemeColor {
	if (percent !== null && percent > 90) return "error";
	if (percent !== null && percent > 70) return "warning";
	return "success";
}

function mcpColor(mcp: McpCounts): ThemeColor {
	if (mcp.enabled === 0) return "error";
	if (mcp.enabled < mcp.all) return "warning";
	return "success";
}

function formatContextSegment(input: FooterRenderInput): string {
	const window = formatTokens(input.contextWindow);
	if (input.contextTokens === null || input.contextPercent === null) {
		return `?/${window}`;
	}
	return `${formatTokens(input.contextTokens)}/${window} (${input.contextPercent.toFixed(1)}%)`;
}

function cacheHitColor(percent: number): string {
	if (percent >= 80) return POWERLINE.cacheHit;
	if (percent >= 50) return POWERLINE.subscription;
	return "#ff5f5f";
}

/**
 * Cumulative re-bills after cost, matching Pi's /session "Cache Re-billed": count plus
 * extra dollars, or re-billed tokens when the dollar amount is below Pi's display floor.
 */
function formatRebill(usage: UsageSnapshot): string {
	const count = usage.rebillCount;
	if (count === undefined || (usage.cacheRead === 0 && usage.cacheWrite === 0)) return "";
	if (count === 0) return hexFg(POWERLINE.cacheHit, "RB0");
	const cost = usage.rebillCost ?? 0;
	const amount = cost >= 0.0001 ? `$${cost.toFixed(3)}` : formatTokens(usage.rebillTokens ?? 0);
	return hexFg(POWERLINE.subscription, `RB${count} ${amount}`);
}

function formatTrafficParts(input: FooterRenderInput): string {
	const parts: string[] = [];
	if (input.usage.input) parts.push(hexFg(POWERLINE.input, `↑${formatTokens(input.usage.input)}`));
	if (input.usage.output) parts.push(hexFg(POWERLINE.output, `↓${formatTokens(input.usage.output)}`));
	if (input.usage.cacheRead) parts.push(hexFg(POWERLINE.cacheRead, `R${formatTokens(input.usage.cacheRead)}`));
	if (input.usage.cacheWrite) parts.push(hexFg(POWERLINE.cacheWrite, `W${formatTokens(input.usage.cacheWrite)}`));
	const cacheActive = input.usage.cacheRead > 0 || input.usage.cacheWrite > 0;
	if (cacheActive && input.usage.cacheHitPercent !== undefined) {
		parts.push(hexFg(cacheHitColor(input.usage.cacheHitPercent), `CH${input.usage.cacheHitPercent.toFixed(1)}%`));
	}
	const sessionHit = input.usage.sessionCacheHitPercent;
	if (cacheActive && sessionHit !== undefined) {
		// x̄ = session mean, weighted by prompt tokens across all assistant prompts.
		parts.push(hexFg(cacheHitColor(sessionHit), `x\u0304${sessionHit.toFixed(1)}%`));
	}
	if (input.usage.cost) parts.push(hexFg(POWERLINE.cost, `$${input.usage.cost.toFixed(3)}`));
	const rebill = formatRebill(input.usage);
	if (rebill) parts.push(rebill);
	return parts.join(" ");
}

interface FooterSegment {
	text: string;
}

/**
 * Pack segments onto as many rows as needed. Segments are never dropped: a row
 * breaks before the first segment that no longer fits, and only a lone segment
 * wider than the whole row is truncated.
 */
function packRows(
	segments: FooterSegment[],
	width: number,
	theme: ThemeLike,
): string[] {
	const sep = theme.fg("dim", " | ");
	const ellipsis = theme.fg("dim", "...");
	const sepWidth = visibleWidth(sep);
	const rows: string[] = [];
	let row: string[] = [];
	let rowWidth = 0;
	for (const segment of segments) {
		if (!segment.text) continue;
		let text = segment.text;
		if (visibleWidth(text) > width) text = truncateToWidth(text, width, ellipsis);
		const textWidth = visibleWidth(text);
		if (row.length > 0 && rowWidth + sepWidth + textWidth > width) {
			rows.push(row.join(sep));
			row = [];
			rowWidth = 0;
		}
		row.push(text);
		rowWidth += (row.length > 1 ? sepWidth : 0) + textWidth;
	}
	if (row.length > 0) rows.push(row.join(sep));
	return rows;
}

function buildSegments(
	input: FooterRenderInput,
	theme: ThemeLike,
): FooterSegment[] {
	const model = hexFg(POWERLINE.model, input.modelName || "no-model");
	const thinkingLabel =
		input.reasoning && input.thinkingLevel && input.thinkingLevel !== "off"
			? input.thinkingLevel
			: "";
	const thinking =
		thinkingLabel && (thinkingLabel === "high" || thinkingLabel === "xhigh" || thinkingLabel === "max")
			? rainbow(thinkingLabel)
			: thinkingLabel
				? theme.fg(thinkingColor(thinkingLabel), thinkingLabel)
				: "";
	const subscription =
		input.usingSubscription
			? hexFg(POWERLINE.subscription, input.provider ? `(${input.provider} sub)` : "(sub)")
			: "";
	const fastGpt = input.fastGpt ? theme.fg("warning", FAST_GPT_MARK) : "";
	const identity = [model, thinking, fastGpt, subscription].filter(Boolean).join(" ");
	const mcpText =
		input.mcp && input.mcp.all > 0
			? theme.fg(mcpColor(input.mcp), `MCP ${input.mcp.enabled}/${input.mcp.all}`)
			: "";

	return [
		{ text: identity },
		{
			text:
				hexFg(POWERLINE.path, input.workdir) +
				(input.gitBranch ? ` ${hexFg(POWERLINE.branch, `(${input.gitBranch})`)}` : ""),
		},
		{ text: hexFg(POWERLINE.session, input.sessionId) },
		{ text: formatTrafficParts(input) },
		{ text: theme.fg(contextColor(input.contextPercent), formatContextSegment(input)) },
		{ text: mcpText },
	];
}

export function renderFooterLines(
	input: FooterRenderInput,
	width: number,
	theme: ThemeLike,
): string[] {
	if (width <= 0) return [""];

	const segments = buildSegments(input, theme);
	const sep = theme.fg("dim", " | ");
	const joined = segments
		.filter((segment) => segment.text)
		.map((segment) => segment.text)
		.join(sep);
	if (visibleWidth(joined) <= width) return [joined];

	// Too narrow for one line: wrap field by field — each field flows onto the
	// next row only when it no longer fits the remaining whitespace; no field
	// is ever dropped.
	return packRows(segments, width, theme);
}

function modelName(model: ExtensionContext["model"]): string {
	if (!model) return "no-model";
	if (typeof model.name === "string" && model.name.trim()) return model.name;
	return model.id;
}

/** Providers whose API keys are coding-plan subscriptions rather than metered billing. */
const API_KEY_SUBSCRIPTION_PROVIDERS = new Set(["kimi-coding", "zai-coding-cn"]);

export function isUsingSubscription(ctx: ExtensionContext, model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	if (API_KEY_SUBSCRIPTION_PROVIDERS.has(model.provider)) return true;
	if (!ctx.modelRegistry.isUsingOAuth(model)) return false;
	if (ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true) return true;
	// xAI browser/OAuth login is SuperGrok or X Premium even if a wrapped provider omits the flag.
	return model.provider === "xai";
}

function originalWorkdir(ctx: ExtensionContext): string {
	const header = ctx.sessionManager.getHeader?.();
	const cwd = header?.cwd || ctx.sessionManager.getCwd();
	return formatWorkdir(cwd);
}

function footerInput(
	ctx: ExtensionContext,
	state: FooterState,
	mcp: McpCounts | undefined,
	gitBranch: string | null,
	fastGpt: boolean,
): FooterRenderInput {
	const usage = collectUsageTotals(ctx.sessionManager.getEntries(), ctx.modelRegistry);
	const contextUsage = ctx.getContextUsage();
	return {
		modelName: modelName(state.model),
		thinkingLevel: state.thinkingLevel,
		reasoning: state.model?.reasoning === true,
		fastGpt,
		provider: state.model?.provider,
		usingSubscription: isUsingSubscription(ctx, state.model),
		workdir: originalWorkdir(ctx),
		gitBranch,
		mcp,
		contextTokens: contextUsage?.tokens ?? null,
		contextWindow: contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0,
		contextPercent: contextUsage?.percent ?? null,
		sessionId: ctx.sessionManager.getSessionId(),
		usage,
	};
}

export default function statusFooter(pi: ExtensionAPI): void {
	let activeFooter: ActiveFooter | undefined;
	let mcpCounts: McpCounts | undefined;

	pi.events.on(MCP_STATUS_EVENT, (data) => {
		mcpCounts = parseMcpCounts(data);
		activeFooter?.requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const active: ActiveFooter = {
			state: {
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel,
			},
		};
		activeFooter = active;

		ctx.ui.setFooter((tui, theme, footerData) => {
			active.requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			return {
				render(width: number): string[] {
					return renderFooterLines(
						footerInput(
							ctx,
							active.state,
							mcpCounts,
							footerData.getGitBranch(),
							footerData.getExtensionStatuses().has(FAST_GPT_STATUS_KEY),
						),
						width,
						theme,
					);
				},
				invalidate(): void {},
				dispose(): void {
					unsubscribeBranch();
					if (activeFooter === active) activeFooter = undefined;
				},
			};
		});
	});

	pi.on("model_select", (event) => {
		if (!activeFooter) return;
		activeFooter.state.model = event.model;
		activeFooter.requestRender?.();
	});

	pi.on("thinking_level_select", (event) => {
		if (!activeFooter) return;
		activeFooter.state.thinkingLevel = event.level;
		activeFooter.requestRender?.();
	});
}
