import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { computeCacheWaste } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js";
import type { SessionEntry } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { buildReport, DEFAULT_MISS_MIN_TOKENS, parseLedgerText, parseSessionText, priceTable, renderTextReport, runCli, summarizeSession } from "../.agents/skills/evaluate-session-cost/scripts/session-cost-report.ts";

const PACK_SESSION_ID = "01aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

function astraCost(input: number, cacheRead: number) {
	return { input: input * 1e-5, cacheRead: cacheRead * 1e-6, output: 0, cacheWrite: 0, total: input * 1e-5 + cacheRead * 1e-6 };
}

function assistantMessage(timestamp: string, input: number, cacheRead: number, provider = "openai-codex", model = "gpt-6-astra"): string {
	const cost = astraCost(input, cacheRead);
	return JSON.stringify({
		type: "message", id: `m${timestamp}`, parentId: null, timestamp,
		message: {
			role: "assistant", content: [{ type: "text", text: "ok" }], provider, model,
			usage: { input, output: 0, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead, cost },
			stopReason: "stop",
		},
	});
}

/** Six requests: one rewrite break, one two-request provider stall, one unrelated rebill. */
function packSessionText(day = "2026-01-01"): string {
	const rows = [
		[`${day}T00:00:00.000Z`, 12000, 0],
		[`${day}T00:00:10.000Z`, 200, 11904],
		[`${day}T00:00:20.000Z`, 5000, 11000],
		[`${day}T00:00:30.000Z`, 9000, 11000],
		[`${day}T00:00:40.000Z`, 6000, 11000],
		[`${day}T00:00:50.000Z`, 8000, 1000],
	] as const;
	return `${rows.map(([ts, input, cacheRead]) => assistantMessage(ts, input, cacheRead)).join("\n")}\n`;
}

function zeroCostAssistantMessage(timestamp: string, input: number, cacheRead: number): string {
	return JSON.stringify({
		type: "message", id: `m${timestamp}`, parentId: null, timestamp,
		message: {
			role: "assistant", content: [{ type: "text", text: "ok" }], provider: "openai-codex", model: "gpt-6-astra",
			usage: { input, output: 0, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
		},
	});
}

function packLedgerText(): string {
	return [
		JSON.stringify({ event: "full", id: "obs_a", request: 1, tool: "read", originalTokens: 40000 }),
		JSON.stringify({ event: "full", id: "obs_a", request: 2, tool: "read", originalTokens: 40000 }),
		JSON.stringify({ event: "placeholder", id: "obs_a", request: 3, tool: "read", originalTokens: 40000, removedTokens: 20000 }),
		JSON.stringify({ event: "placeholder", id: "obs_a", request: 4, tool: "read", originalTokens: 40000, removedTokens: 20000 }),
		JSON.stringify({ event: "recall", id: "obs_a", offset: 0, bytes: 1024 }),
	].join("\n") + "\n";
}

function fixtureAgentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "session-cost-"));
	const projectDir = join(root, "sessions", "--project--");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, `2026-01-01T00-00-00-000Z_${PACK_SESSION_ID}.jsonl`), packSessionText());
	mkdirSync(join(projectDir, "sol-pi", PACK_SESSION_ID, "observation-pack"), { recursive: true });
	writeFileSync(join(projectDir, "sol-pi", PACK_SESSION_ID, "observation-pack", "ledger.jsonl"), packLedgerText());
	return root;
}

function close(value: number, expected: number, tolerance = 1e-9): void {
	assert.ok(Math.abs(value - expected) <= tolerance, `${value} != ${expected}`);
}

const builtinModels = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
const hostPrices = { getModel: (provider: string, model: string) => builtinModels.find((entry) => entry.provider === provider && entry.id === model) };

function compareWithHost(rows: string[]) {
	const calls = parseSessionText(rows.join("\n"));
	const summary = summarizeSession({ sessionId: PACK_SESSION_ID, kind: "parent", calls, ledger: [] }, priceTable(calls), {
		calibration: 1.3, missMinTokens: DEFAULT_MISS_MIN_TOKENS,
	});
	const expected = computeCacheWaste(rows.map((row) => JSON.parse(row) as SessionEntry), hostPrices);
	assert.equal(summary.misses, expected.missCount);
	assert.equal(summary.rebillTokens, expected.missedTokens);
	close(summary.rebillCost, expected.missedCost);
	return summary;
}

const stamp = "2026-01-01T00:00:00.000Z";

test("all providers match the actual Pi metric, including model switches and no-cache providers", () => {
	for (const provider of ["openai-codex", "openai", "xai", "deepseek", "custom"]) {
		const summary = compareWithHost([
			assistantMessage(stamp, 12000, 0, provider),
			assistantMessage(stamp, 200, 11904, provider),
			assistantMessage(stamp, 5000, 3000, provider),
		]);
		assert.equal(summary.rebillTokens, 5000);
	}
	assert.equal(compareWithHost([assistantMessage(stamp, 12000, 0), assistantMessage(stamp, 14000, 0)]).misses, 0);
	const switched = compareWithHost([
		assistantMessage(stamp, 1000, 10000),
		assistantMessage(stamp, 12000, 0, "xai", "grok-4.6"),
		assistantMessage(stamp, 14000, 0, "openai", "gpt-6-astra"),
	]);
	assert.equal(switched.misses, 2);
	assert.equal(switched.byCategory.stall.misses, 0);
});

test("the Pi noise floor excludes 1024 and counts 1025 re-billed tokens", () => {
	for (const tokens of [1000, 1024, 1025]) {
		const summary = compareWithHost([assistantMessage(stamp, 12000, 0), assistantMessage(stamp, tokens, 12000 - tokens)]);
		assert.equal(summary.misses, tokens > 1024 ? 1 : 0);
	}
});

test("compaction and branch summaries reset cache history, including across zero-usage entries", () => {
	for (const type of ["compaction", "branch_summary"]) {
		const summary = compareWithHost([
			assistantMessage(stamp, 1000, 10000), JSON.stringify({ type }), assistantMessage(stamp, 0, 0),
			assistantMessage(stamp, 8000, 0), assistantMessage(stamp, 9000, 0),
			assistantMessage(stamp, 7000, 2000),
		]);
		assert.equal(summary.misses, 1);
		assert.equal(summary.rebillTokens, 7000);
	}
});

test("empty-content usage is included and zero-usage entries preserve the previous prompt", () => {
	const empty = JSON.parse(assistantMessage(stamp, 5000, 3000));
	empty.message.content = [];
	const summary = compareWithHost([
		assistantMessage(stamp, 1000, 10000), assistantMessage(stamp, 0, 0), JSON.stringify(empty), assistantMessage(stamp, 6000, 3000),
	]);
	assert.equal(summary.rebillTokens, 10000);
	assert.equal(summary.input, 12000);
	close(summary.cost, 0.136);
});

test("cache writes enter prompt size and the actual weighted paid rate, including complete misses", () => {
	const write = JSON.parse(assistantMessage(stamp, 1000, 2000, "anthropic", "claude-sonnet-4-5"));
	write.message.usage.cacheWrite = 5000;
	write.message.usage.cost = { input: 0.003, output: 0, cacheRead: 0.0006, cacheWrite: 0.01875, total: 0.02235 };
	const summary = compareWithHost([
		assistantMessage(stamp, 2000, 10000, "anthropic", "claude-sonnet-4-5"), JSON.stringify(write),
		assistantMessage(stamp, 9000, 0, "anthropic", "claude-sonnet-4-5"),
	]);
	assert.equal(summary.rebillTokens, 14000);
	assert.equal(summary.cacheWrite, 5000);
	close(summary.cacheHitRate, 12000 / 29000);
});

test("ledger ordinals survive empty assistant usage and clean turns end previous-miss attribution", () => {
	const empty = JSON.parse(assistantMessage(stamp, 0, 0));
	empty.message.content = [];
	const calls = parseSessionText([
		assistantMessage(stamp, 1000, 10000), assistantMessage(stamp, 5000, 3000), JSON.stringify(empty),
		assistantMessage(stamp, 100, 8000), assistantMessage(stamp, 5000, 3000), assistantMessage(stamp, 6000, 3000),
	].join("\n"));
	const ledger = parseLedgerText([
		JSON.stringify({ event: "placeholder", id: "a", request: 4, removedTokens: 1000 }),
		JSON.stringify({ event: "placeholder", id: "b", request: 5, removedTokens: 1000 }),
	].join("\n"));
	const summary = summarizeSession({ sessionId: PACK_SESSION_ID, kind: "parent", calls, ledger }, priceTable(calls), { calibration: 1.3, missMinTokens: 1024 });
	assert.equal(summary.byCategory.packIsolated.misses, 1);
	assert.equal(summary.byCategory.packRiding.misses, 1);
	assert.equal(summary.byCategory.other.misses, 1);
	close(summary.savings.cacheReadBasis, 0.0026);
});

test("rebill reproduces Pi's cache re-billed metric and attributes every miss", () => {
	const calls = parseSessionText(packSessionText());
	assert.equal(calls.length, 6);
	const summary = summarizeSession(
		{ sessionId: PACK_SESSION_ID, kind: "parent", calls, ledger: parseLedgerText(packLedgerText()) },
		priceTable(calls),
		{ calibration: 1.3, missMinTokens: 1000 },
	);
	assert.equal(summary.misses, 4);
	assert.equal(summary.rebillTokens, 20104);
	close(summary.rebillCost, 20104 * 9e-6);
	assert.deepEqual(summary.byCategory.packIsolated, { misses: 1, tokens: 1104, cost: 1104 * 9e-6 });
	assert.deepEqual(summary.byCategory.packRiding, { misses: 0, tokens: 0, cost: 0 });
	assert.deepEqual(summary.byCategory.stall, { misses: 2, tokens: 11000, cost: 11000 * 9e-6 });
	assert.deepEqual(summary.byCategory.other, { misses: 1, tokens: 8000, cost: 8000 * 9e-6 });
	assert.equal(summary.ledger.present, true);
	assert.equal(summary.ledger.packs, 1);
	assert.equal(summary.ledger.replayTokens, 40000);
	assert.equal(summary.ledger.recalls, 1);
	close(summary.cost, 0.447904);
	close(summary.cacheHitRate, 45904 / 86104);
});

test("avoided replays are valued at the owning request's cache-read price and net stays deterministic", () => {
	const calls = parseSessionText(packSessionText());
	const summary = summarizeSession(
		{ sessionId: PACK_SESSION_ID, kind: "parent", calls, ledger: parseLedgerText(packLedgerText()) },
		priceTable(calls),
		{ calibration: 1.3, missMinTokens: 1000 },
	);
	close(summary.savings.cacheReadBasis, 0.052);
	close(summary.savings.inputBasis, 0.52);
	close(summary.net.strict, 0.052 - 1104 * 9e-6);
	close(summary.net.full, 0.052 - 1104 * 9e-6);
	close(summary.net.optimistic, 0.52 - 1104 * 9e-6);
	const again = summarizeSession(
		{ sessionId: PACK_SESSION_ID, kind: "parent", calls: parseSessionText(packSessionText()), ledger: parseLedgerText(packLedgerText()) },
		priceTable(calls),
		{ calibration: 1.3, missMinTokens: 1000 },
	);
	assert.deepEqual(again, summary);
});

test("a zero recorded charge keeps re-billed dollars at zero even inside a billed model", () => {
	const text = [
		assistantMessage("2026-01-01T00:00:00.000Z", 12000, 0),
		assistantMessage("2026-01-01T00:00:10.000Z", 200, 11904),
		zeroCostAssistantMessage("2026-01-01T00:00:20.000Z", 5000, 3000),
	].join("\n") + "\n";
	const calls = parseSessionText(text);
	const summary = summarizeSession(
		{ sessionId: PACK_SESSION_ID, kind: "parent", calls, ledger: [] },
		priceTable(calls),
		{ calibration: 1.3, missMinTokens: 1000 },
	);
	assert.equal(summary.misses, 1);
	assert.equal(summary.rebillTokens, 5000);
	close(summary.rebillCost, 0);
	assert.deepEqual(summary.byCategory.other, { misses: 1, tokens: 5000, cost: 0 });
	assert.equal(summary.byCategory.stall.misses, 0);
});

test("scan attaches ledgers, honors the window, and never prints absolute paths", () => {
	const root = fixtureAgentDir();
	try {
		const projectDir = join(root, "sessions", "--project--");
		writeFileSync(join(projectDir, "2025-12-15T00-00-00-000Z_01bbbbbb-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl"), packSessionText("2025-12-15"));
		const report = buildReport({ agentDir: root, now: new Date("2026-01-01T01:00:00.000Z"), windowHours: 24, calibration: 1.3, missMinTokens: 1000 });
		assert.equal(report.sessions.length, 1);
		const session = report.sessions[0]!;
		assert.equal(session.sessionId, PACK_SESSION_ID);
		assert.equal(session.ledger.packs, 1);
		assert.equal(report.totals.savingsCacheReadBasis.toFixed(3), "0.052");
		assert.equal(report.totals.packAttributableCostStrict.toFixed(6), "0.009936");
		assert.equal(report.totals.netFull.toFixed(6), (0.052 - 0.009936).toFixed(6));
		assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(renderTextReport(report), /packIsolated/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an explicit session selector bypasses the window and the CLI refuses to overwrite output", () => {
	const root = fixtureAgentDir();
	try {
		const report = buildReport({ agentDir: root, now: new Date("2026-06-01T00:00:00.000Z"), windowHours: 24, calibration: 1.3, missMinTokens: 1000, selectors: [PACK_SESSION_ID] });
		assert.equal(report.sessions.length, 1);
		assert.equal(report.totals.misses, 4);
		const text = runCli(["--agent-dir", root, "--session", PACK_SESSION_ID, "--format", "json"]);
		assert.equal((JSON.parse(text) as { version: number }).version, 2);
		const output = join(root, "report.json");
		runCli(["--agent-dir", root, "--session", PACK_SESSION_ID, "--output", output]);
		assert.throws(() => runCli(["--agent-dir", root, "--session", PACK_SESSION_ID, "--output", output]), /output_exists/);
		assert.throws(() => runCli(["--agent-dir", root, "--format", "yaml"]), /invalid_format/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
