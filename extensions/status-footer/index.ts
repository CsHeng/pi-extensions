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
	cost?: { total?: unknown };
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

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

export function pinRight(
	left: string,
	right: string,
	width: number,
	style: (text: string) => string = (text) => text,
): string {
	if (width <= 0) return "";
	const ellipsis = style("...");
	if (!left) return truncateToWidth(right, width, ellipsis);
	const sep = style(" | ");
	const rightWidth = visibleWidth(right);
	const sepWidth = visibleWidth(sep);
	if (rightWidth >= width) return truncateToWidth(right, width, ellipsis);
	if (sepWidth + rightWidth >= width) return truncateToWidth(right, width, ellipsis);
	return truncateToWidth(left, width - sepWidth - rightWidth, ellipsis) + sep + right;
}

export function addSessionIdToFooterLine(
	line: string,
	sessionId: string,
	width: number,
	style: (text: string) => string = (text) => text,
): string {
	return pinRight(line, sessionId, width, style);
}

export function collectUsageTotals(entries: readonly unknown[]): UsageSnapshot {
	const usage: UsageSnapshot = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		cacheHitPercent: undefined,
	};

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as {
			type?: unknown;
			usage?: UsageFields;
			message?: { role?: unknown; usage?: UsageFields };
		};

		let fields: UsageFields | undefined;
		if (record.type === "message" && record.message?.role === "assistant") {
			fields = record.message.usage;
			if (fields) {
				const promptTokens =
					numberOrZero(fields.input) +
					numberOrZero(fields.cacheRead) +
					numberOrZero(fields.cacheWrite);
				usage.cacheHitPercent =
					promptTokens > 0 ? (numberOrZero(fields.cacheRead) / promptTokens) * 100 : undefined;
			}
		} else if (record.type === "message" && record.message?.role === "toolResult") {
			fields = record.message.usage;
		} else if (record.type === "branch_summary" || record.type === "compaction") {
			fields = record.usage;
		}

		if (!fields) continue;
		usage.input += numberOrZero(fields.input);
		usage.output += numberOrZero(fields.output);
		usage.cacheRead += numberOrZero(fields.cacheRead);
		usage.cacheWrite += numberOrZero(fields.cacheWrite);
		usage.cost += numberOrZero(fields.cost?.total);
	}

	return usage;
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

function formatTrafficParts(input: FooterRenderInput): string {
	const parts: string[] = [];
	if (input.usage.input) parts.push(hexFg(POWERLINE.input, `↑${formatTokens(input.usage.input)}`));
	if (input.usage.output) parts.push(hexFg(POWERLINE.output, `↓${formatTokens(input.usage.output)}`));
	if (input.usage.cacheRead) parts.push(hexFg(POWERLINE.cacheRead, `R${formatTokens(input.usage.cacheRead)}`));
	if (input.usage.cacheWrite) parts.push(hexFg(POWERLINE.cacheWrite, `W${formatTokens(input.usage.cacheWrite)}`));
	if (
		(input.usage.cacheRead > 0 || input.usage.cacheWrite > 0) &&
		input.usage.cacheHitPercent !== undefined
	) {
		parts.push(hexFg(cacheHitColor(input.usage.cacheHitPercent), `CH${input.usage.cacheHitPercent.toFixed(1)}%`));
	}
	if (input.usage.cost) parts.push(hexFg(POWERLINE.cost, `$${input.usage.cost.toFixed(3)}`));
	return parts.join(" ");
}

function packSegments(
	segments: Array<{ text: string; shrink?: boolean; preserve?: boolean }>,
	width: number,
	theme: ThemeLike,
): string {
	const sep = theme.fg("dim", " | ");
	const ellipsis = theme.fg("dim", "...");
	const present = segments.filter((segment) => segment.text);
	const joined = () => present.map((segment) => segment.text).join(sep);
	if (visibleWidth(joined()) <= width) return joined();

	// Shrink workdir/traffic first, then other optional segments, never the UUID.
	for (const segment of [...present.filter((item) => item.shrink), ...present.filter((item) => !item.shrink && !item.preserve)]) {
		const others = present
			.filter((candidate) => candidate !== segment)
			.reduce((total, candidate) => total + visibleWidth(candidate.text), 0);
		const separators = visibleWidth(sep) * Math.max(0, present.length - 1);
		const budget = width - others - separators;
		if (budget < 4) {
			const index = present.indexOf(segment);
			if (index >= 0) present.splice(index, 1);
		} else {
			segment.text = truncateToWidth(segment.text, budget, ellipsis);
		}
		if (visibleWidth(joined()) <= width) return joined();
	}

	return truncateToWidth(joined(), width, ellipsis);
}

function buildSegments(
	input: FooterRenderInput,
	theme: ThemeLike,
): Array<{ text: string; shrink?: boolean; preserve?: boolean }> {
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
			shrink: true,
		},
		{ text: hexFg(POWERLINE.session, input.sessionId), preserve: true },
		{ text: formatTrafficParts(input), shrink: true },
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
	if (visibleWidth(joined) <= width) return [packSegments(segments, width, theme)];

	// Too narrow for one line: wrap into two semantic rows instead of dropping
	// fields. Row 1 keeps identity and location; row 2 keeps the session id and metrics.
	return [
		packSegments(segments.slice(0, 2), width, theme),
		packSegments(segments.slice(2), width, theme),
	];
}

function modelName(model: ExtensionContext["model"]): string {
	if (!model) return "no-model";
	if (typeof model.name === "string" && model.name.trim()) return model.name;
	return model.id;
}

function isUsingSubscription(ctx: ExtensionContext, model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
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
	const usage = collectUsageTotals(ctx.sessionManager.getEntries());
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
