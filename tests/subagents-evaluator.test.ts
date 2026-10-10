import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extractCurrentEpochMetrics,
	extractSessionMetrics,
	resolveSessionPath,
} from "../.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts";

import { observationFixture } from "./fixtures/subagents-observation-v1.ts";

test("exact-session CLI consumes explicit null disposition without leaking paths or overwriting reports", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "observation-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
	const session = join(root, "PRIVATE_SESSION.jsonl"); const disposition = join(root, "PRIVATE_DISPOSITION.json"); const output = join(root, "PRIVATE_OUTPUT.json");
	await writeFile(session, observationFixture().text());
	await writeFile(disposition, JSON.stringify({ version: 1, parentSessionId: "parent", startEntryId: "user", endEntryId: "after", outcome: "accepted", startedAtMs: 0, acceptedAtMs: null }));
	const script = new URL("../.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts", import.meta.url).pathname;
	const args = ["--experimental-strip-types", script, "--session", session, "--disposition", disposition, "--output", output];
	await promisify(execFile)(process.execPath, args);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.schemaVersion, 5);
	assert.equal(report.observations.usage.total.input, 5); assert.equal(report.observations.outcomes.parentAccepted, true);
	assert.equal(report.observations.outcomes.acceptedDeliveryWallMs, null);
	const before = await readFile(output);
	await assert.rejects(promisify(execFile)(process.execPath, args), (error: any) => {
		assert.doesNotMatch(error.stderr, /PRIVATE|observation-cli/); assert.match(error.stderr, /evaluation_failed/); return true;
	});
	assert.deepEqual(await readFile(output), before);
	await writeFile(disposition, "PRIVATE_INVALID_JSON");
	await assert.rejects(promisify(execFile)(process.execPath, args.slice(0, -2)), (error: any) => {
		assert.doesNotMatch(error.stderr, /PRIVATE|observation-cli/); assert.match(error.stderr, /invalid_parent_disposition_file/); return true;
	});
});

type Row = Record<string, unknown>;

/** Physical native session framing; tool-result rows are appended with a valid identifier lineage. */
function physicalSession(rows: Row[], owner = "owner"): string {
	return [
		{ type: "session", version: 3, id: owner },
		...rows.map((row, index) => ({ id: `row${index}`, parentId: index ? `row${index - 1}` : null, ...row })),
	].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

/** Retired one-shot dispatch result envelope; every version is historical and must be excluded. */
function legacyRow(details: Record<string, unknown>, text = "Subagent run complete"): Row {
	return { type: "message", message: { role: "toolResult", toolName: "csheng_subagents", content: [{ type: "text", text }], details } };
}

function legacyTelemetry(version: 1 | 2 | 3 | 4, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: version,
		runId: "SECRET_RUN_ID",
		runDurationMs: 80,
		requestedTasks: 1,
		admittedTasks: 1,
		launchedChildren: 1,
		peakConcurrency: 1,
		provenance: { available: true, extensionEpoch: "ext", configurationEpoch: "cfg" },
		...overrides,
	};
}

function legacyTask(role: "explorer" | "reviewer" | "worker", overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "SECRET_TASK_ID",
		role,
		status: "succeeded",
		output: "SECRET_CHILD_OUTPUT",
		stderr: "SECRET_STDERR",
		usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: 0.25, turns: 1 },
		durationMs: 42,
		changedPaths: ["SECRET_REPOSITORY_PATH"],
		telemetry: { childStarted: true },
		route: { provider: "fixture", model: "SECRET_RAW_TASK_SELECTOR", thinking: "medium", source: "parent" },
		...overrides,
	};
}

/** Current registered managed tool; only schemaVersion 4 is interpreted by the current-only reducers. */
function managedRow(schemaVersion: number | undefined, details: Record<string, unknown>): Row {
	return { type: "message", message: { role: "toolResult", toolName: "csheng_subagent_sessions", content: [{ type: "text", text: "managed" }],
		details: { ...(schemaVersion === undefined ? {} : { schemaVersion }), ...details } } };
}

const managedTelemetry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	version: 1, ownerSessionId: "owner", invocationId: "invocation", startedAtMs: 200, durationMs: 12,
	extensionEpoch: "ext-now", configurationEpoch: "cfg-now", requestedTasks: 1, admittedTasks: 1, launchedChildren: 0, replayedEpisodes: 0,
	...overrides,
});
const managedCreate = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	action: "create", status: "succeeded", sessions: [], requestTelemetry: managedTelemetry(), ...extra,
});

test("retired one-shot payloads are excluded before interpretation and counted separately", () => {
	const text = physicalSession([
		{ type: "message", message: { role: "user", content: "SECRET_PROMPT" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "csheng_subagents", arguments: { model: "SECRET_RAW_SELECTOR" } }] } },
		legacyRow({ status: "failed", tasks: [], usage: {} }, "Subagent graph rejected (invalid_scope): SECRET_PATH SECRET_CANDIDATE_LIST"),
		legacyRow({ status: "succeeded", tasks: [legacyTask("explorer")], telemetry: legacyTelemetry(4) }),
		legacyRow({ status: "succeeded", tasks: [legacyTask("worker")], telemetry: legacyTelemetry(2) }),
		legacyRow({ status: "partial", tasks: [legacyTask("reviewer")], telemetry: legacyTelemetry(1) }),
	]);
	const metrics = extractSessionMetrics(text, "/redacted/2026_session-legacy123.jsonl");
	assert.equal(metrics.schemaVersion, 5, "the metric artifact version is independent of the managed envelope version");
	assert.equal(metrics.source.selectionMode, "exact-session");
	assert.equal(metrics.source.planEligibility, "unavailable");
	assert.equal(metrics.source.selectedRuns, 0, "no supported current version exists for the retired tool");
	assert.equal(metrics.source.excludedRuns, 4, "every historical one-shot envelope is excluded, not interpreted");
	assert.equal(metrics.observations.available, false);
	assert.equal(metrics.managedDispatch.recordedResults, 0);
	assert.equal(metrics.managedDispatch.launchedChildren.known, 0);
	assert.deepEqual(metrics.observations.rootStatuses, []);
	assert.deepEqual(metrics.observations.releases, []);
	const serialized = JSON.stringify(metrics);
	for (const secret of [
		"SECRET_PROMPT", "SECRET_PATH", "SECRET_TASK_ID", "SECRET_CHILD_OUTPUT", "SECRET_STDERR",
		"SECRET_RAW_SELECTOR", "SECRET_RAW_TASK_SELECTOR", "SECRET_CANDIDATE_LIST", "SECRET_REPOSITORY_PATH", "SECRET_RUN_ID",
	]) {
		assert.equal(serialized.includes(secret), false);
	}
});

test("current managed v4 envelopes are counted while one-shot and non-current managed envelopes are excluded", () => {
	const text = physicalSession([
		legacyRow({ status: "succeeded", tasks: [legacyTask("worker")], telemetry: legacyTelemetry(4) }),
		managedRow(4, managedCreate()),
		managedRow(3, managedCreate({ requestTelemetry: managedTelemetry({ invocationId: "old-managed" }) })),
		managedRow(1, { action: "inspect", status: "failed", sessions: [] }),
	]);
	const metrics = extractSessionMetrics(text, "session_current.jsonl");
	assert.equal(metrics.source.selectedRuns, 1, "only the current managed schema is selected");
	assert.equal(metrics.source.excludedRuns, 3, "one-shot plus non-current managed envelopes are excluded");
	assert.equal(metrics.source.matchedSessions, 1);
	assert.equal(metrics.managedDispatch.ownedRequests, 1);
	assert.equal(metrics.managedDispatch.excludedRecords, 2);
	assert.equal(metrics.managedDispatch.invalidRecords, 0);
});

test("managed invocation epochs and native observations stay separate from retired counts", () => {
	const f = observationFixture();
	f.body.splice(3, 0, { type: "message", id: "retired", parentId: "tool",
		message: { role: "toolResult", toolName: "csheng_subagents", content: [{ type: "text", text: "retired" }],
			details: { status: "succeeded", tasks: [legacyTask("worker")], telemetry: legacyTelemetry(4) } } });
	const metrics = extractSessionMetrics(f.text(), "session_mixed.jsonl");
	assert.equal(metrics.observations.available, true);
	assert.equal(metrics.observations.usage.total.cost, 5, "one retired envelope cannot change current native usage");
	assert.equal(metrics.source.selectedRuns, 1, "the fixture's managed session envelope is current");
	assert.equal(metrics.source.excludedRuns, 1);
	assert.equal(metrics.source.matchedSessions, 1);
});

test("current-epoch mode selects managed provenance and never reads one-shot payloads", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-epoch-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const sessions = join(root, "sessions");
	await mkdir(sessions);
	const manifest = join(root, "current.json");
	await writeFile(manifest, JSON.stringify({
		version: 1,
		extensionEpoch: "ext-now",
		configurationEpoch: "cfg-now",
		extensionActivatedAtMs: 100,
		configurationActivatedAtMs: 100,
	}));
	const retired = legacyRow({ status: "succeeded", tasks: [legacyTask("worker")], telemetry: legacyTelemetry(4) });
	const old = managedRow(4, managedCreate({ requestTelemetry: managedTelemetry({ invocationId: "old", extensionEpoch: "ext-old" }) }));
	const current = managedRow(4, managedCreate({ requestTelemetry: managedTelemetry({ invocationId: "current", startedAtMs: 200 }) }));
	await writeFile(join(sessions, "a_session.jsonl"), physicalSession([retired, old, current]));
	const metrics = await extractCurrentEpochMetrics(sessions, manifest);
	assert.equal(metrics.source.selectionMode, "current-epoch");
	assert.equal(metrics.source.scannedSessions, 1);
	assert.equal(metrics.source.matchedSessions, 1);
	assert.equal(metrics.source.selectedRuns, 1, "only the matching managed invocation is selected");
	assert.equal(metrics.source.excludedRuns, 2, "the retired one-shot envelope and the mismatched managed epoch are both excluded");
	assert.equal(metrics.source.unavailableProvenanceRuns, 0);
	assert.equal(metrics.source.planEligibility, "unavailable");
	assert.equal(metrics.observations.available, false, "native observations require an exact-session input");
	assert.deepEqual(metrics.managedDispatch.actions.find((row) => row.action === "create"), { action: "create", status: "succeeded", count: 1 });
});

test("extractor entry projects no-candidate partial cleanup without treating session scratch as a root failure", () => {
	const f = observationFixture();
	const view = f.body[2]!.message.details.sessions[0];
	delete view.candidate;
	view.roots = [
		{ id: "rootone", destination: "/redacted/one", status: "not-applied", release: "released" },
		{ id: "roottwo", destination: "/redacted/two", status: "not-applied", release: "released" },
	];
	view.release = { status: "partial", remaining: ["scratch"] };
	const metrics = extractSessionMetrics(f.text(), "session_partial.jsonl");
	assert.equal(metrics.source.selectedRuns, 1);
	assert.equal(metrics.observations.available, true);
	assert.deepEqual(metrics.observations.rootStatuses.map((root) => [root.candidateId, root.rootId, root.status, root.release]), [
		[null, "rootone", "not-applied", "released"],
		[null, "roottwo", "not-applied", "released"],
	]);
	assert.deepEqual(metrics.observations.releases, [{ candidateId: null, status: "partial", remaining: 1 }], "the aggregate cleanup failure is separate from per-root disposition");
});

test("session ID resolution refuses ambiguous matches", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-evaluator-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "one"));
	await mkdir(join(root, "two"));
	const id = "fixture-session-1234";
	await writeFile(join(root, "one", `a_${id}.jsonl`), "");
	assert.equal(await resolveSessionPath(id, root), join(root, "one", `a_${id}.jsonl`));
	await writeFile(join(root, "two", `b_${id}.jsonl`), "");
	await assert.rejects(resolveSessionPath(id, root), /ambiguous_session_id/);
});
