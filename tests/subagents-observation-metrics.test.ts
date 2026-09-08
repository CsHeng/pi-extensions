import assert from "node:assert/strict";
import test from "node:test";
import { extractObservationMetrics, validateParentDisposition } from "../.agents/skills/evaluate-subagent-runs/scripts/observation-metrics.ts";
import { observationFixture } from "./fixtures/subagents-observation-v1.ts";
import { unavailableObservation } from "../extensions/subagents/observability.ts";

function replay(f: ReturnType<typeof observationFixture>, action = "inspect", unavailable = false) {
	const views = structuredClone(f.sessions);
	if (unavailable) for (const view of views) view.result.observation = unavailableObservation();
	f.body.splice(3, 0, { type: "message", id: "replay", parentId: "tool", message: { role: "toolResult", toolName: "csheng_subagent_sessions", details: { schemaVersion: 1, action, sessions: views } } });
}

test("frozen three-worker consumer: thirty minutes effort, ten minutes occupied, five owned tokens/cost", () => {
	const f = observationFixture(); const metric = extractObservationMetrics(f.text());
	assert.equal(metric.available, true); assert.equal(metric.observedSessions, 3); assert.equal(metric.observedEpisodes, 3);
	assert.equal(metric.timing.workerEffortMs, 1_800_000); assert.equal(metric.timing.workerOccupiedMs, 600_000);
	assert.equal(metric.timing.parentWallMs, 600_000); assert.equal(metric.timing.parentActiveMs, 0);
	assert.equal(metric.timing.parentDelegationWaitMs, 600_000); assert.equal(metric.timing.unattributedMs, 0);
	assert.equal(metric.usage.parent.input, 2); assert.equal(metric.usage.children.input, 3); assert.equal(metric.usage.total.input, 5); assert.equal(metric.usage.total.cost, 5);
	assert.equal(metric.outcomes.executionSucceeded, 3); assert.equal(metric.outcomes.reportComplete, 3); assert.equal(metric.outcomes.parentAccepted, null);
	assert.equal(metric.models[0]?.usage.input, 5);
	assert.doesNotMatch(JSON.stringify(metric), /PRIVATE|child-|handle-|candidate-|synthetic|fixture|call|parent-clock|\.txt/);
	assert.deepEqual(extractObservationMetrics(f.text()), metric);
});

test("reread, replay, inspect and lost disposable caches do not charge the same episode twice", () => {
	for (const action of ["inspect", "create", "continue", "apply", "close"]) for (const lost of [false, true]) {
		const f = observationFixture(); replay(f, action, lost);
		const metric = extractObservationMetrics(f.text());
		assert.equal(metric.usage.total.cost, 5, `${action}/${lost}`); assert.equal(metric.observedEpisodes, 3);
		assert.equal(metric.outcomes.executionSucceeded, 3); assert.equal(metric.actions.create, action === "create" ? 2 : 1);
	}
});

test("conflicting episode identities, missing parent rows and malformed later metadata are unavailable", () => {
	const f = observationFixture(); replay(f);
	f.body[3]!.message.details.sessions[0].result.observation.entries[0].entryId = "another";
	assert.equal(extractObservationMetrics(f.text()).available, false);
	const missing = observationFixture(); missing.observation.native.entries.pop();
	assert.equal(extractObservationMetrics(missing.text()).usage.total.cost, null);
	const malformed = observationFixture(); malformed.body.push({ type: "custom", id: "broken", parentId: "observation", customType: "csheng-parent-observation", data: {} });
	assert.equal(extractObservationMetrics(malformed.text()).available, false);
	assert.equal(extractObservationMetrics(malformed.text().slice(0, -1)).usage.total.cost, null);
});

test("contradictory configured capabilities for a stable episode never depend on snapshot order", () => {
	for (const patch of [{ capabilityKey: "b".repeat(64) }, { contextWindow: 4096 }, { toolNames: ["bash"] }]) for (const reverse of [false, true]) {
		const f = observationFixture(); replay(f);
		const target = reverse ? f.sessions[0]!.result.observation : f.body[3]!.message.details.sessions[0].result.observation;
		Object.assign(target, patch);
		const metric = extractObservationMetrics(f.text());
		assert.equal(metric.available, false); assert.equal(metric.childCapabilities.manifestIdentities, null);
		assert.equal(metric.childCapabilities.contextWindows, null); assert.equal(metric.childCapabilities.configuredToolSets, null);
	}
});

test("unknown native cost stays null, direct failed summary is unknown, real zero stays zero", () => {
	const f = observationFixture(); f.sessions[0]!.result.observation.entries[0]!.usage.cost = null;
	assert.equal(extractObservationMetrics(f.text()).usage.total.cost, null);
	const zero = observationFixture(); for (const session of zero.sessions) session.result.observation.entries[0]!.usage.cost = 0;
	assert.equal(extractObservationMetrics(zero.text()).usage.children.cost, 0);
	const summary = observationFixture(); summary.body.splice(3, 0, { type: "custom", id: "summary", parentId: "tool", customType: "csheng-compaction-unavailable", data: { reason: "threshold", aborted: false } });
	summary.observation.native.entries.push({ ownerSessionId: "parent", entryId: "summary", kind: "compaction", modelKey: null, usage: unavailableObservation().usage });
	assert.equal(extractObservationMetrics(summary.text()).usage.parent.cost, null);
});

test("missing child views cannot turn observed launches into a free complete prefix", () => {
	const f = observationFixture(); f.sessions.pop();
	assert.equal(extractObservationMetrics(f.text()).usage.children.cost, null);
	assert.equal(extractObservationMetrics(f.text()).usage.parent.cost, 2);
});

test("clock domains and incomplete endpoints never manufacture worker union", () => {
	for (const mode of ["foreign", "missing", "incomplete", "outside"]) {
		const f = observationFixture(); const run = f.observation.runs[0]!;
		if (mode === "foreign") run.clockKey = "another-process";
		if (mode === "missing") run.originMs = null;
		if (mode === "incomplete") run.telemetry.timing!.complete = false;
		if (mode === "outside") run.originMs = 1;
		assert.equal(extractObservationMetrics(f.text()).timing.workerOccupiedMs, null);
		assert.equal(extractObservationMetrics(f.text()).timing.parentWallMs, 600_000);
		assert.equal(extractObservationMetrics(f.text()).usage.total.cost, 5);
	}
	const incomplete = observationFixture(); incomplete.observation.timing.complete = false;
	assert.equal(extractObservationMetrics(incomplete.text()).timing.parentWallMs, 600_000);
	assert.equal(extractObservationMetrics(incomplete.text()).timing.parentReasoningMs, null);
	const zero = observationFixture(); zero.observation.runs = [];
	assert.equal(extractObservationMetrics(zero.text()).timing.workerOccupiedMs, 0);
});

test("sequential waves translate origins; local activity and delegation overlap are not subtracted twice", () => {
	const f = observationFixture(); const run = f.observation.runs[0]!;
	run.telemetry.timing!.children = [{ taskId: "child-0", role: "worker", startMs: 0, endMs: 100 }]; run.telemetry.launchedChildren = 1; run.telemetry.runDurationMs = 100;
	const later = structuredClone(run); later.originMs = 200; f.observation.runs.push(later);
	f.observation.timing.spans.localTool = [{ startMs: 50, endMs: 250 }];
	const metric = extractObservationMetrics(f.text());
	assert.equal(metric.timing.workerEffortMs, 200); assert.equal(metric.timing.workerOccupiedMs, 200);
	assert.equal(metric.timing.parentActiveMs, 200); assert.equal(metric.timing.parentLocalToolMs, 200); assert.equal(metric.timing.unattributedMs, 0);
});

test("copied fork prefix and nested tool aggregates cannot create owned charges", () => {
	const f = observationFixture(); f.body[2]!.message.details.usage = { cost: 999_999 };
	f.body[1]!.message.content = [{ type: "text", text: "PRIVATE" }, { type: "toolResult", details: { usage: { cost: 999_999 } } }];
	assert.equal(extractObservationMetrics(f.text()).usage.total.cost, 5);
	const fork = f.text().replace('"id":"parent"', '"id":"fork","parentSession":"PRIVATE_PATH"');
	assert.equal(extractObservationMetrics(fork).available, false); assert.equal(extractObservationMetrics(fork).usage.total.cost, null);
	f.observation.native = unavailableObservation();
	const unknownOwnerFork = f.text().replace('"id":"parent"', '"id":"fork","parentSession":"PRIVATE_PATH"');
	assert.equal(extractObservationMetrics(unknownOwnerFork).available, false);
	assert.equal(extractObservationMetrics(unknownOwnerFork).usage.children.cost, null, "an unavailable owner cannot grant copied child costs");
});

test("child effort, command endpoints and configured capabilities are deduplicated without cross-process unions", () => {
	const f = observationFixture();
	for (const [index, view] of f.sessions.entries()) {
		const observation = view.result.observation;
		observation.contextWindow = 4096; observation.toolNames = ["read", "bash"]; observation.capabilityKey = "a".repeat(64);
		observation.timing = { ...structuredClone(f.observation.timing), clockKey: `child-clock-${index}`,
			spans: { assistant: [{ startMs: 0, endMs: 100 }], reasoning: [{ startMs: 10, endMs: 20 }], localTool: [{ startMs: 100, endMs: 200 }], compaction: [{ startMs: 200, endMs: 300 }], delegationWait: [] } };
		observation.commands = [{ ownerSessionId: observation.ownerSessionId!, entryId: "command", startMs: 100, endMs: 150, exitCode: index === 0 ? 1 : 0, status: index === 0 ? "failed" : "succeeded", sourceBeforeKey: "a".repeat(64), sourceAfterKey: "b".repeat(64), environmentBeforeKey: "c".repeat(64), environmentAfterKey: "c".repeat(64) }];
	}
	replay(f);
	const metrics = extractObservationMetrics(f.text());
	assert.deepEqual(metrics.childTiming, { episodeWallMs: 1_800_000, activeEffortMs: 900, reasoningEffortMs: 30, localToolEffortMs: 300, compactionEffortMs: 300 });
	assert.equal(metrics.commands.observed, 3); assert.equal(metrics.commands.failed, 1); assert.equal(metrics.commands.durationEffortMs, 150);
	assert.equal(metrics.commands.sourceEndpointChanges, 3); assert.equal(metrics.commands.environmentEndpointChanges, 0);
	assert.deepEqual(metrics.childCapabilities, { manifestIdentities: 1, contextWindows: [4096], configuredToolSets: [["bash", "read"]] });
	assert.doesNotMatch(JSON.stringify(metrics), /child-clock|sourceBeforeKey|environmentBeforeKey|"command"/);
	const partial = observationFixture(); partial.sessions[0]!.result.observation.commandCoverage = "partial";
	assert.equal(extractObservationMetrics(partial.text()).commands.durationEffortMs, null);
	assert.equal(extractObservationMetrics(partial.text()).commands.coverage, "partial");
});

test("applied candidates remain distinct from explicitly scoped parent acceptance", () => {
	const f = observationFixture(); f.sessions[0]!.candidate.status = "applied";
	const disposition = { version: 1, parentSessionId: "parent", startEntryId: "user", endEntryId: "after", outcome: "accepted", startedAtMs: 0, acceptedAtMs: 1000, semanticRepairs: 0, takeovers: 1 };
	const metric = extractObservationMetrics(f.text(), disposition);
	assert.equal(metric.outcomes.candidatesApplied, 1); assert.equal(extractObservationMetrics(f.text()).outcomes.parentAccepted, null);
	assert.equal(metric.outcomes.parentAccepted, true); assert.equal(metric.parentDispositionScope, "explicit-entry-range");
	assert.equal(metric.outcomes.acceptedDeliveryWallMs, 1000); assert.equal(metric.outcomes.semanticRepairs, 0);
	const unknown = extractObservationMetrics(f.text(), { ...disposition, startedAtMs: null, acceptedAtMs: null, semanticRepairs: null, takeovers: null });
	assert.equal(unknown.outcomes.parentAccepted, true); assert.equal(unknown.outcomes.acceptedDeliveryWallMs, null);
	assert.equal(unknown.outcomes.semanticRepairs, null); assert.equal(unknown.outcomes.takeovers, null);
	assert.equal(extractObservationMetrics(f.text(), { ...disposition, startedAtMs: 0, acceptedAtMs: 0 }).outcomes.acceptedDeliveryWallMs, 0);
	assert.equal(extractObservationMetrics(f.text(), { ...disposition, outcome: "rejected" }).outcomes.acceptedDeliveryWallMs, null);
	for (const patch of [{ parentSessionId: "fork" }, { endEntryId: "missing" }, { startedAtMs: 2000 }, { takeovers: -1 }, { prose: "accepted" }]) {
		assert.throws(() => validateParentDisposition({ ...disposition, ...patch }, f.text()), /invalid_parent_disposition/);
	}
});
