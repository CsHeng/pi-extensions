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
	/** Session-lane aggregate over every session entry. */
	usage: LaneTotals;
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

export { formatTokens } from "../shared/usage-format.ts";
import { formatTokens } from "../shared/usage-format.ts";
import {
	collectLaneTotals,
	timingMetricFields,
	usageMetricFields,
	type LaneTotals,
	type MetricField,
} from "../shared/usage-metrics.ts";

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

/** Session-lane usage fields, colored per field; `RB` reproduces Pi's /session "Cache Re-billed". */
function fieldColor(field: MetricField): string {
	switch (field.key) {
		case "input":
			return POWERLINE.input;
		case "output":
			return POWERLINE.output;
		case "cacheRead":
			return POWERLINE.cacheRead;
		case "cacheWrite":
			return POWERLINE.cacheWrite;
		case "cacheHit":
			return cacheHitColor(field.percent ?? 0);
		case "cost":
			return POWERLINE.cost;
		default:
			return POWERLINE.subscription;
	}
}

function formatUsageSegment(usage: LaneTotals): string {
	return usageMetricFields(usage).map((field) => hexFg(fieldColor(field), field.text)).join(" ");
}

/** `✻ TTFT tok/s` over the session; absent fields (no timing entries, no eligible request) are omitted. */
function formatTimingSegment(usage: LaneTotals, theme: ThemeLike): string {
	const text = timingMetricFields(usage).map((field) => field.text).join(" ");
	return text ? theme.fg("muted", text) : "";
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
		{ text: formatUsageSegment(input.usage) },
		{ text: formatTimingSegment(input.usage, theme) },
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
	// A pure function of persisted entries: a request enters only through its persisted assistant message.
	const usage = collectLaneTotals(ctx.sessionManager.getEntries(), { models: ctx.modelRegistry });
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
