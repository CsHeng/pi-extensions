import assert from "node:assert/strict";
import test from "node:test";
import { ManagedDispatchCollector } from "../.agents/skills/evaluate-subagent-runs/scripts/managed-dispatch.ts";
const requestTelemetry = { version: 1, ownerSessionId: "owner", invocationId: "request", startedAtMs: 100, durationMs: 2, extensionEpoch: "ext", configurationEpoch: "config", requestedTasks: 1, admittedTasks: 1, launchedChildren: 0, replayedEpisodes: 0 };
const receipt = { schemaVersion: 3, action: "create", kind: "submission", status: "accepted", runId: "run", generation: "generation", sessions: [{ handle: "handle", episode: 1, state: "queued", reportComplete: false }], requestTelemetry };
const event = (kind = "task-terminal", eventId = "terminal") => ({ version: 3, eventId, kind, runId: "run", generation: "generation", owner: { repository: "/redacted", sessionId: "owner", branchAnchor: "anchor" }, toolCallId: "tool", foreground: false,
 timing: { clockKey: "clock", submittedAtMs: 0, preparedAtMs: 2, queuedAtMs: 2, startedAtMs: 5, finishedAtMs: 20 },
 sessions: [{ handle: "handle", episode: 1, role: "worker", state: "idle", reportComplete: true, execution: { startedAtMs: 100, provenance: { available: true, extensionEpoch: "ext", configurationEpoch: "config" } }, result: { id: "task", status: "succeeded", telemetry: { childStarted: true, workspaceMs: 4, childMs: 10 }, output: "private child report" } }],
});
function physical(rows: Array<{ tool?: unknown; event?: unknown }>, owner = "owner") {
 return [{ type: "session", version: 3, id: owner }, ...rows.map((row, i) => ({ id: `row${i}`, parentId: i ? `row${i-1}` : null, ...(row.tool ? { type: "message", message: { role: "toolResult", toolName: "csheng_subagent_sessions", details: row.tool } } : { type: "custom", customType: "csheng.subagents.execution.v3", data: row.event }) }))].map(row => JSON.stringify(row)).join("\n") + "\n";
}

test("v3 receipts count admission only; terminal events own launches and latency even before the receipt", () => {
 const pending = new ManagedDispatchCollector(); pending.add(physical([{ tool: receipt }]));
 assert.equal(pending.result().launchedChildren.known, 0); assert.equal(pending.result().async?.terminalTasks, 0); assert.equal(pending.result().async?.timing.childEffortMs, null);
 const collector = new ManagedDispatchCollector(); collector.add(physical([{ event: event() }, { tool: receipt }, { event: event("run-terminal", "summary") }, { event: event() }]));
 const result = collector.result(); assert.equal(result.invalidRecords, 0); assert.equal(result.launchedChildren.known, 1); assert.equal(result.async?.terminalTasks, 1); assert.equal(result.async?.terminalRuns, 1); assert.equal(result.async?.duplicateEvents, 1);
 assert.deepEqual(result.async?.timing, { preparationMs: 2, queueMs: 3, workspaceMs: 4, childEffortMs: 10, submissionToTerminalMs: 20 });
 assert.doesNotMatch(JSON.stringify(result), /private child report|redacted|toolCallId|ownerSessionId/);
});

test("v3 foreground result and join/inspect replays do not double-count persisted execution", () => {
 const collector = new ManagedDispatchCollector();
 collector.add(physical([{ event: event() }, { event: event("run-terminal", "summary") }, { tool: { ...receipt, kind: "execution", status: "succeeded", requestTelemetry: { ...requestTelemetry, launchedChildren: 1 } } }, { tool: { ...receipt, action: "inspect", kind: "execution", status: "succeeded", requestTelemetry: { ...requestTelemetry, invocationId: "inspect", requestedTasks: null, admittedTasks: null } } }]));
 assert.equal(collector.result().ownedRequests, 2); assert.equal(collector.result().launchedChildren.known, 1);
});

test("timing enrichment cannot overwrite conflicting run-terminal facts and epoch timing shares the task cutoff", () => {
 const conflict = new ManagedDispatchCollector(); const changed = event(); changed.sessions[0]!.result.status = "failed";
 conflict.add(physical([{ event: event("run-terminal", "summary") }, { event: changed }]));
 assert.equal(conflict.result().async?.conflictingEvents, 1); assert.equal(conflict.result().launchedChildren.known, 0); assert.equal(conflict.result().async?.timing.queueMs, null);
 const filtered = new ManagedDispatchCollector({ extensionEpoch: "ext", configurationEpoch: "config", extensionActivatedAtMs: 101, configurationActivatedAtMs: 50 });
 filtered.add(physical([{ event: event() }, { event: event("run-terminal", "summary") }]));
 assert.equal(filtered.result().async?.terminalTasks, 0); assert.equal(filtered.result().async?.terminalRuns, 0); assert.equal(filtered.result().async?.timing.submissionToTerminalMs, null);
});

test("copied owners and conflicting event identities are not execution proof; epoch selection uses episode provenance", () => {
 const copied = new ManagedDispatchCollector(); copied.add(physical([{ event: event() }], "fork")); assert.equal(copied.result().launchedChildren.known, 0); assert.equal(copied.result().async?.copiedEvents, 1);
 const conflict = new ManagedDispatchCollector(); conflict.add(physical([{ event: event() }, { event: { ...event(), sessions: [] } }])); assert.equal(conflict.result().async?.conflictingEvents, 1); assert.equal(conflict.result().launchedChildren.known, 0); assert.equal(conflict.result().async?.timing.childEffortMs, null);
 const filtered = new ManagedDispatchCollector({ extensionEpoch: "new", configurationEpoch: "config", extensionActivatedAtMs: 50, configurationActivatedAtMs: 50 }); filtered.add(physical([{ event: event() }])); assert.equal(filtered.result().async?.excludedTasks, 1); assert.equal(filtered.result().launchedChildren.known, 0);
});
