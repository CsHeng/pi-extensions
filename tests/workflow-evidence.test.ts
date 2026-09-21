import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_TOOL_NAME, OBSERVATION_LIMITS, summarizeHostObservation } from "../extensions/workflow/observation.ts";
import { FINGERPRINT_LIMITS, fingerprintScope } from "../extensions/workflow/fingerprints.ts";

test("fingerprints bind a scope to content and refuse incomplete scans", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-fingerprint-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
	await writeFile(join(root, "package-lock.json"), "{}\n");

	const first = await fingerprintScope(["src", "package-lock.json"], root);
	assert.equal(first.state, "current");
	assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
	const same = await fingerprintScope(["src", "package-lock.json"], root);
	assert.equal(same.fingerprint, first.fingerprint);
	const reverse = await fingerprintScope(["package-lock.json", "src"], root);
	assert.equal(reverse.fingerprint, first.fingerprint, "declared order does not change the digest");

	await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
	const changed = await fingerprintScope(["src"], root);
	assert.notEqual(changed.fingerprint, first.fingerprint);
	await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
	assert.notEqual((await fingerprintScope(["src"], root)).fingerprint, changed.fingerprint);

	const missing = await fingerprintScope(["does/not/exist.ts"], root);
	assert.equal(missing.state, "current", "a declared missing input is part of the basis");
	assert.notEqual(missing.fingerprint, first.fingerprint);

	const empty = await fingerprintScope([], root);
	assert.equal(empty.scope[0], ".");
	assert.match(empty.fingerprint, /^[0-9a-f]{64}$/);

	await mkdir(join(root, ".git"), { recursive: true });
	await writeFile(join(root, ".git", "index"), "vcs internals\n");
	await mkdir(join(root, "node_modules"), { recursive: true });
	await writeFile(join(root, "node_modules", "dep.js"), "dependency\n");
	const withInternals = await fingerprintScope(["src"], root);
	assert.equal(withInternals.fingerprint, (await fingerprintScope(["src"], root)).fingerprint);
	assert.equal((await fingerprintScope(["."], root)).state, "current");

	let nested = root;
	for (let depth = 0; depth < FINGERPRINT_LIMITS.maxDepth + 2; depth += 1) nested = join(nested, "d");
	await mkdir(nested, { recursive: true });
	const deep = await fingerprintScope(["."], root);
	assert.equal(deep.state, "unavailable");
	assert.match(deep.note ?? "", /depth limit/);
});

test("host observations retain bounded public facts without raw reports or file paths", () => {
	const session = {
		handle: "sess_x", role: "worker", episode: 1, state: "idle", reportComplete: true,
		candidate: { id: "cand_1", status: "not-applied", changedPaths: ["private/path"], appliedPaths: [] },
		result: { output: "private report" },
	};
	const observation = summarizeHostObservation({
		toolCallId: "call-create", toolName: MANAGED_SESSION_TOOL_NAME, isError: false,
		result: { details: { action: "create", status: "succeeded", sessions: [session] } },
	});
	assert.deepEqual(observation.managed, {
		action: "create", status: "succeeded", sessions: [{
			handle: "sess_x", role: "worker", episode: 1, state: "idle", reportComplete: true,
			candidate: { id: "cand_1", status: "not-applied", changedPaths: 1, appliedPaths: 0 },
		}],
	});
	assert.doesNotMatch(JSON.stringify(observation), /private/);
	const oversized = summarizeHostObservation({
		toolCallId: "x".repeat(500), toolName: MANAGED_SESSION_TOOL_NAME, isError: false,
		result: { details: { action: "create", status: "x".repeat(500), sessions: Array.from({ length: 20 }, () => session) } },
	});
	assert.equal(oversized.toolCallId.length, OBSERVATION_LIMITS.maxScalar);
	assert.equal(oversized.managed?.status.length, OBSERVATION_LIMITS.maxScalar);
	assert.equal(oversized.managed?.sessions.length, OBSERVATION_LIMITS.maxSessions);
	const bash = summarizeHostObservation({ toolCallId: "call-bash", toolName: "bash", isError: false, result: { details: { exitCode: 1 } } });
	assert.equal(bash.exitCode, 1);
	assert.equal(bash.managed, undefined);
	const unparsed = summarizeHostObservation({ toolCallId: "call-write", toolName: "write", isError: true, result: { details: { path: "/tmp/x", bytes: 10 } } });
	assert.equal(unparsed.managed, undefined);
	assert.equal(unparsed.exitCode, undefined);
});

test("fingerprints follow a declared symlink target and refuse links outside the workspace", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "workflow-link-"));
	const outside = await mkdtemp(join(tmpdir(), "workflow-link-outside-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	await writeFile(join(root, "target-a"), "A\n");
	await writeFile(join(root, "target-b"), "B\n");
	await writeFile(join(outside, "target"), "OUTSIDE\n");
	await symlink("target-a", join(root, "link"));
	const first = await fingerprintScope(["link"], root);
	await rm(join(root, "link"));
	await symlink("target-b", join(root, "link"));
	const second = await fingerprintScope(["link"], root);
	assert.equal(first.state, "current");
	assert.equal(second.state, "current");
	assert.notEqual(first.fingerprint, second.fingerprint, "retargeting a declared link changes the basis");
	await rm(join(root, "link"));
	await symlink(join(outside, "target"), join(root, "link"));
	const escaping = await fingerprintScope(["link"], root);
	assert.equal(escaping.state, "unavailable", "a link outside the workspace cannot certify content");
	assert.match(escaping.note ?? "", /symlink outside/);
});
