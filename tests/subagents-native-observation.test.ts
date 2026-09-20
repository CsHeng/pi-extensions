import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { isLocalTiming } from "../extensions/subagents/telemetry.ts";
import { isNativeObservation, mergeOwnedUsage, type NativeObservation } from "../extensions/subagents/observability.ts";
import { extractSessionMetrics } from "../.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts";
import type { ParentObservation } from "../extensions/subagents/observation-hooks.ts";

for (const installed of [false, true]) test(`native ${installed ? "installed" : "development"} parent and child observations survive continuation and inert replay without double accounting`, async (t) => {
	const base = await mkdtemp(join(tmpdir(), "native-observation-")); t.after(() => rm(base, { recursive: true, force: true }));
	const repo = join(base, "repo"); const agent = join(base, "agent"); await mkdir(repo); await mkdir(agent);
	await promisify(execFile)("git", ["init", "-q", repo]); await writeFile(join(repo, "candidate.txt"), "parent");
	await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	const native = join(base, "parent.jsonl");
	const execution = promisify(execFile)(installed ? "pi" : process.execPath, [
		...(installed ? [] : [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname]),
		"--mode", "json", "-p", "--session", native, "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--approve",
		"-e", new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname,
		"-e", new URL("fixtures/subagents-native-parent.ts", import.meta.url).pathname,
		"--model", "subagent-fixture/fixture", "--thinking", "off", "--",
		"parent-observation-fixture thinking-fixture", "replay-parent-observation-fixture thinking-fixture", "continue-parent-observation-fixture thinking-fixture",
	], { cwd: repo, env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", CSHENG_NATIVE_INSTALLED: installed ? "1" : "0" }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
	execution.child.stdin?.end(); const { stdout } = await execution;
	const stream = stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(stream.some((event) => event.type === "tool_execution_update" && event.toolName === "csheng_subagent_sessions" && event.partialResult?.content?.some((part: { text?: string }) => part.text?.startsWith("Subagents "))), "managed activity is visible through the host tool-update channel");
	const entries = (await readFile(native, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const parents: ParentObservation[] = entries.filter((entry) => entry.type === "custom" && entry.customType === "csheng-parent-observation").map((entry) => entry.data);
	assert.equal(parents.length, 3, JSON.stringify({ observations: parents.length, users: entries.filter((entry) => entry.message?.role === "user").length, toolResults: entries.filter((entry) => entry.message?.role === "toolResult").length, runs: parents.map((parent) => parent.runs.length), ownInput: parents.map((parent) => parent.native.usage.input) }));
	const toolMessages = entries.filter((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "csheng_subagent_sessions").map((entry) => entry.message);
	assert.ok(toolMessages.every(message => message.usage === undefined), "no native billing forwarding on fresh calls or replay");
	const results = toolMessages.map(message => message.details);
	assert.equal(results.length, 3); assert.ok(results.every((result) => result.status === "succeeded"));
	const children: NativeObservation[] = results.map((result) => result.sessions[0].result.observation);
	for (const parent of parents) {
		assert.equal(isNativeObservation(parent.native), true); assert.equal(parent.native.available, true);
		assert.equal(parent.native.ownerSessionId, entries[0].id); assert.equal(parent.native.usage.input, 2);
		assert.equal(isLocalTiming(parent.timing), true); assert.equal(parent.timing.complete, true);
		assert.equal(parent.timing.spans.reasoning.length, 1); assert.equal(parent.timing.spans.delegationWait.length, 1);
		assert.ok(parent.range); assert.notEqual(parent.range!.startLeaf, parent.range!.endLeaf);
		assert.doesNotMatch(JSON.stringify(parent), /fixture-private-thinking|candidate\.txt|subagent-fixture/);
	}
	assert.deepEqual(parents.map((parent) => parent.runs.length), [1, 0, 1]);
	assert.ok(children.every((child) => child.available && child.usage.input === 2));
	assert.deepEqual(children[0], children[1], "replay is the original bounded episode observation");
	assert.equal(children[0]!.ownerSessionId, children[2]!.ownerSessionId);
	assert.equal(parents[0]!.runs[0]!.telemetry.timing!.children[0]!.taskId, children[0]!.ownerSessionId);
	assert.equal(parents[0]!.runs[0]!.clockKey, parents[0]!.timing.clockKey);
	assert.equal(mergeOwnedUsage([...parents.map((parent) => parent.native), ...children]).usage.input, 10);
	const measured = extractSessionMetrics(await readFile(native, "utf8")).observations;
	assert.equal(measured.available, true); assert.equal(measured.usage.total.input, 10);
	assert.equal(measured.usage.parent.input, 6); assert.equal(measured.usage.children.input, 4);
	assert.equal(measured.observedSessions, 1); assert.equal(measured.observedEpisodes, 2);
	assert.equal(measured.outcomes.reportComplete, 2); assert.equal(measured.outcomes.parentAccepted, null);
	assert.ok(measured.timing.workerOccupiedMs !== null && measured.timing.workerOccupiedMs > 0, JSON.stringify(parents.map(parent => ({ boundary: parent.timing.boundary, complete: parent.timing.complete, runs: parent.runs.map(run => ({ sameClock: run.clockKey === parent.timing.clockKey, originDelta: run.originMs! - parent.timing.originMs!, duration: run.telemetry.runDurationMs, complete: run.telemetry.timing?.complete, children: run.telemetry.timing?.children.map(child => ({ role: child.role, startMs: child.startMs, endMs: child.endMs })) })) }))));
	assert.ok(measured.timing.parentReasoningMs !== null);
	assert.ok(measured.childTiming.episodeWallMs !== null && measured.childTiming.episodeWallMs > 0);
	assert.equal(measured.commands.coverage, "complete"); assert.equal(measured.commands.observed, 2);
	assert.equal(measured.childCapabilities.manifestIdentities, 1);
	assert.ok(measured.childCapabilities.configuredToolSets?.[0]?.includes("bash"));
	assert.doesNotMatch(JSON.stringify(measured), /fixture-private|candidate\.txt|subagent-fixture/);
	assert.equal(await readFile(join(repo, "candidate.txt"), "utf8"), "parent", "observation or report completion never auto-applies");
});
