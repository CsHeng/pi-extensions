import assert from "node:assert/strict";
import { closeSync, chmodSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { HARD_LIMITS, type ChildCapabilityManifest, type EffectiveRoute } from "../extensions/subagents/contracts.ts";
import type { NormalizedTask } from "../extensions/subagents/graph.ts";
import { getRole } from "../extensions/subagents/roles.ts";
import { buildChildPrompt, runChild } from "../extensions/subagents/runner.ts";

const FIXTURE = new URL("fixtures/subagents/fake-pi.mjs", import.meta.url).pathname;
const DIAGNOSTIC_DIR = mkdtempSync(join(tmpdir(), "subagent-runner-diagnostics-"));
chmodSync(DIAGNOSTIC_DIR, 0o700);
let diagnosticIndex = 0;
after(() => rmSync(DIAGNOSTIC_DIR, { recursive: true, force: true }));
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
	externalReadRoots: [],
};
const capability: ChildCapabilityManifest = {
	version: 2,
	root: process.cwd(),
	role: "explorer",
	readRoots: [process.cwd()],
	writePaths: [],
	externalReadRoots: [],
};

function options(mode: string, extra: Record<string, unknown> = {}) {
	const sessionPath = join(DIAGNOSTIC_DIR, `${diagnosticIndex++}.jsonl`);
	closeSync(openSync(sessionPath, "wx", 0o600));
	return {
		task,
		role: getRole("explorer"),
		route,
		cwd: process.cwd(),
		guardExtensionPath: "/tmp/guard.ts",
		capability,
		prompt: "bounded input",
		approveProject: true,
		diagnosticSession: {
			path: sessionPath,
			ref: `subagent-sessions/parent/run/${diagnosticIndex}.jsonl`,
			removeUnused: async () => { await rm(sessionPath, { force: true }); },
		},
		invocation: { command: process.execPath, args: [FIXTURE] },
		env: { ...process.env, FAKE_PI_MODE: mode, CSHENG_SUBAGENT_TEST_MODE: "remove-me" },
		...extra,
	} as Parameters<typeof runChild>[0];
}

test("child prompt renders canonical external roots without changing write or evidence blocks", () => {
	const none = buildChildPrompt(task, "bounded input");
	assert.match(none, /Read scope:\n- \./);
	assert.match(none, /External read roots:\n- none\nWrite paths:\n- none/);
	assert.equal(none.includes("Expected parent evidence"), false);
	const withRoots = buildChildPrompt({
		...task,
		writePaths: ["src/file.ts"],
		verification: ["focused test"],
		externalReadRoots: ["/other/repo/src"],
	}, "bounded input");
	assert.match(withRoots, /External read roots:\n- \/other\/repo\/src\nWrite paths:\n- src\/file.ts/);
	assert.match(withRoots, /Expected parent evidence:\n- focused test/);
	assert.match(withRoots, /\n\nInputs:\nbounded input$/);
});

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
	const recorded = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; child: string; capability: string; sessionPath: string; removedParentMarker?: string };
	assert.equal(recorded.child, "1");
	assert.equal(recorded.removedParentMarker, undefined);
	assert.ok(recorded.args.includes("--no-extensions"));
	assert.ok(recorded.args.includes("--session"));
	assert.equal(recorded.args.includes("--no-session"), false);
	assert.equal(recorded.sessionPath, recorded.args[recorded.args.indexOf("--session") + 1]);
	assert.match(await readFile(recorded.sessionPath, "utf8"), /\"type\":\"session\"/);
	assert.ok(recorded.args.includes("--no-skills"));
	assert.ok(recorded.args.includes("--approve"));
	assert.ok(recorded.args.includes("synthetic/child"));
	assert.ok(recorded.args.includes("low"));
	assert.ok(recorded.args.includes("read,grep,find,ls"));
	await assert.rejects(readFile(recorded.capability, "utf8"), /ENOENT/);

	const withExternal = await runChild(options("normal", {
		task: { ...task, externalReadRoots: ["/other/repo"] },
		capability: { ...capability, externalReadRoots: ["/other/repo"] },
		cwd: process.cwd(),
		env: { ...process.env, FAKE_PI_MODE: "normal", FAKE_PI_CAPTURE: capture, CSHENG_SUBAGENT_TEST_MODE: "remove-me" },
	}));
	assert.equal(withExternal.status, "succeeded");
	const recordedExternal = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; sessionPath: string };
	assert.ok(recordedExternal.args.includes("read,grep,find,ls"));
	assert.ok(recordedExternal.args.includes("--approve"));
	assert.ok(recordedExternal.args.includes("synthetic/child"));
	assert.ok(recordedExternal.args.includes("low"));
	const session = JSON.parse((await readFile(recordedExternal.sessionPath, "utf8")).split("\n")[0] ?? "{}") as { cwd?: string };
	assert.equal(session.cwd, process.cwd());
});

test("runner classifies malformed protocol, child exit, and spawn failure", async () => {
	assert.equal((await runChild(options("malformed"))).error?.code, "malformed_jsonl");
	assert.equal((await runChild(options("nonzero"))).error?.code, "child_exit");
	const spawnOptions = options("normal", { invocation: { command: "/definitely/missing/pi", args: [] } });
	const failed = await runChild(spawnOptions);
	assert.equal(failed.error?.code, "spawn_failure");
	assert.equal(failed.telemetry?.childStarted, false);
	await assert.rejects(readFile(spawnOptions.diagnosticSession.path, "utf8"), /ENOENT/);
});

test("runner caps output and stderr by UTF-8 bytes", async () => {
	const large = await runChild(options("large"));
	assert.match(large.output, /Output truncated/);
	assert.ok(Buffer.byteLength(large.output, "utf8") < HARD_LIMITS.maxFinalOutputBytes + 100);
	const noisy = await runChild(options("stderr"));
	assert.equal(Buffer.byteLength(noisy.stderr, "utf8"), HARD_LIMITS.maxStderrBytes);
});

test("activity arrives before close and intermediate error evidence does not override final success", async () => {
	const phases: string[] = [];
	let closed = false;
	const result = await runChild(options("activity", {
		onActivity(activity: { phase: string }) {
			if (activity.phase === "closed") closed = true;
			else assert.equal(closed, false);
			phases.push(activity.phase);
		},
	}));
	assert.equal(result.status, "succeeded");
	assert.equal(phases[0], "starting");
	assert.ok(phases.includes("running"));
	assert.ok(phases.includes("settled-awaiting-exit"));
	assert.equal(phases.at(-1), "closed");
	assert.equal(result.activity?.assistantTurns, 1);
	assert.equal(result.diagnosticSessionRef?.startsWith("subagent-sessions/"), true);

	const retry = await runChild(options("retry"));
	assert.equal(retry.status, "succeeded");
	assert.equal(retry.activity?.errorObserved, true);
	assert.equal(retry.activity?.errorCount, 1);
	assert.equal(retry.stopReason, "stop");
});

test("agent_end does not settle and settled exit stall has first-cause classification", async () => {
	const ended = await runChild(options("agent-end-only", { timeoutMs: 20, killGraceMs: 20, settledExitGraceMs: 5 }));
	assert.equal(ended.error?.code, "timeout");
	const started = Date.now();
	const stalled = await runChild(options("settled-stall", { timeoutMs: 2_000, killGraceMs: 20, settledExitGraceMs: 20 }));
	assert.equal(stalled.error?.code, "child_exit_stalled");
	assert.ok(Date.now() - started < 1_000);
});

test("diagnostic child and run limits are typed first-cause stops", async () => {
	const limited = await runChild(options("settled-stall", {
		killGraceMs: 20,
		checkDiagnosticLimits: async () => ({ ok: false, code: "diagnostic_session_limit", scope: "child" }),
	}));
	assert.equal(limited.error?.code, "diagnostic_session_limit");

	let runLimitCallbacks = 0;
	const runLimited = await runChild(options("settled-stall", {
		killGraceMs: 20,
		checkDiagnosticLimits: async () => ({ ok: false, code: "diagnostic_session_limit", scope: "run" }),
		onRunDiagnosticLimit: () => { runLimitCallbacks += 1; },
	}));
	assert.equal(runLimited.error?.code, "diagnostic_session_limit");
	assert.ok(runLimitCallbacks >= 1);
});

test("abort terminates a child and timeout escalates to bounded kill", async () => {
	const controller = new AbortController();
	const abortedPromise = runChild(options("wait-term", { signal: controller.signal, killGraceMs: 20 }));
	setTimeout(() => controller.abort(), 20);
	const aborted = await abortedPromise;
	assert.equal(aborted.status, "aborted");
	assert.equal(aborted.error?.code, "aborted");

	const started = Date.now();
	const timeoutOptions = options("ignore-term", { timeoutMs: 20, killGraceMs: 20 });
	const timedOut = await runChild(timeoutOptions);
	assert.equal(timedOut.status, "failed");
	assert.equal(timedOut.error?.code, "timeout");
	assert.equal(typeof await readFile(timeoutOptions.diagnosticSession.path, "utf8"), "string");
	assert.ok(Date.now() - started < 2000);
});
