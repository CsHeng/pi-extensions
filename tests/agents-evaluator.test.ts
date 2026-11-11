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
} from "../.agents/skills/evaluate-agent-runs/scripts/extract-session-metrics.ts";

import { observationFixture } from "./fixtures/agents-observation-v1.ts";

test("exact-session CLI consumes explicit null disposition without leaking paths or overwriting reports", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "observation-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
	const session = join(root, "PRIVATE_SESSION.jsonl"); const disposition = join(root, "PRIVATE_DISPOSITION.json"); const output = join(root, "PRIVATE_OUTPUT.json");
	await writeFile(session, observationFixture().text());
	await writeFile(disposition, JSON.stringify({ version: 1, parentSessionId: "parent", startEntryId: "user", endEntryId: "after", outcome: "accepted", startedAtMs: 0, acceptedAtMs: null }));
	const script = new URL("../.agents/skills/evaluate-agent-runs/scripts/extract-session-metrics.ts", import.meta.url).pathname;
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

/** Current registered managed tool; only schemaVersion 4 is interpreted by the current-only reducers. */
function managedRow(schemaVersion: number | undefined, details: Record<string, unknown>): Row {
	return { type: "message", message: { role: "toolResult", toolName: "agent", content: [{ type: "text", text: "managed" }],
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

test("current managed v4 envelopes are counted while non-current managed envelopes are excluded", () => {
	const text = physicalSession([
		managedRow(4, managedCreate()),
		managedRow(3, managedCreate({ requestTelemetry: managedTelemetry({ invocationId: "old-managed" }) })),
		managedRow(1, { action: "inspect", status: "failed", sessions: [] }),
	]);
	const metrics = extractSessionMetrics(text, "session_current.jsonl");
	assert.equal(metrics.source.selectedRuns, 1, "only the current managed schema is selected");
	assert.equal(metrics.source.excludedRuns, 2, "non-current managed envelopes are excluded");
	assert.equal(metrics.source.matchedSessions, 1);
	assert.equal(metrics.managedDispatch.ownedRequests, 1);
	assert.equal(metrics.managedDispatch.excludedRecords, 2);
	assert.equal(metrics.managedDispatch.invalidRecords, 0);
});

test("current-epoch mode selects managed provenance by epoch", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-epoch-"));
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
	const old = managedRow(4, managedCreate({ requestTelemetry: managedTelemetry({ invocationId: "old", extensionEpoch: "ext-old" }) }));
	const current = managedRow(4, managedCreate({ requestTelemetry: managedTelemetry({ invocationId: "current", startedAtMs: 200 }) }));
	await writeFile(join(sessions, "a_session.jsonl"), physicalSession([old, current]));
	const metrics = await extractCurrentEpochMetrics(sessions, manifest);
	assert.equal(metrics.source.selectionMode, "current-epoch");
	assert.equal(metrics.source.scannedSessions, 1);
	assert.equal(metrics.source.matchedSessions, 1);
	assert.equal(metrics.source.selectedRuns, 1, "only the matching managed invocation is selected");
	assert.equal(metrics.source.excludedRuns, 1, "the mismatched managed epoch is excluded");
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
	const root = await mkdtemp(join(tmpdir(), "agent-evaluator-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "one"));
	await mkdir(join(root, "two"));
	const id = "fixture-session-1234";
	await writeFile(join(root, "one", `a_${id}.jsonl`), "");
	assert.equal(await resolveSessionPath(id, root), join(root, "one", `a_${id}.jsonl`));
	await writeFile(join(root, "two", `b_${id}.jsonl`), "");
	await assert.rejects(resolveSessionPath(id, root), /ambiguous_session_id/);
});
