import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * Read-only cost and prompt-cache evaluator for persisted Pi sessions.
 *
 * It reconstructs Pi's own cache-waste metric (`Cache re-billed`) from session
 * usage, groups misses by rewrite and cache-stall signatures without proving
 * their cause, and values avoided context replays at the price the
 * owning request would have paid. It never writes session, settings, ledger, or
 * configuration files.
 */

export const REPORT_VERSION = 2;
export const DEFAULT_WINDOW_HOURS = 72;
export const DEFAULT_MISS_MIN_TOKENS = 1024;
export const DEFAULT_CALIBRATION = 1.3;
export const REBILL_CATEGORIES = ["packIsolated", "packRiding", "stall", "other"] as const;
export type RebillCategory = (typeof REBILL_CATEGORIES)[number];

export interface SessionCall {
	readonly ordinal: number;
	readonly ledgerRequest: number | null;
	readonly contextReset: boolean;
	readonly timestamp: string;
	readonly provider: string;
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costInput: number;
	readonly costCacheRead: number;
	readonly costCacheWrite: number;
	readonly costTotal: number;
}

export interface LedgerEvent {
	readonly event: "full" | "placeholder" | "recall";
	readonly id: string;
	readonly request: number | null;
	readonly removedTokens: number;
}

export interface ModelPrice {
	readonly input: number;
	readonly cacheRead: number;
}

export interface CategoryTotals {
	readonly misses: number;
	readonly tokens: number;
	readonly cost: number;
}

export interface SessionCostInput {
	readonly sessionId: string;
	readonly kind: "parent" | "child";
	readonly calls: readonly SessionCall[];
	readonly ledger: readonly LedgerEvent[];
}

export interface SessionCostSummary {
	readonly sessionId: string;
	readonly kind: "parent" | "child";
	readonly start: string;
	readonly calls: number;
	readonly codexCalls: number;
	readonly providers: readonly string[];
	readonly models: readonly string[];
	readonly cost: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheHitRate: number;
	readonly misses: number;
	readonly rebillTokens: number;
	readonly rebillCost: number;
	readonly byCategory: Readonly<Record<RebillCategory, CategoryTotals>>;
	readonly ledger: { readonly present: boolean; readonly packs: number; readonly replayTokens: number; readonly recalls: number };
	readonly savings: { readonly cacheReadBasis: number; readonly inputBasis: number };
	readonly net: { readonly strict: number; readonly full: number; readonly optimistic: number };
}

export interface CostTotals {
	readonly sessions: number;
	readonly calls: number;
	readonly codexCalls: number;
	readonly cost: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheHitRate: number;
	readonly misses: number;
	readonly rebillTokens: number;
	readonly rebillCost: number;
	readonly ledgerSessions: number;
	readonly packs: number;
	readonly replayTokens: number;
	readonly recalls: number;
	readonly savingsCacheReadBasis: number;
	readonly savingsInputBasis: number;
	readonly netStrict: number;
	readonly netFull: number;
	readonly netOptimistic: number;
	readonly packAttributableCost: number;
	readonly packAttributableCostStrict: number;
	readonly rebillCostShare: number;
	readonly savingsCostShare: number;
	readonly byCategory: Readonly<Record<RebillCategory, CategoryTotals>>;
}

interface MutableTotals {
	sessions: number; calls: number; codexCalls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheHitRate: number;
	misses: number; rebillTokens: number; rebillCost: number;
	ledgerSessions: number; packs: number; replayTokens: number; recalls: number;
	savingsCacheReadBasis: number; savingsInputBasis: number; netStrict: number; netFull: number; netOptimistic: number;
	packAttributableCost: number; packAttributableCostStrict: number; rebillCostShare: number; savingsCostShare: number;
	byCategory: Record<RebillCategory, CategoryTotals>;
}

export interface CostReport {
	readonly version: number;
	readonly window: { readonly from: string; readonly to: string; readonly hours: number };
	readonly sessions: readonly SessionCostSummary[];
	readonly totals: CostTotals;
	readonly notes: readonly string[];
}

const LEDGER_EVENTS = new Set(["full", "placeholder", "recall"]);
const PLACEHOLDER = "placeholder";

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function lines(text: string): string[] {
	return text.split("\n").filter((line) => line.trim().length > 0);
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		return objectValue(JSON.parse(line) as unknown);
	} catch {
		return undefined;
	}
}

/** All assistant usage; ledger numbering retains its non-empty-content convention. */
export function parseSessionText(text: string): SessionCall[] {
	const calls: SessionCall[] = [];
	let ledgerRequest = 0;
	let contextReset = false;
	for (const line of lines(text)) {
		const entry = parseLine(line);
		if (entry?.type === "compaction" || entry?.type === "branch_summary") {
			contextReset = true;
			continue;
		}
		if (!entry || entry.type !== "message") continue;
		const message = objectValue(entry.message);
		if (!message || message.role !== "assistant") continue;
		const content = message.content;
		const hasContent = Array.isArray(content) && content.length > 0;
		if (hasContent) ledgerRequest += 1;
		const usage = objectValue(message.usage) ?? {};
		const cost = objectValue(usage.cost) ?? {};
		calls.push({
			ordinal: calls.length + 1,
			ledgerRequest: hasContent ? ledgerRequest : null,
			contextReset,
			timestamp: textValue(entry.timestamp),
			provider: textValue(message.provider),
			model: textValue(message.model),
			input: nonNegative(usage.input),
			output: nonNegative(usage.output),
			cacheRead: nonNegative(usage.cacheRead),
			cacheWrite: nonNegative(usage.cacheWrite),
			costInput: nonNegative(cost.input),
			costCacheRead: nonNegative(cost.cacheRead),
			costCacheWrite: nonNegative(cost.cacheWrite),
			costTotal: nonNegative(cost.total),
		});
		contextReset = false;
	}
	return calls;
}

/** Observation-pack ledger events. Malformed tails are ignored, never repaired. */
export function parseLedgerText(text: string): LedgerEvent[] {
	const events: LedgerEvent[] = [];
	for (const line of lines(text)) {
		const entry = parseLine(line);
		if (!entry) continue;
		const event = textValue(entry.event);
		if (!LEDGER_EVENTS.has(event)) continue;
		const request = typeof entry.request === "number" && Number.isInteger(entry.request) && entry.request > 0 ? entry.request : null;
		events.push({
			event: event as LedgerEvent["event"],
			id: textValue(entry.id),
			request,
			removedTokens: Math.round(nonNegative(entry.removedTokens)),
		});
	}
	return events;
}

function mode(values: number[]): number {
	const counts = new Map<number, number>();
	for (const value of values) {
		const key = Math.round(value * 1e12) / 1e12;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let best = 0;
	let bestCount = -1;
	for (const [value, count] of [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

export function priceKey(provider: string, model: string): string {
	return `${provider}\u0000${model}`;
}

/** Per-model prices derived only from Pi's own recorded cost fields. */
export function priceTable(calls: readonly SessionCall[]): Map<string, ModelPrice> {
	const inputs = new Map<string, number[]>();
	const cacheReads = new Map<string, number[]>();
	for (const call of calls) {
		const key = priceKey(call.provider, call.model);
		if (call.input > 1000 && call.costInput > 0) {
			inputs.set(key, [...(inputs.get(key) ?? []), call.costInput / call.input]);
		}
		if (call.cacheRead > 1000 && call.costCacheRead > 0) {
			cacheReads.set(key, [...(cacheReads.get(key) ?? []), call.costCacheRead / call.cacheRead]);
		}
	}
	const table = new Map<string, ModelPrice>();
	for (const key of new Set([...inputs.keys(), ...cacheReads.keys()])) {
		table.set(key, { input: mode(inputs.get(key) ?? []), cacheRead: mode(cacheReads.get(key) ?? []) });
	}
	return table;
}

function callPrice(call: SessionCall, table: ReadonlyMap<string, ModelPrice>): ModelPrice {
	const known = table.get(priceKey(call.provider, call.model));
	const input = call.input > 0 ? call.costInput / call.input : (known?.input ?? 0);
	const cacheRead = call.cacheRead > 0 ? call.costCacheRead / call.cacheRead : (known?.cacheRead ?? 0);
	return { input, cacheRead };
}

// Pi consults its model registry only on a complete cache miss. Use the installed
// catalog offline; runtime price overrides cannot be reconstructed from JSONL.
const catalogCachePrices = new Map(getBuiltinProviders().flatMap((provider) =>
	getBuiltinModels(provider).map((model) => [priceKey(provider, model.id), model.cost.cacheRead / 1_000_000] as const),
));

export interface SummarizeOptions {
	readonly calibration: number;
	readonly missMinTokens: number;
}

/**
 * Reproduces Pi 0.85.1's cache metric across all providers. The noise floor is
 * exclusive; compaction and branch summaries reset the previous prompt.
 */
export function summarizeSession(
	input: SessionCostInput,
	prices: ReadonlyMap<string, ModelPrice>,
	options: SummarizeOptions,
): SessionCostSummary {
	const codexCalls = input.calls.filter((call) => call.provider === "openai-codex");
	const rebills = new Map<number, { tokens: number; cost: number; previousMiss: boolean }>();
	const stalls = new Set<number>();
	let run: number[] = [];
	const flush = () => {
		if (run.length >= 2) for (const ordinal of run) stalls.add(ordinal);
		run = [];
	};
	let previous: SessionCall | undefined;
	let reportedCache = false;
	for (const call of input.calls) {
		if (call.contextReset) {
			previous = undefined;
			reportedCache = false;
			flush();
		}
		const total = call.input + call.cacheRead + call.cacheWrite;
		if (total <= 0) continue;
		const previousTotal = previous ? previous.input + previous.cacheRead + previous.cacheWrite : 0;
		const tokens = Math.min(previousTotal, total) - call.cacheRead;
		const missed = previous !== undefined && (reportedCache || call.cacheRead + call.cacheWrite > 0) && tokens > options.missMinTokens;
		if (missed && previous) {
			const paidTokens = call.input + call.cacheWrite;
			const paidRate = paidTokens > 0 ? (call.costInput + call.costCacheWrite) / paidTokens : 0;
			const readRate = call.cacheRead > 0 ? call.costCacheRead / call.cacheRead : (catalogCachePrices.get(priceKey(call.provider, call.model)) ?? 0);
			rebills.set(call.ordinal, {
				tokens, cost: tokens * Math.max(0, paidRate - readRate), previousMiss: rebills.has(previous.ordinal),
			});
		}
		const stalled = missed && previous !== undefined && call.provider === previous.provider && call.model === previous.model
			&& call.cacheRead <= previous.cacheRead && total > previous.cacheRead;
		if (stalled) run.push(call.ordinal);
		else flush();
		previous = call;
		reportedCache ||= call.cacheRead + call.cacheWrite > 0;
	}
	flush();

	const packs = new Set<string>();
	const packRequests = new Set<number>();
	let replayTokens = 0;
	const savings = { cacheReadBasis: 0, inputBasis: 0 };
	const fallbackCall = input.calls[0];
	const ledgerCalls = new Map(input.calls.filter((call) => call.ledgerRequest !== null).map((call) => [call.ledgerRequest, call]));
	for (const event of input.ledger) {
		if (event.event !== PLACEHOLDER) continue;
		// Only the first placeholder per observation is a rewrite break; later
		// events merely re-report the same stable placeholder for that request.
		if (event.id && !packs.has(event.id)) {
			packs.add(event.id);
			if (event.request !== null) packRequests.add(event.request);
		}
		replayTokens += event.removedTokens;
		const owner = event.request !== null ? ledgerCalls.get(event.request) ?? fallbackCall : fallbackCall;
		if (!owner) continue;
		const price = callPrice(owner, prices);
		savings.cacheReadBasis += event.removedTokens * options.calibration * (price.cacheRead > 0 ? price.cacheRead : price.input);
		savings.inputBasis += event.removedTokens * options.calibration * price.input;
	}

	const byCategory: Record<RebillCategory, CategoryTotals> = {
		packIsolated: { misses: 0, tokens: 0, cost: 0 },
		packRiding: { misses: 0, tokens: 0, cost: 0 },
		stall: { misses: 0, tokens: 0, cost: 0 },
		other: { misses: 0, tokens: 0, cost: 0 },
	};
	let misses = 0;
	let rebillTokens = 0;
	let rebillCost = 0;
	const bump = (category: RebillCategory, tokens: number, cost: number) => {
		const current = byCategory[category];
		byCategory[category] = { misses: current.misses + 1, tokens: current.tokens + tokens, cost: current.cost + cost };
	};
	for (const call of input.calls) {
		const miss = rebills.get(call.ordinal);
		if (!miss) continue;
		const { tokens: rebill, cost } = miss;
		const packed = call.ledgerRequest !== null && packRequests.has(call.ledgerRequest);
		const category: RebillCategory = packed && !miss.previousMiss ? "packIsolated" : packed ? "packRiding" : stalls.has(call.ordinal) ? "stall" : "other";
		misses += 1;
		rebillTokens += rebill;
		rebillCost += cost;
		bump(category, rebill, cost);
	}

	const cost = input.calls.reduce((sum, call) => sum + call.costTotal, 0);
	const totalInput = input.calls.reduce((sum, call) => sum + call.input, 0);
	const totalCacheRead = input.calls.reduce((sum, call) => sum + call.cacheRead, 0);
	const totalCacheWrite = input.calls.reduce((sum, call) => sum + call.cacheWrite, 0);
	const totalPrompt = totalInput + totalCacheRead + totalCacheWrite;
	const packCost = byCategory.packIsolated.cost + byCategory.packRiding.cost;
	return {
		sessionId: input.sessionId,
		kind: input.kind,
		start: input.calls[0]?.timestamp ?? "",
		calls: input.calls.length,
		codexCalls: codexCalls.length,
		providers: [...new Set(input.calls.map((call) => call.provider))].sort(),
		models: [...new Set(input.calls.map((call) => call.model))].sort(),
		cost,
		input: totalInput,
		output: input.calls.reduce((sum, call) => sum + call.output, 0),
		cacheRead: totalCacheRead,
		cacheWrite: totalCacheWrite,
		cacheHitRate: totalPrompt > 0 ? totalCacheRead / totalPrompt : 0,
		misses,
		rebillTokens,
		rebillCost,
		byCategory,
		ledger: { present: input.ledger.length > 0, packs: packs.size, replayTokens, recalls: input.ledger.filter((event) => event.event === "recall").length },
		savings,
		net: {
			strict: savings.cacheReadBasis - byCategory.packIsolated.cost,
			full: savings.cacheReadBasis - packCost,
			optimistic: savings.inputBasis - packCost,
		},
	};
}

export interface SessionSource {
	readonly sessionId: string;
	readonly kind: "parent" | "child";
	readonly sessionText: string;
	readonly ledgerText: string | undefined;
}

export interface ScanOptions {
	readonly agentDir: string;
	readonly windowHours: number;
	readonly now: Date;
}

function ledgerDirectories(root: string): Map<string, string> {
	const found = new Map<string, string>();
	const walk = (directory: string, depth: number): void => {
		if (depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch {
			return;
		}
		if (entries.includes("observation-pack")) {
			const ledger = join(directory, "observation-pack", "ledger.jsonl");
			if (existsSync(ledger)) found.set(basename(directory), ledger);
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const child = join(directory, entry);
			try {
				if (statSync(child).isDirectory()) walk(child, depth + 1);
			} catch {
				continue;
			}
		}
	};
	walk(root, 0);
	return found;
}

function sessionIdOf(filePath: string): string {
	const name = basename(filePath).replace(/\.jsonl$/, "");
	const parts = name.split("_");
	return parts[parts.length - 1] ?? name;
}

/** Scan the agent directory for parent and managed-child session logs inside the window. */
export function scanAgentDir(options: ScanOptions): SessionSource[] {
	const sessionsRoot = join(options.agentDir, "sessions");
	const ledgerBySession = ledgerDirectories(options.agentDir);
	const sources: SessionSource[] = [];
	const from = options.now.getTime() - options.windowHours * 3_600_000;
	const push = (filePath: string, kind: "parent" | "child", explicitId?: string) => {
		const sessionId = explicitId ?? sessionIdOf(filePath);
		let sessionText: string;
		try {
			sessionText = readFileSync(filePath, "utf8");
		} catch {
			return;
		}
		const calls = parseSessionText(sessionText);
		const started = Date.parse(calls[0]?.timestamp ?? "");
		if (!Number.isFinite(started) || started < from || started > options.now.getTime() + 60_000) return;
		const ledgerPath = ledgerBySession.get(sessionId);
		sources.push({ sessionId, kind, sessionText, ledgerText: ledgerPath ? readFileSync(ledgerPath, "utf8") : undefined });
	};
	const walkSessions = (directory: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = join(directory, entry);
			try {
				if (statSync(child).isDirectory()) {
					walkSessions(child);
					continue;
				}
			} catch {
				continue;
			}
			if (!entry.endsWith(".jsonl") || entry === "ledger.jsonl" || child.includes(`${sep}sol-pi${sep}`)) continue;
			push(child, "parent");
		}
	};
	walkSessions(sessionsRoot);
	const managedRoot = join(options.agentDir, "subagent-managed-sessions");
	let managed: string[];
	try {
		managed = readdirSync(managedRoot).filter((entry) => entry.startsWith("session_"));
	} catch {
		managed = [];
	}
	for (const entry of managed) push(join(managedRoot, entry, "native.jsonl"), "child", entry.replace(/^session_/, ""));
	return sources.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/** Resolve one explicit session id or file path, ignoring the window. */
export function resolveSessionSource(agentDir: string, selector: string): SessionSource | undefined {
	const candidates: Array<{ filePath: string; kind: "parent" | "child" }> = [];
	if (selector.endsWith(".jsonl") && existsSync(selector)) candidates.push({ filePath: resolve(selector), kind: "parent" });
	const ledgerBySession = ledgerDirectories(agentDir);
	const walk = (directory: string, kind: "parent" | "child") => {
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = join(directory, entry);
			try {
				if (statSync(child).isDirectory()) {
					if (child.includes(`${sep}sol-pi${sep}`) || entry === "scratch") continue;
					walk(child, kind);
					continue;
				}
			} catch {
				continue;
			}
			const candidateId = kind === "child" ? basename(join(child, "..")).replace(/^session_/, "") : sessionIdOf(child);
			if (entry.endsWith(".jsonl") && entry !== "ledger.jsonl" && candidateId === selector) candidates.push({ filePath: child, kind });
		}
	};
	walk(join(agentDir, "sessions"), "parent");
	walk(join(agentDir, "subagent-managed-sessions"), "child");
	const chosen = candidates[0];
	if (!chosen) return undefined;
	const sessionText = readFileSync(chosen.filePath, "utf8");
	const ledgerPath = ledgerBySession.get(selector);
	return { sessionId: selector, kind: chosen.kind, sessionText, ledgerText: ledgerPath ? readFileSync(ledgerPath, "utf8") : undefined };
}

export interface BuildReportOptions {
	readonly agentDir: string;
	readonly now: Date;
	readonly windowHours: number;
	readonly calibration: number;
	readonly missMinTokens: number;
	readonly selectors?: readonly string[];
}

export function buildReport(options: BuildReportOptions): CostReport {
	const sources: SessionSource[] = [];
	if (options.selectors && options.selectors.length > 0) {
		for (const selector of options.selectors) {
			const resolvedSource = resolveSessionSource(options.agentDir, selector);
			if (resolvedSource) sources.push(resolvedSource);
		}
	} else {
		sources.push(...scanAgentDir({ agentDir: options.agentDir, windowHours: options.windowHours, now: options.now }));
	}
	const inputs: SessionCostInput[] = sources.map((source) => ({
		sessionId: source.sessionId,
		kind: source.kind,
		calls: parseSessionText(source.sessionText),
		ledger: source.ledgerText ? parseLedgerText(source.ledgerText) : [],
	}));
	const prices = priceTable(inputs.flatMap((input) => [...input.calls]));
	const sessions = inputs.map((input) => summarizeSession(input, prices, options)).sort((left, right) => left.start.localeCompare(right.start));
	const empty = (): CategoryTotals => ({ misses: 0, tokens: 0, cost: 0 });
	const byCategory: Record<RebillCategory, CategoryTotals> = { packIsolated: empty(), packRiding: empty(), stall: empty(), other: empty() };
	const totals: MutableTotals = {
		sessions: sessions.length,
		calls: 0, codexCalls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0,
		misses: 0, rebillTokens: 0, rebillCost: 0,
		ledgerSessions: 0, packs: 0, replayTokens: 0, recalls: 0,
		savingsCacheReadBasis: 0, savingsInputBasis: 0, netStrict: 0, netFull: 0, netOptimistic: 0,
		packAttributableCost: 0, packAttributableCostStrict: 0, rebillCostShare: 0, savingsCostShare: 0,
		byCategory,
	};
	for (const session of sessions) {
		totals.calls += session.calls;
		totals.codexCalls += session.codexCalls;
		totals.cost += session.cost;
		totals.input += session.input;
		totals.output += session.output;
		totals.cacheRead += session.cacheRead;
		totals.cacheWrite += session.cacheWrite;
		totals.misses += session.misses;
		totals.rebillTokens += session.rebillTokens;
		totals.rebillCost += session.rebillCost;
		if (session.ledger.present) {
			totals.ledgerSessions += 1;
			totals.packs += session.ledger.packs;
			totals.replayTokens += session.ledger.replayTokens;
			totals.recalls += session.ledger.recalls;
		}
		totals.savingsCacheReadBasis += session.savings.cacheReadBasis;
		totals.savingsInputBasis += session.savings.inputBasis;
		totals.netStrict += session.net.strict;
		totals.netFull += session.net.full;
		totals.netOptimistic += session.net.optimistic;
		for (const category of REBILL_CATEGORIES) {
			const current = byCategory[category];
			const value = session.byCategory[category];
			byCategory[category] = { misses: current.misses + value.misses, tokens: current.tokens + value.tokens, cost: current.cost + value.cost };
		}
	}
	const totalPrompt = totals.input + totals.cacheRead + totals.cacheWrite;
	totals.cacheHitRate = totalPrompt > 0 ? totals.cacheRead / totalPrompt : 0;
	totals.packAttributableCost = byCategory.packIsolated.cost + byCategory.packRiding.cost;
	totals.packAttributableCostStrict = byCategory.packIsolated.cost;
	totals.rebillCostShare = totals.cost > 0 ? totals.rebillCost / totals.cost : 0;
	totals.savingsCostShare = totals.cost > 0 ? totals.savingsCacheReadBasis / totals.cost : 0;
	return {
		version: REPORT_VERSION,
		window: {
			from: new Date(options.now.getTime() - options.windowHours * 3_600_000).toISOString(),
			to: options.now.toISOString(),
			hours: options.windowHours,
		},
		sessions,
		totals,
		notes: [
			"Cost is Pi's recorded nominal cost from the session's own usage.cost; subscription providers are not invoices.",
			`Cache re-billed follows Pi 0.85.1 across all providers; misses must exceed ${options.missMinTokens} tokens (Pi default: 1024). Context summaries reset history.`,
			"Re-billed dollars use each request's recorded paid rate, including cache writes. A zero paid rate stays zero. Complete misses use the installed model catalog's read rate (unknown model: zero); runtime pricing overrides are unavailable offline.",
			"packIsolated = rewrite with no previous counted miss; packRiding = rewrite immediately following a miss. Categories are signatures, not proof of causation or zero incremental cost.",
			"savings value avoided observation replays at the cache-read price of the request that owned them; inputBasis is the theoretical ceiling.",
			`replayTokens is raw chars/4 ledger units; savings scale those units by calibration ${options.calibration}, an estimate whose accuracy depends on content.`,
		],
	};
}

function money(value: number): string {
	return `$${value.toFixed(2)}`;
}

function percentage(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function renderTextReport(report: CostReport): string {
	const out: string[] = [];
	const { totals } = report;
	out.push(`window ${report.window.from} .. ${report.window.to} (${report.window.hours}h)`);
	out.push(`sessions ${totals.sessions} | calls ${totals.calls} (codex ${totals.codexCalls}) | cost ${money(totals.cost)} | cache hit ${percentage(totals.cacheHitRate)}`);
	out.push("");
	out.push("session      kind    models                    calls  cost$  hit%  miss  rebill$  pack$  stall$  saved$  net$");
	for (const session of report.sessions) {
		out.push([
			session.sessionId.slice(0, 12).padEnd(12),
			session.kind.padEnd(7),
			session.models.join(",").slice(0, 25).padEnd(25),
			String(session.calls).padStart(5),
			session.cost.toFixed(2).padStart(6),
			(session.cacheHitRate * 100).toFixed(1).padStart(5),
			String(session.misses).padStart(5),
			session.rebillCost.toFixed(2).padStart(8),
			(session.byCategory.packIsolated.cost + session.byCategory.packRiding.cost).toFixed(2).padStart(6),
			session.byCategory.stall.cost.toFixed(2).padStart(7),
			session.savings.cacheReadBasis.toFixed(2).padStart(7),
			session.net.full.toFixed(2).padStart(6),
		].join(" "));
	}
	out.push("");
	out.push(`rebill ${money(totals.rebillCost)} (${percentage(totals.rebillCostShare)} of cost), ${totals.misses} misses, ${Math.round(totals.rebillTokens).toLocaleString("en-US")} tokens`);
	for (const category of REBILL_CATEGORIES) {
		const value = totals.byCategory[category];
		if (value.misses === 0) continue;
		out.push(`  ${category.padEnd(13)} misses ${String(value.misses).padStart(4)} ${Math.round(value.tokens).toLocaleString("en-US").padStart(10)} tok ${money(value.cost).padStart(8)} ${percentage(totals.rebillCost > 0 ? value.cost / totals.rebillCost : 0).padStart(7)}`);
	}
	out.push("");
	out.push(`pack sessions ${totals.ledgerSessions} | packs ${totals.packs} | recalls ${totals.recalls} | avoided replays ${Math.round(totals.replayTokens).toLocaleString("en-US")} tokens`);
	out.push(`saved (cache-read basis) ${money(totals.savingsCacheReadBasis)} (${percentage(totals.savingsCostShare)} of cost) | pack cost strict ${money(totals.packAttributableCostStrict)} / full ${money(totals.packAttributableCost)}`);
	out.push(`net strict ${money(totals.netStrict)} | net full ${money(totals.netFull)} | net optimistic ${money(totals.netOptimistic)}`);
	out.push("", ...report.notes);
	return out.join("\n");
}

interface CliOptions {
	readonly agentDir: string;
	readonly windowHours: number;
	readonly now: Date;
	readonly calibration: number;
	readonly missMinTokens: number;
	readonly format: "text" | "json";
	readonly output?: string;
	readonly selectors: readonly string[];
}

function parseArgs(args: readonly string[]): CliOptions | "help" {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
	const allowed = new Set(["--agent-dir", "--window-hours", "--now", "--calibration", "--min-miss-tokens", "--format", "--output", "--session"]);
	const values = new Map<string, string>();
	const selectors: string[] = [];
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || !allowed.has(key)) throw new Error("invalid_arguments");
		if (key === "--session") {
			selectors.push(value);
			continue;
		}
		if (values.has(key)) throw new Error("duplicate_argument");
		values.set(key, value);
	}
	const number = (name: string, fallback: number): number => {
		const raw = values.get(name);
		if (raw === undefined) return fallback;
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid_${name.replace(/^--/, "").replace(/-/g, "_")}`);
		return parsed;
	};
	const format = values.get("--format") ?? "text";
	if (format !== "text" && format !== "json") throw new Error("invalid_format");
	const now = values.get("--now") === undefined ? new Date() : new Date(values.get("--now")!);
	if (!Number.isFinite(now.getTime())) throw new Error("invalid_now");
	const output = values.get("--output");
	const options: CliOptions = {
		agentDir: values.get("--agent-dir") ?? process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent"),
		windowHours: number("--window-hours", DEFAULT_WINDOW_HOURS),
		now,
		calibration: number("--calibration", DEFAULT_CALIBRATION),
		missMinTokens: number("--min-miss-tokens", DEFAULT_MISS_MIN_TOKENS),
		format,
		selectors,
		...(output === undefined ? {} : { output }),
	};
	return options;
}

export function runCli(args: readonly string[]): string {
	const options = parseArgs(args);
	if (options === "help") {
		return [
			"Usage: session-cost-report.ts [--session <id|path>]... [--agent-dir <dir>]",
			"       [--window-hours <n>] [--now <iso>] [--format text|json] [--output <new-file>]",
			"       [--calibration <n>] [--min-miss-tokens <n>]",
		].join("\n");
	}
	const report = buildReport(options);
	const text = options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${renderTextReport(report)}\n`;
	if (options.output !== undefined) {
		if (existsSync(options.output)) throw new Error("output_exists");
		writeFileSync(options.output, text, { encoding: "utf8", flag: "wx" });
		return `wrote ${options.output}\n`;
	}
	return text;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(`session-cost-report: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
