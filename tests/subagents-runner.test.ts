import assert from "node:assert/strict";
import { closeSync, chmodSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { copyFile, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test, { after } from "node:test";
import { HARD_LIMITS, type ChildCapabilityManifest, type EffectiveRoute } from "../extensions/subagents/contracts.ts";
import type { NormalizedTask } from "../extensions/subagents/graph.ts";
import { getRole } from "../extensions/subagents/roles.ts";
import { resolvePiInvocation, runChild } from "../extensions/subagents/runner.ts";
import { syntheticSubprocessEnv } from "./fixtures/synthetic-subprocess-env.ts";

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
		env: syntheticSubprocessEnv(DIAGNOSTIC_DIR, { FAKE_PI_MODE: mode, CSHENG_SUBAGENT_TEST_MODE: "remove-me" }),
		...extra,
	} as Parameters<typeof runChild>[0];
}

test("launcher selection preserves the current runtime without silently switching to PATH pi", () => {
	const script = fileURLToPath(import.meta.url);
	const runtime = { executable: process.execPath, script, platform: process.platform, pid: process.pid };
	assert.deepEqual(resolvePiInvocation(["--version"], runtime), { command: process.execPath, args: [script, "--version"] });
	assert.throws(() => resolvePiInvocation([], { ...runtime, executable: "/missing/retired-pi", script: "/$bunfs/root/pi", platform: "darwin" }), { code: "launcher_unavailable" });
	assert.throws(() => resolvePiInvocation([], { ...runtime, script: "/missing/cli.js" }), { code: "launcher_unavailable" });
	if (process.platform === "linux") {
		assert.deepEqual(resolvePiInvocation(["--version"], { ...runtime, executable: "/missing/retired-pi", script: "/$bunfs/root/pi" }), { command: `/proc/${process.pid}/exe`, args: ["--version"] });
	}
});

test("Linux launches the retained executable inode after deletion and same-path replacement", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
	const executable = join(DIAGNOSTIC_DIR, "retired-pi");
	await copyFile("/bin/sleep", executable);
	const child = spawn(executable, ["30"], { stdio: "ignore" });
	try {
		await once(child, "spawn");
		const runtime = { executable, script: "/$bunfs/root/pi", platform: process.platform, pid: child.pid! };
		await rm(executable);
		const deleted = resolvePiInvocation(["0"], runtime);
		assert.equal(deleted.command, `/proc/${child.pid}/exe`);
		assert.equal((await promisify(execFile)(deleted.command, deleted.args)).stdout, "");
		await copyFile("/bin/echo", executable);
		const replaced = resolvePiInvocation(["0"], runtime);
		assert.equal(replaced.command, deleted.command);
		assert.equal((await promisify(execFile)(replaced.command, replaced.args)).stdout, "");
	} finally {
		if (child.pid && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
		await rm(executable, { force: true });
	}
});

test("zero exit without a complete final report never succeeds", async () => {
	for (const mode of ["empty", "stale", "tool-only", "unpaired", "length", "pending", "toolUse", "missing-settled"]) {
		const result = await runChild(options(mode));
		assert.equal(result.status, "failed", mode);
		assert.equal(result.error?.code, "incomplete_report", mode);
		assert.equal(result.convergence, "not-applicable", mode);
	}
	const complete = await runChild(options("multi-text"));
	assert.equal(complete.status, "succeeded");
	assert.equal(complete.output, "first\n\nsecond");
});

test("runner parses fragmented JSONL and aggregates usage", async () => {
	const result = await runChild(options("fragmented"));
	assert.equal(result.status, "succeeded");
	assert.equal(result.output, "done");
	assert.deepEqual(result.usage, { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.25, turns: 1 });
});

test("synthetic child env excludes ambient operator variables", async (t) => {
	const capture = join(tmpdir(), `subagent-ambient-${process.pid}-${Date.now()}.json`);
	t.after(async () => rm(capture, { force: true }));
	const prior = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "ambient-sentinel";
	try {
		await runChild(options("normal", { env: syntheticSubprocessEnv(DIAGNOSTIC_DIR, { FAKE_PI_MODE: "normal", FAKE_PI_CAPTURE: capture }) }));
		const recorded = JSON.parse(await readFile(capture, "utf8")) as { hasOpenAiKey?: boolean };
		assert.equal(recorded.hasOpenAiKey, false);
	} finally {
		if (prior === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prior;
	}
});

test("runner passes an explicit isolated Pi invocation and cleans private files", async (t) => {
	const capture = join(tmpdir(), `subagent-capture-${process.pid}-${Date.now()}.json`);
	t.after(async () => rm(capture, { force: true }));
	const result = await runChild(options("normal", { env: syntheticSubprocessEnv(DIAGNOSTIC_DIR, { FAKE_PI_MODE: "normal", FAKE_PI_CAPTURE: capture, CSHENG_SUBAGENT_TEST_MODE: "remove-me", RIPGREP_CONFIG_PATH: "/tmp/follow-links-config" }) }));
	assert.equal(result.status, "succeeded");
	const recorded = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; child: string; capability: string; sessionPath: string; removedParentMarker?: string; ripgrepConfig?: string };
	assert.equal(recorded.child, "1");
	assert.equal(recorded.removedParentMarker, undefined);
	assert.equal(recorded.ripgrepConfig, undefined);
	assert.ok(recorded.args.includes("--no-extensions"));
	assert.ok(recorded.args.includes("--session"));
	assert.equal(recorded.args.includes("--no-session"), false);
	assert.equal(recorded.sessionPath, recorded.args[recorded.args.indexOf("--session") + 1]);
	assert.match(await readFile(recorded.sessionPath, "utf8"), /\"type\":\"session\"/);
	assert.ok(recorded.args.includes("--no-skills"));
	assert.ok(recorded.args.includes("--approve"));
	assert.ok(recorded.args.includes("synthetic/child"));
	assert.ok(recorded.args.includes("low"));
	assert.ok(recorded.args.includes("read,grep,find,ls,git_read"));
	await assert.rejects(readFile(recorded.capability, "utf8"), /ENOENT/);

	const withExternal = await runChild(options("normal", {
		task: { ...task, externalReadRoots: ["/other/repo"] },
		capability: { ...capability, externalReadRoots: ["/other/repo"] },
		cwd: process.cwd(),
		env: syntheticSubprocessEnv(DIAGNOSTIC_DIR, { FAKE_PI_MODE: "normal", FAKE_PI_CAPTURE: capture, CSHENG_SUBAGENT_TEST_MODE: "remove-me" }),
	}));
	assert.equal(withExternal.status, "succeeded");
	const recordedExternal = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; sessionPath: string };
	assert.ok(recordedExternal.args.includes("read,grep,find,ls,git_read"));
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
	const controller = new AbortController();
	const waiting = runChild(options("agent-end-only", { signal: controller.signal, killGraceMs: 20, settledExitGraceMs: 5 }));
	setTimeout(() => controller.abort(), 50);
	const ended = await waiting;
	assert.equal(ended.error?.code, "aborted");
	const started = Date.now();
	const stalled = await runChild(options("settled-stall", { killGraceMs: 20, settledExitGraceMs: 20 }));
	assert.equal(stalled.error?.code, "child_exit_stalled");
	assert.ok(Date.now() - started < 1_000);
});

test("a live child has no implicit fifteen-minute deadline", async (t) => {
	const original = globalThis.setTimeout;
	// Accelerate the former production deadline, not the explicit cancel or exit grace.
	t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => original(callback, delay === 900_000 ? 1 : delay, ...args)) as typeof setTimeout);
	const controller = new AbortController();
	let completed = false;
	const running = runChild(options("wait-term", { signal: controller.signal, killGraceMs: 20 })).then(result => { completed = true; return result; });
	await new Promise(resolve => original(resolve, 80));
	const wasLive = !completed;
	controller.abort();
	const result = await running;
	assert.equal(wasLive, true);
	assert.equal(result.error?.code, "aborted");
});

test("explicit abort terminates a child and escalates an ignored TERM to bounded kill", async () => {
	const controller = new AbortController();
	const abortedPromise = runChild(options("wait-term", { signal: controller.signal, killGraceMs: 20 }));
	setTimeout(() => controller.abort(), 20);
	const aborted = await abortedPromise;
	assert.equal(aborted.status, "aborted");
	assert.equal(aborted.error?.code, "aborted");

	const started = Date.now();
	const stubbornController = new AbortController();
	const stubbornOptions = options("ignore-term", { signal: stubbornController.signal, killGraceMs: 20 });
	const stopping = runChild(stubbornOptions);
	setTimeout(() => stubbornController.abort(), 20);
	const stopped = await stopping;
	assert.equal(stopped.status, "aborted");
	assert.equal(stopped.error?.code, "aborted");
	assert.equal(typeof await readFile(stubbornOptions.diagnosticSession.path, "utf8"), "string");
	assert.ok(Date.now() - started < 2000);
});
