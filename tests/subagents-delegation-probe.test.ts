import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGGRESSIVE_DELEGATION_GUIDANCE, BASE_DELEGATION_GUIDANCE } from "../extensions/subagents/guidance.ts";
import { SUBAGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_PROMPT_GUIDELINES, SUBAGENT_TOOL_PROMPT_SNIPPET } from "../extensions/subagents/tool-surface.ts";
import {
	PROBE_GUIDANCE_LEVELS,
	PROBE_SHAPES,
	probeGuidanceLines,
	probeShapeDefinition,
} from "../scripts/fixtures/delegation-probe-extension.ts";
import {
	PROBE_GATE_ENV,
	PROBE_PROMPTS,
	assertProbeAuthorized,
	parseProbeEvents,
	promptSetFingerprint,
	summarizeCell,
	wilsonInterval,
	writeProbeProject,
	type ProbeRunResult,
} from "../scripts/run-delegation-probe.ts";

/*
 * The lane measures the parent's call decision with a mock executor; these
 * offline checks cover its wiring so a drifting fixture or prompt set fails
 * here instead of silently producing incomparable evidence.
 */

test("probe variants reference the production parent-visible surface instead of copied text", () => {
	const production = probeShapeDefinition("production");
	assert.equal(production.name, "csheng_subagent_sessions");
	assert.equal(production.description, SUBAGENT_TOOL_DESCRIPTION);
	assert.equal(production.promptSnippet, SUBAGENT_TOOL_PROMPT_SNIPPET);
	assert.deepEqual(production.promptGuidelines, [...SUBAGENT_TOOL_PROMPT_GUIDELINES]);
	const flat = probeShapeDefinition("flat");
	assert.equal(flat.name, "csheng_subagent_sessions");
	assert.equal(flat.description, SUBAGENT_TOOL_DESCRIPTION);
	const keys = Object.keys((flat.parameters as { properties?: Record<string, unknown> }).properties ?? {});
	assert.deepEqual(keys, ["role", "objective", "scope", "inputs", "verification"]);
	const agentShape = probeShapeDefinition("agent-shape");
	assert.equal(agentShape.name, "Agent");
	assert.deepEqual(Object.keys((agentShape.parameters as { properties?: Record<string, unknown> }).properties ?? {}), ["description", "prompt", "subagent_type", "model", "run_in_background"]);
});

test("probe guidance levels mirror the production level mapping", () => {
	assert.deepEqual(PROBE_GUIDANCE_LEVELS, ["off", "balanced", "aggressive"]);
	assert.deepEqual(probeGuidanceLines("off"), []);
	assert.deepEqual(probeGuidanceLines("balanced"), [BASE_DELEGATION_GUIDANCE]);
	assert.deepEqual(probeGuidanceLines("aggressive"), [BASE_DELEGATION_GUIDANCE, AGGRESSIVE_DELEGATION_GUIDANCE]);
	assert.deepEqual(PROBE_SHAPES, ["production", "flat", "agent-shape"]);
});

test("frozen prompt set keeps its recorded fingerprint and both control topics", () => {
	// A deliberate prompt edit updates this constant in the same change, so older
	// artifacts stay comparable and accidental edits are visible.
	assert.equal(promptSetFingerprint(), "f46a6c59a81515f52315d052cca091e4ce6e62b87caaad71ef48d74622a701d3");
	assert.deepEqual(PROBE_PROMPTS.map((prompt) => [prompt.id, prompt.kind]), [
		["survey", "target"],
		["module-summary", "control"],
		["version-check", "control"],
	]);
});

test("probe authorization is required and typed", () => {
	assert.throws(() => assertProbeAuthorized({}), new RegExp(`delegation_probe_requires_${PROBE_GATE_ENV}_1`));
	assert.doesNotThrow(() => assertProbeAuthorized({ [PROBE_GATE_ENV]: "1" }));
	assert.throws(() => assertProbeAuthorized({ [PROBE_GATE_ENV]: "true" }));
});

test("event parsing counts the call decision in print and rpc streams", () => {
	const printStream = [
		'{"type":"session","version":3}',
		'{"type":"turn_start"}',
		'{"type":"tool_execution_start","toolCallId":"a","toolName":"bash","args":{}}',
		'{"type":"tool_execution_start","toolCallId":"b","toolName":"csheng_subagent_sessions","args":{"action":"create"}}',
		'{"type":"tool_execution_end","toolName":"csheng_subagent_sessions","isError":false}',
		'{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{"cost":{"total":0.0125}}}}',
		'not json',
	];
	const counts = parseProbeEvents(printStream);
	assert.equal(counts.called, true);
	assert.equal(counts.callCount, 1);
	assert.equal(counts.argErrors, 0);
	assert.equal(counts.otherToolCalls, 1);
	assert.equal(counts.turns, 1);
	assert.equal(counts.stopReason, "stop");
	assert.equal(counts.costUsd, 0.0125);
	const rpcStream = [
		'{"type":"turn_start"}',
		'{"type":"tool_execution_start","toolName":"Agent","args":{"prompt":"x"}}',
		'{"type":"tool_execution_end","toolName":"Agent","isError":true}',
		'{"type":"agent_settled"}',
	];
	const rpc = parseProbeEvents(rpcStream);
	assert.equal(rpc.called, true);
	assert.equal(rpc.argErrors, 1);
	assert.equal(rpc.settled, true);
	assert.equal(parseProbeEvents([]).called, false);
});

test("cell summaries keep small samples honest", () => {
	const row = (called: boolean, turns: number): ProbeRunResult => ({
		shape: "production", guidance: "aggressive", mode: "print", promptId: "survey", promptKind: "target", trial: 0,
		called, callCount: called ? 1 : 0, argErrors: 0, otherToolCalls: 0, turns, stopReason: "stop", settled: true,
		timedOut: false, exitCode: 0, durationMs: 1000, costUsd: 0.01,
	});
	const cell = summarizeCell([row(true, 3), row(true, 5), row(false, 4), row(true, 9)]);
	assert.equal(cell["runs"], 4);
	assert.equal(cell["called"], 3);
	assert.equal(cell["rate"], 0.75);
	assert.equal(cell["medianTurns"], 5);
	const interval = cell["rateWilson95"] as { low: number; high: number };
	assert.ok(interval.low < 0.75 && interval.high > 0.75);
	assert.ok(interval.low > 0.2 && interval.high < 0.99, "a four-run cell must report a wide interval");
	assert.equal(summarizeCell([])["rate"], null);
});

test("wilson interval stays inside zero and one", () => {
	assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
	assert.equal(wilsonInterval(10, 10).high, 1);
	assert.equal(wilsonInterval(0, 10).low, 0);
	const all = wilsonInterval(10, 10);
	assert.ok(all.low > 0.6 && all.low < 1);
});

test("probe project fixture is self-contained and read-only toward this repository", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "delegation-probe-fixture-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeProbeProject(root);
	const projectFiles = await readdir(join(root, "proj", "src"));
	assert.deepEqual(projectFiles.sort(), ["__init__.py", "collector.py", "export.py", "parser.py", "report.py", "store.py", "thresholds.py"]);
	const repoExtensions = (await readdir(join(root, "repo", "extensions"))).sort();
	assert.ok(repoExtensions.includes("subagents") && repoExtensions.includes("workflow"));
	assert.ok((await readdir(join(root, "repo", "extensions", "subagents"))).includes("index.ts"));
	assert.equal((await readdir(join(root, "repo"))).includes("node_modules"), false);
});
