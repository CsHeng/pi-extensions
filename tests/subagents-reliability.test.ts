import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContinuationService } from "../extensions/subagents/continuation.ts";
import { formatManagedContent, formatManagedResult } from "../extensions/subagents/render.ts";
import { managedContextIndex } from "../extensions/subagents/context.ts";
import { emptyUsage, type EffectiveRoute } from "../extensions/subagents/contracts.ts";
import { commandCorrelationKey } from "../extensions/subagents/command-correlation.ts";
import { collectNativeObservation, normalizeCommandCorrelation, isNativeObservation } from "../extensions/subagents/observability.ts";
import type { SessionActionResult, SessionView } from "../extensions/subagents/session-contracts.ts";

const route: EffectiveRoute = { provider: "fixture", model: "actual-model", thinking: "high", source: "user-config", candidateIndex: 0, selectionSource: "role-default", executionProfileApplied: false, reasoningProfileApplied: false, profileFallbacks: [] };

test("managed refusals keep action and missing fields without launching or reading config", async () => {
	let configReads = 0;
	const service = new ContinuationService({ loadConfig: async () => { configReads++; throw new Error("must not read"); } });
	const ctx = { isProjectTrusted: () => false, sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
	for (const [request, action, fields] of [
		[{ action: "create", tasks: [{ id: "a", role: "reviewer", objective: "fixture", scope: ["."] }] }, "create", ["requestId"]],
		[{ action: "close", handle: "h" }, "close", ["expectedEpisode"]],
		[{ action: "untrusted arbitrary action" }, null, undefined],
	] as const) {
		const result = await service.execute(request, ctx);
		assert.equal(result.schemaVersion, 3);
		assert.equal(result.action, action);
		assert.equal(result.status, "failed");
		assert.deepEqual(result.error?.missingFields, fields);
		assert.equal(result.requestTelemetry?.launchedChildren, 0);
		assert.equal(result.requestTelemetry?.configurationEpoch, null);
		assert.equal(result.requestTelemetry?.ownerSessionId, "owner");
		assert.doesNotMatch(formatManagedContent(result), /acceptance|untrusted arbitrary/);
	}
	assert.equal(configReads, 0);
});

test("managed results and index retain actual model/reasoning even on failed and historical results", () => {
	const view: SessionView = { handle: "h", role: "worker", episode: 1, state: "interrupted", reportComplete: false, route,
		result: { id: "task", role: "worker", status: "failed", output: "", stderr: "", usage: emptyUsage(), durationMs: 10, changedPaths: [], convergence: "not-applied", route, error: { code: "timeout", message: "fixture" } } };
	for (const schemaVersion of [1, 2] as const) {
		const details: SessionActionResult = { schemaVersion, action: "create", status: "failed", sessions: [view] };
		const content = JSON.parse(formatManagedContent(details));
		assert.deepEqual(content.sessions[0].route, { provider: "fixture", model: "actual-model", thinking: "high", source: "user-config", selectionSource: "role-default" });
		for (const expanded of [false, true]) {
			const text = formatManagedResult(details, expanded);
			assert.match(text, /route=fixture\/actual-model thinking=high/);
			assert.match(text, /result-error=timeout/);
			assert.doesNotMatch(text, /acceptance/);
		}
	}
	assert.match(managedContextIndex([view])!, /route=fixture\/actual-model thinking=high/);
});

test("command correlation preserves punctuation and normalizes legacy evidence exactly once", () => {
	for (const raw of ["call|provider:1", "带标点/调用", "x".repeat(4096)]) {
		const key = commandCorrelationKey(raw)!;
		assert.match(key, /^[a-f0-9]{64}$/);
		const text = [
			{ type: "session", version: 3, id: "owner" },
			{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: raw }] } },
			{ type: "custom", id: "b", parentId: "a", customType: "csheng-worker-command", data: { version: 2, toolCallId: key, startMs: 0, endMs: 1, exitCode: 0, status: "succeeded", sourceBeforeKey: "a".repeat(64), sourceAfterKey: "a".repeat(64), environmentBeforeKey: "b".repeat(64), environmentAfterKey: "b".repeat(64) } },
		].map(row => JSON.stringify(row)).join("\n") + "\n";
		const observation = collectNativeObservation(text, { startLeaf: null, endLeaf: "b", launched: true });
		assert.equal(observation.available, true);
		assert.equal(observation.timing, undefined);
		assert.equal(observation.commandCoverage, "complete");
		assert.equal(observation.commands[0]?.toolCallId, key);
		assert.deepEqual(normalizeCommandCorrelation(observation), observation);
		const malformed = { ...observation, commands: observation.commands.map(row => ({ ...row, toolCallId: "not-a-hash" })) };
		assert.equal(isNativeObservation(malformed), false);
		const unknown = collectNativeObservation(text.replace('"status":"succeeded"', '"status":"unknown"'), { startLeaf: null, endLeaf: "b", launched: true });
		assert.equal(unknown.commandCoverage, "partial");
		const noEnd = collectNativeObservation(text.replace('"endMs":1', '"endMs":null'), { startLeaf: null, endLeaf: "b", launched: true });
		assert.equal(noEnd.commandCoverage, "partial");
		const missingHash = { ...observation, commands: observation.commands.map(row => ({ ...row, sourceAfterKey: null })) };
		assert.equal(normalizeCommandCorrelation(missingHash).commandCoverage, "partial");
		const reversed = { ...observation, commands: observation.commands.map(row => ({ ...row, startMs: 2, endMs: 1 })) };
		const normalized = normalizeCommandCorrelation(reversed);
		assert.equal(normalized.commandCoverage, "partial");
		assert.equal(normalized.commands.length, 1, "retain the row without claiming a complete interval");
		assert.ok(!JSON.stringify(observation).includes(raw));
		const legacy = { ...observation, commands: observation.commands.map(row => ({ ...row, toolCallId: "legacy" })) };
		delete legacy.commandCorrelationVersion;
		assert.equal(normalizeCommandCorrelation(legacy).commands[0]?.toolCallId, commandCorrelationKey("legacy"));
	}
	assert.equal(commandCorrelationKey(""), null);
	assert.equal(commandCorrelationKey("x".repeat(4097)), null);
});
