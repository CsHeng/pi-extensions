import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HARD_LIMITS, type ChildCapabilityManifest, type EffectiveRoute } from "../extensions/subagents/contracts.ts";
import type { NormalizedTask } from "../extensions/subagents/graph.ts";
import { getRole } from "../extensions/subagents/roles.ts";
import { runChild } from "../extensions/subagents/runner.ts";

const FIXTURE = new URL("fixtures/subagents/fake-pi.mjs", import.meta.url).pathname;
const route: EffectiveRoute = {
	provider: "synthetic",
	model: "child",
	thinking: "low",
	source: "user-config",
	candidateIndex: 0,
	executionProfileApplied: false,
	reasoningProfileApplied: false,
	profileFallbacks: [],
};
const task: NormalizedTask = {
	id: "scan",
	role: "explorer",
	objective: "Find facts",
	scope: ["."],
	inputs: [],
	dependsOn: [],
	writePaths: [],
	verification: [],
	resourceLocks: [],
};
const capability: ChildCapabilityManifest = { version: 1, root: process.cwd(), role: "explorer", readRoots: [process.cwd()], writePaths: [] };

function options(mode: string, extra: Record<string, unknown> = {}) {
	return {
		task,
		role: getRole("explorer"),
		route,
		cwd: process.cwd(),
		guardExtensionPath: "/tmp/guard.ts",
		capability,
		prompt: "bounded input",
		approveProject: true,
		invocation: { command: process.execPath, args: [FIXTURE] },
		env: { ...process.env, FAKE_PI_MODE: mode, CSHENG_SUBAGENT_TEST_MODE: "remove-me" },
		...extra,
	} as Parameters<typeof runChild>[0];
}

test("runner parses fragmented JSONL and aggregates usage", async () => {
	const result = await runChild(options("fragmented"));
	assert.equal(result.status, "succeeded");
	assert.equal(result.output, "done");
	assert.deepEqual(result.usage, { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.25, turns: 1 });
});

test("runner passes an explicit isolated Pi invocation and cleans private files", async (t) => {
	const capture = join(tmpdir(), `subagent-capture-${process.pid}-${Date.now()}.json`);
	t.after(async () => rm(capture, { force: true }));
	const result = await runChild(options("normal", { env: { ...process.env, FAKE_PI_MODE: "normal", FAKE_PI_CAPTURE: capture, CSHENG_SUBAGENT_TEST_MODE: "remove-me" } }));
	assert.equal(result.status, "succeeded");
	const recorded = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; child: string; capability: string; removedParentMarker?: string };
	assert.equal(recorded.child, "1");
	assert.equal(recorded.removedParentMarker, undefined);
	assert.ok(recorded.args.includes("--no-extensions"));
	assert.ok(recorded.args.includes("--no-skills"));
	assert.ok(recorded.args.includes("--approve"));
	assert.ok(recorded.args.includes("synthetic/child"));
	assert.ok(recorded.args.includes("low"));
	assert.ok(recorded.args.includes("read,grep,find,ls"));
	await assert.rejects(readFile(recorded.capability, "utf8"), /ENOENT/);
});

test("runner classifies malformed protocol, child exit, and spawn failure", async () => {
	assert.equal((await runChild(options("malformed"))).error?.code, "malformed_jsonl");
	assert.equal((await runChild(options("nonzero"))).error?.code, "child_exit");
	const failed = await runChild(options("normal", { invocation: { command: "/definitely/missing/pi", args: [] } }));
	assert.equal(failed.error?.code, "spawn_failure");
	assert.equal(failed.telemetry?.childStarted, false);
});

test("runner caps output and stderr by UTF-8 bytes", async () => {
	const large = await runChild(options("large"));
	assert.match(large.output, /Output truncated/);
	assert.ok(Buffer.byteLength(large.output, "utf8") < HARD_LIMITS.maxFinalOutputBytes + 100);
	const noisy = await runChild(options("stderr"));
	assert.equal(Buffer.byteLength(noisy.stderr, "utf8"), HARD_LIMITS.maxStderrBytes);
});

test("abort terminates a child and timeout escalates to bounded kill", async () => {
	const controller = new AbortController();
	const abortedPromise = runChild(options("wait-term", { signal: controller.signal, killGraceMs: 20 }));
	setTimeout(() => controller.abort(), 20);
	const aborted = await abortedPromise;
	assert.equal(aborted.status, "aborted");
	assert.equal(aborted.error?.code, "aborted");

	const started = Date.now();
	const timedOut = await runChild(options("ignore-term", { timeoutMs: 20, killGraceMs: 20 }));
	assert.equal(timedOut.status, "failed");
	assert.equal(timedOut.error?.code, "timeout");
	assert.ok(Date.now() - started < 2000);
});
