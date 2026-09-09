import assert from "node:assert/strict";
import test from "node:test";
import { ManagedDispatchCollector } from "../.agents/skills/evaluate-subagent-runs/scripts/managed-dispatch.ts";
import { extractSessionMetrics } from "../.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts";

const telemetry = { version: 1, ownerSessionId: "owner", invocationId: "invocation", startedAtMs: 100, durationMs: 12, extensionEpoch: "ext", configurationEpoch: "config", requestedTasks: 1, admittedTasks: 1, launchedChildren: 1, replayedEpisodes: 0 };
function session(details: object[], owner = "owner") {
	return [{ type: "session", version: 3, id: owner }, ...details.map((data, index) => ({ type: "message", id: `entry${index}`, parentId: index ? `entry${index-1}` : null, message: { role: "toolResult", toolName: "csheng_subagent_sessions", details: data } }))].map(row => JSON.stringify(row)).join("\n") + "\n";
}
const result = (extra = {}) => ({ schemaVersion: 2, action: "create", status: "succeeded", sessions: [], requestTelemetry: telemetry, ...extra });

test("managed dispatch does not need a settled observation window or alter one-shot totals", () => {
	const metrics = extractSessionMetrics(session([result(), result({ action: "close", status: "failed", error: { code: "missing_session_version" }, requestTelemetry: { ...telemetry, invocationId: "close", admittedTasks: null, requestedTasks: null, launchedChildren: 0, configurationEpoch: null } })]));
	assert.equal(metrics.schemaVersion, 4);
	assert.equal(metrics.observations.available, false);
	assert.equal(metrics.totals.toolCalls, 0);
	assert.equal(metrics.managedDispatch.ownedRequests, 2);
	assert.equal(metrics.managedDispatch.launchedChildren.known, 1);
	assert.deepEqual(metrics.managedDispatch.errors, [{ code: "missing_session_version", count: 1 }]);
	assert.deepEqual(metrics.managedDispatch.actions.find(row => row.action === "close"), { action: "close", status: "failed", count: 1 });
	assert.doesNotMatch(JSON.stringify(metrics), /invocation|ownerSessionId|"ext"|"config"/);
});

test("epoch selection distinguishes request provenance from returned historical episodes", () => {
	const collector = new ManagedDispatchCollector({ extensionEpoch: "ext", configurationEpoch: "config", extensionActivatedAtMs: 50, configurationActivatedAtMs: 50 });
	collector.add(session([
		result(),
		result({ requestTelemetry: { ...telemetry, invocationId: "old", configurationEpoch: "old" } }),
		result({ requestTelemetry: { ...telemetry, invocationId: "replay", configurationEpoch: null, admittedTasks: null, launchedChildren: 0, replayedEpisodes: 1 } }),
		{ schemaVersion: 1, action: "inspect", status: "failed", error: { code: "missing_create_fields" }, sessions: [] },
	]));
	const metrics = collector.result();
	assert.equal(metrics.selectedRequests, 1);
	assert.equal(metrics.excludedRequests, 1);
	assert.equal(metrics.unassignedRequests, 1);
	assert.equal(metrics.legacyResults, 1);
	assert.equal(metrics.launchedChildren.known, 1);
	assert.deepEqual(metrics.legacyActions, [{ action: "inspect", status: "failed", count: 1 }], "never infer a historical create from an error code");
});

test("owned invocation duplicates deduplicate, conflicts invalidate and copied forks do not own requests", () => {
	const collector = new ManagedDispatchCollector();
	collector.add(session([result(), result()]));
	collector.add(session([result()], "fork"));
	assert.equal(collector.result().ownedRequests, 1);
	assert.equal(collector.result().duplicateRecords, 1);
	assert.equal(collector.result().copiedRecords, 1);
	collector.add(session([result({ status: "failed" })]));
	assert.equal(collector.result().conflictingRequests, 1);
	assert.equal(collector.result().launchedChildren.known, 0);
	assert.equal(collector.result().launchedChildren.unavailableRequests, 1);
});

test("invalid action stays separate and malformed or partial physical evidence is not authoritative", () => {
	const good = result({ action: null, status: "failed", requestTelemetry: { ...telemetry, admittedTasks: null, requestedTasks: null, launchedChildren: 0 } });
	const collector = new ManagedDispatchCollector();
	collector.add(session([good]));
	assert.equal(collector.result().actions[0]?.action, "invalid-request");
	for (const text of [session([good]).trimEnd(), session([result({ requestTelemetry: { ...telemetry, launchedChildren: 2 } })])]) {
		const invalid = new ManagedDispatchCollector(); invalid.add(text);
		assert.equal(invalid.result().invalidRecords, 1);
		assert.equal(invalid.result().ownedRequests, 0);
	}
});
