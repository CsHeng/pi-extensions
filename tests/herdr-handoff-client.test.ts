import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HARD_LIMITS } from "../extensions/herdr-handoff/contracts.ts";
import {
	HerdrClient,
	decodeAgentInfo,
	parseHerdrVersion,
	versionAtLeast,
	type ExecResult,
	type HerdrContract,
	type HerdrExec,
} from "../extensions/herdr-handoff/herdr-client.ts";

const FAKE = new URL("./fixtures/herdr/fake-herdr.mjs", import.meta.url).pathname;
const CONTRACT_PATH = new URL("./fixtures/herdr/herdr-0.8.2-contract.json", import.meta.url).pathname;

async function loadContract(): Promise<HerdrContract> {
	return JSON.parse(await readFile(CONTRACT_PATH, "utf8")) as HerdrContract;
}

function env(): NodeJS.ProcessEnv {
	return { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };
}

async function fakeExec(t: test.TestContext, scenario: Record<string, unknown>): Promise<{ exec: HerdrExec; dir: string; log(): Promise<unknown[]> }> {
	const dir = await mkdtemp(join(tmpdir(), "herdr-fake-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "scenario.json"), JSON.stringify(scenario));
	await writeFile(join(dir, "commands.jsonl"), "");
	const exec: HerdrExec = (command, args, options) => new Promise((resolve, reject) => {
		assert.equal(command, "herdr");
		const child = spawn(process.execPath, [FAKE, ...args], {
			env: { ...process.env, HERDR_FAKE_DIR: dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		const timer = options?.timeout === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), options.timeout);
		options?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				code: code ?? 1,
				killed: signal !== null,
			} satisfies ExecResult);
		});
	});
	return {
		exec,
		dir,
		async log() {
			const text = await readFile(join(dir, "commands.jsonl"), "utf8");
			return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line) as unknown);
		},
	};
}

test("contract fixture freezes 0.8.2 protocol 20 command and result shapes", async () => {
	const contract = await loadContract();
	assert.equal(contract.herdrVersion, "0.8.2");
	assert.equal(contract.protocol, 20);
	assert.deepEqual(contract.resultTypes.agent_info, ["type", "agent"]);
	assert.ok(contract.agentInfoRequired.includes("pane_id"));
	assert.ok(contract.stableErrorCodes.includes("agent_prompt_stalled"));
	assert.deepEqual(contract.resultTypes.ok, ["type"]);
	assert.equal(contract.resultTypes.wait_matched, undefined);
	assert.equal(contract.resultTypes.pane_read, undefined);
	assert.deepEqual(contract.rawOutputs?.agentRead, {
		stream: "stdout",
		maxLines: HARD_LIMITS.maxReturnLines,
		maxBytes: HARD_LIMITS.maxReturnEnvelopeBytes,
	});
	assert.equal(versionAtLeast([0, 8, 2], [0, 8, 2]), true);
	assert.equal(versionAtLeast([0, 8, 1], [0, 8, 2]), false);
	assert.deepEqual(parseHerdrVersion("herdr 0.9.1\n"), [0, 9, 1]);
});

test("preflight requires Herdr env and compatible CLI", async (t) => {
	const contract = await loadContract();
	const fake = await fakeExec(t, { version: "herdr 0.8.2" });
	const missingEnv = new HerdrClient({ exec: fake.exec, env: {}, contract });
	const envFail = await missingEnv.preflight();
	assert.equal(envFail.ok, false);
	if (!envFail.ok) assert.equal(envFail.code, "herdr_environment_required");

	const old = await fakeExec(t, { version: "herdr 0.8.1" });
	const incompatible = new HerdrClient({ exec: old.exec, env: env(), contract });
	const versionFail = await incompatible.preflight();
	assert.equal(versionFail.ok, false);
	if (!versionFail.ok) assert.equal(versionFail.code, "herdr_cli_incompatible");

	const okClient = new HerdrClient({ exec: fake.exec, env: env(), contract });
	const ready = await okClient.preflight();
	assert.equal(ready.ok, true);
});

test("delegate-return prompt waits once and transfer waits only until working", async (t) => {
	const contract = await loadContract();
	const fake = await fakeExec(t, { version: "herdr 0.8.2", promptStatus: "idle", readText: "done" });
	const client = new HerdrClient({ exec: fake.exec, env: env(), contract });
	const prompted = await client.promptAgent({
		target: "codex-worker",
		text: "SECRET_PLAN",
		mode: "delegate-return",
		timeoutMs: HARD_LIMITS.minWaitMs,
	});
	assert.equal(prompted.ok, true);
	const read = await client.readRecentUnwrapped("codex-worker");
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.value.text, "done");

	const transferFake = await fakeExec(t, { version: "herdr 0.8.2", promptStatus: "working" });
	const transferClient = new HerdrClient({ exec: transferFake.exec, env: env(), contract });
	const transferred = await transferClient.promptAgent({
		target: "codex-worker",
		text: "SECRET_PLAN",
		mode: "transfer",
		timeoutMs: HARD_LIMITS.minWaitMs,
	});
	assert.equal(transferred.ok, true);

	const delegateLog = await fake.log() as Array<{ argv: unknown[] }>;
	const transferLog = await transferFake.log() as Array<{ argv: unknown[] }>;
	assert.deepEqual(delegateLog[0]?.argv, ["agent", "prompt", "codex-worker", { omitted: true, bytes: Buffer.byteLength("SECRET_PLAN") }, "--wait", "--timeout", String(HARD_LIMITS.minWaitMs)]);
	assert.deepEqual(transferLog[0]?.argv, ["agent", "prompt", "codex-worker", { omitted: true, bytes: Buffer.byteLength("SECRET_PLAN") }, "--wait", "--until", "working", "--timeout", String(HARD_LIMITS.minWaitMs)]);
	assert.equal(delegateLog.length, 2);
	assert.deepEqual(delegateLog[1]?.argv, ["agent", "read", "codex-worker", "--source", "recent-unwrapped", "--lines", String(HARD_LIMITS.maxReturnLines)]);
});

test("start discards argv and interrupt sends one ctrl+c", async (t) => {
	const contract = await loadContract();
	const fake = await fakeExec(t, { version: "herdr 0.8.2", argvEcho: true });
	const client = new HerdrClient({ exec: fake.exec, env: env(), contract });
	const started = await client.startAgent({
		name: "codex-worker",
		kind: "codex",
		paneId: "w2:p1",
		args: ["--secret", "value"],
	});
	assert.equal(started.ok, true);
	if (started.ok) {
		assert.equal("argv" in started.value, false);
		assert.doesNotMatch(JSON.stringify(started.value), /secret/);
	}
	const interrupted = await client.sendInterrupt("codex-worker");
	assert.equal(interrupted.ok, true);
	const log = await fake.log() as Array<{ argv: unknown[] }>;
	assert.deepEqual(log[0]?.argv.slice(0, 7), ["agent", "start", "codex-worker", "--kind", "codex", "--pane", "w2:p1"]);
	assert.deepEqual(log[1]?.argv, ["agent", "send-keys", "codex-worker", "ctrl+c"]);
	assert.equal(log.filter((entry) => entry.argv[1] === "send-keys").length, 1);
});

test("stable Herdr errors map to categorical codes without echoing payload", async (t) => {
	const contract = await loadContract();
	const fake = await fakeExec(t, { version: "herdr 0.8.2", promptError: "agent_prompt_stalled" });
	const client = new HerdrClient({ exec: fake.exec, env: env(), contract });
	const stalled = await client.promptAgent({
		target: "codex-worker",
		text: "PLAN",
		mode: "delegate-return",
		timeoutMs: HARD_LIMITS.minWaitMs,
	});
	assert.equal(stalled.ok, false);
	if (!stalled.ok) {
		assert.equal(stalled.code, "agent_prompt_stalled");
		assert.doesNotMatch(stalled.message, /PLAN/);
		assert.doesNotMatch(stalled.message, /agent_prompt_stalled/);
	}
});

test("raw recent-unwrapped output is bounded and return syntax remains envelope-owned", async (t) => {
	const contract = await loadContract();
	const fake = await fakeExec(t, { version: "herdr 0.8.2", readText: "not-a-return-envelope" });
	const client = new HerdrClient({ exec: fake.exec, env: env(), contract });
	const read = await client.readRecentUnwrapped("codex-worker");
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.value.text, "not-a-return-envelope");

	const oversizedText = Array.from({ length: HARD_LIMITS.maxReturnLines + 60 }, (_, index) => `${index}:` + "x".repeat(200)).join("\n");
	const oversized = await fakeExec(t, { version: "herdr 0.8.2", readText: oversizedText });
	const bounded = await new HerdrClient({ exec: oversized.exec, env: env(), contract }).readRecentUnwrapped("codex-worker");
	assert.equal(bounded.ok, true);
	if (bounded.ok) {
		assert.ok(Buffer.byteLength(bounded.value.text, "utf8") <= HARD_LIMITS.maxReturnEnvelopeBytes);
		assert.ok(bounded.value.text.split("\n").length <= HARD_LIMITS.maxReturnLines);
	}

	const failed = await fakeExec(t, { version: "herdr 0.8.2", readError: "agent_not_found" });
	const readFailure = await new HerdrClient({ exec: failed.exec, env: env(), contract }).readRecentUnwrapped("codex-worker");
	assert.equal(readFailure.ok, false);
	if (!readFailure.ok) assert.equal(readFailure.code, "agent_not_found");
	assert.equal(decodeAgentInfo({ pane_id: "w2:p1" }, contract.agentInfoRequired), undefined);
});

test("wait and interrupt success envelopes are decoded strictly", async (t) => {
	const contract = await loadContract();
	const validWait = await fakeExec(t, { version: "herdr 0.8.2", waitStatus: "done" });
	const validWaitClient = new HerdrClient({ exec: validWait.exec, env: env(), contract });
	const settled = await validWaitClient.waitAgent({ target: "codex-worker", timeoutMs: HARD_LIMITS.minWaitMs });
	assert.deepEqual(settled, { ok: true, value: { status: "done" } });

	const malformedWait = await fakeExec(t, { version: "herdr 0.8.2", malformedWait: true });
	const waitClient = new HerdrClient({ exec: malformedWait.exec, env: env(), contract });
	const waited = await waitClient.waitAgent({ target: "codex-worker", timeoutMs: HARD_LIMITS.minWaitMs });
	assert.equal(waited.ok, false);
	if (!waited.ok) assert.equal(waited.code, "herdr_protocol_error");

	const unexpectedInterrupt = await fakeExec(t, { version: "herdr 0.8.2", interrupt: "unexpected" });
	const interruptClient = new HerdrClient({ exec: unexpectedInterrupt.exec, env: env(), contract });
	const interrupted = await interruptClient.sendInterrupt("codex-worker");
	assert.equal(interrupted.ok, false);
	if (!interrupted.ok) assert.equal(interrupted.code, "herdr_protocol_error");
});

test("worktree create returns linked-worktree identity", async (t) => {
	const contract = await loadContract();
	const fake = await fakeExec(t, { version: "herdr 0.8.2", worktreePath: "/tmp/linked", repoRoot: "/tmp/repo.git" });
	const client = new HerdrClient({ exec: fake.exec, env: env(), contract });
	const created = await client.createLinkedWorktree({ cwd: "/tmp/repo", base: "HEAD" });
	assert.equal(created.ok, true);
	if (!created.ok) return;
	assert.equal(created.value.isLinkedWorktree, true);
	assert.equal(created.value.checkoutPath, "/tmp/linked");
	const log = await fake.log() as Array<{ argv: unknown[] }>;
	assert.deepEqual(log[0]?.argv, ["worktree", "create", "--cwd", "/tmp/repo", "--no-focus", "--base", "HEAD"]);
});
