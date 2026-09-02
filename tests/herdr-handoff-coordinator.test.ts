import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadLaunchConfig } from "../extensions/herdr-handoff/config.ts";
import { HandoffCoordinator } from "../extensions/herdr-handoff/coordinator.ts";
import {
	HANDOFF_RETURN_PROTOCOL,
	HARD_LIMITS,
	RETURN_END_SENTINEL,
	RETURN_START_SENTINEL,
	type BeginHandoffInput,
} from "../extensions/herdr-handoff/contracts.ts";
import { HerdrClient, type ExecResult, type HerdrContract, type HerdrExec } from "../extensions/herdr-handoff/herdr-client.ts";

const exec = promisify(execFile);
const FAKE = new URL("./fixtures/herdr/fake-herdr.mjs", import.meta.url).pathname;
const CONTRACT_PATH = new URL("./fixtures/herdr/herdr-0.8.2-contract.json", import.meta.url).pathname;

async function loadContract(): Promise<HerdrContract> {
	const { readFile } = await import("node:fs/promises");
	return JSON.parse(await readFile(CONTRACT_PATH, "utf8")) as HerdrContract;
}

async function git(cwd: string, args: string[]): Promise<void> {
	await exec("git", ["-C", cwd, ...args]);
}

async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "herdr-coord-git-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q", root]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "test"]);
	await writeFile(join(root, "src.ts"), "base\n");
	await git(root, ["add", "src.ts"]);
	await git(root, ["commit", "-qm", "init"]);
	return root;
}

async function linkedWorktree(t: test.TestContext, root: string): Promise<string> {
	const dest = await mkdtemp(join(tmpdir(), "herdr-coord-wt-"));
	t.after(async () => {
		await exec("git", ["-C", root, "worktree", "remove", "--force", dest]).catch(() => undefined);
		await rm(dest, { recursive: true, force: true });
	});
	await rm(dest, { recursive: true, force: true });
	await exec("git", ["-C", root, "worktree", "add", "-q", dest, "HEAD"]);
	return dest;
}

async function fakeExec(t: test.TestContext, scenario: Record<string, unknown>): Promise<{ exec: HerdrExec; dir: string; log(): Promise<Array<{ argv: unknown[] }>> }> {
	const dir = await mkdtemp(join(tmpdir(), "herdr-coord-fake-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "scenario.json"), JSON.stringify(scenario));
	await writeFile(join(dir, "commands.jsonl"), "");
	const execFn: HerdrExec = (command, args, options) => new Promise((resolve, reject) => {
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
		exec: execFn,
		dir,
		async log() {
			const { readFile } = await import("node:fs/promises");
			const text = await readFile(join(dir, "commands.jsonl"), "utf8");
			return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line) as { argv: unknown[] });
		},
	};
}

function envelope(handoffId: string, changed = ["src.ts"]) {
	return `${RETURN_START_SENTINEL}\n${JSON.stringify({
		protocol: HANDOFF_RETURN_PROTOCOL,
		handoff_id: handoffId,
		outcome: "implemented",
		summary: "claimed",
		changed_paths: changed,
		verification: [{ check: "test", status: "passed", evidence: "ok" }],
		questions: [],
		risks: [],
	})}\n${RETURN_END_SENTINEL}\n`;
}

function beginInput(target: string, mode: BeginHandoffInput["mode"] = "delegate-return"): BeginHandoffInput {
	return {
		action: "begin",
		mode,
		target: { type: "message-existing", target, kind: "codex" },
		request: {
			objective: "Implement the bounded change",
			plan: { source: "inline", text: "Change only src.ts." },
			allowedWrites: ["src.ts"],
			nonGoals: ["Do not commit"],
			verification: ["focused test"],
		},
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	};
}

async function coordinator(t: test.TestContext, recipientCwd: string, scenario: Record<string, unknown> = {}, mutate?: () => Promise<void>) {
	const contract = await loadContract();
	const fake = await fakeExec(t, {
		version: "herdr 0.8.2",
		agent: {
			name: "codex-worker",
			kind: "codex",
			status: "idle",
			pane_id: "w2:p1",
			workspace_id: "w2",
			tab_id: "w2:t1",
			cwd: recipientCwd,
			session: { source: "test", agent: "codex", kind: "id", value: "sess-1" },
		},
		promptStatus: "idle",
		readText: envelope("hid-1"),
		...scenario,
	});
	const execWithMutation: HerdrExec = async (command, args, options) => {
		const result = await fake.exec(command, args, options);
		if (mutate && args[1] === "prompt" && result.code === 0) await mutate();
		return result;
	};
	const client = new HerdrClient({
		exec: execWithMutation,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
		contract,
	});
	const coord = new HandoffCoordinator({
		client,
		loadLaunchConfig,
		now: () => 1_000,
		createHandoffId: () => "hid-1",
	});
	return { coord, fake, client };
}

test("existing isolated delegate-return returns an unverified implemented claim", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const { coord, fake } = await coordinator(t, recipient, {}, async () => {
		await writeFile(join(recipient, "src.ts"), "changed\n");
	});
	const result = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	assert.equal(result.bridgeStatus, "returned");
	assert.equal(result.agentOutcome, "implemented");
	assert.equal(result.workspaceStatus, "within_declared_writes");
	assert.equal(result.error, undefined);
	assert.ok(result.handle);
	const log = await fake.log();
	assert.deepEqual(log.map((entry) => entry.argv.slice(0, 2)), [
		["--version"],
		["agent", "get"],
		["agent", "prompt"],
		["agent", "get"],
		["agent", "read"],
	]);
});

test("raw read without a correlated return is classified by envelope parsing", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const { coord, fake } = await coordinator(t, recipient, { readText: "settled without an envelope" }, async () => {
		await writeFile(join(recipient, "src.ts"), "changed\n");
	});
	const result = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	assert.equal(result.error?.code, "malformed_return");
	assert.equal(result.bridgeStatus, "failed");
	const log = await fake.log();
	assert.deepEqual(log.slice(-3).map((entry) => entry.argv.slice(0, 2)), [
		["agent", "prompt"],
		["agent", "get"],
		["agent", "read"],
	]);
});

test("repository-relative plan files resolve from the Git root when Pi cwd is nested", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	await mkdir(join(root, "nested"));
	await mkdir(join(root, "docs"));
	await writeFile(join(root, "docs", "plan.md"), "Change only src.ts.\n");
	const { coord } = await coordinator(t, recipient, {}, async () => {
		await writeFile(join(recipient, "src.ts"), "changed\n");
	});
	const input = beginInput("codex-worker");
	input.request.plan = { source: "file", path: "docs/plan.md" };
	const result = await coord.dispatch(input, { cwd: join(root, "nested"), trusted: true });
	assert.equal(result.bridgeStatus, "returned");
	assert.equal(result.workspaceStatus, "within_declared_writes");
});

test("continuation preserves the original baseline and refuses concurrent outside drift", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const { coord, fake } = await coordinator(t, recipient, {}, async () => {
		await writeFile(join(recipient, "src.ts"), "changed\n");
	});
	const first = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	assert.equal(first.bridgeStatus, "returned");
	await writeFile(join(recipient, "outside.ts"), "concurrent\n");
	const continued = await coord.dispatch({
		action: "continue",
		handle: first.handle?.token as string,
		intent: "repair",
		message: "Repair the bounded change.",
	}, { cwd: root, trusted: true });
	assert.equal(continued.error?.code, "scope_violation");
	assert.equal(continued.workspaceStatus, "scope_violation");
	const log = await fake.log();
	assert.equal(log.filter((entry) => entry.argv[1] === "prompt").length, 1);
});

test("start-and-ask revalidates the live started target before prompt delivery", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const contract = await loadContract();
	const commonAgent = {
		name: "hhid1",
		kind: "codex",
		status: "idle",
		pane_id: "w2:p1",
		workspace_id: "w2",
		tab_id: "w2:t1",
		cwd: recipient,
	};
	const fake = await fakeExec(t, {
		version: "herdr 0.8.2",
		worktreePath: recipient,
		startedAgent: { ...commonAgent, session: { kind: "id", value: "started" } },
		agent: { ...commonAgent, session: { kind: "id", value: "replacement" } },
	});
	const client = new HerdrClient({
		exec: fake.exec,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
		contract,
	});
	const coord = new HandoffCoordinator({
		client,
		loadLaunchConfig: async () => ({
			ok: true,
			config: { missing: false, profiles: { deep: { kind: "codex", args: [] } } },
		}),
		now: () => 1_000,
		createHandoffId: () => "hid-1",
	});
	const input = beginInput("unused");
	input.target = { type: "start-and-ask", profileId: "deep" };
	const result = await coord.dispatch(input, { cwd: root, trusted: true });
	assert.equal(result.error?.code, "stale_handle");
	const log = await fake.log();
	assert.equal(log.filter((entry) => entry.argv[1] === "prompt").length, 0);
});

test("transfer returns after working and does not read or inspect", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const { coord, fake } = await coordinator(t, recipient, { promptStatus: "working" });
	const result = await coord.dispatch(beginInput("codex-worker", "transfer"), { cwd: root, trusted: true });
	assert.equal(result.bridgeStatus, "transferred");
	assert.equal(result.workspaceStatus, "not_inspected");
	assert.equal(result.agentOutcome, undefined);
	const log = await fake.log();
	assert.equal(log.some((entry) => entry.argv[1] === "read"), false);
	assert.equal((await coord.dispatch({
		action: "continue",
		handle: result.handle?.token ?? "",
		intent: "repair",
		message: "fix",
	}, { cwd: root, trusted: true })).error?.code, "ownership_transferred");
});

test("parent checkout is rejected for both modes", async (t) => {
	const root = await repository(t);
	const { coord } = await coordinator(t, root);
	const delegate = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	assert.equal(delegate.error?.code, "workspace_mismatch");
	const transfer = await coord.dispatch(beginInput("codex-worker", "transfer"), { cwd: root, trusted: true });
	assert.equal(transfer.error?.code, "workspace_mismatch");
});

test("timeout then one recovery wait succeeds; a second wait is rejected", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	const { coord, fake } = await coordinator(t, recipient, { promptError: "timeout" });
	const timed = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	assert.equal(timed.bridgeStatus, "timed_out");
	assert.ok(timed.handle);
	const recovered = await coord.dispatch({
		action: "wait",
		handle: timed.handle?.token as string,
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	}, { cwd: root, trusted: true });
	assert.ok(["returned", "failed", "timed_out"].includes(recovered.bridgeStatus));
	const recoveryLog = await fake.log();
	assert.deepEqual(recoveryLog.slice(-4).map((entry) => entry.argv.slice(0, 2)), [
		["agent", "get"],
		["agent", "wait"],
		["agent", "get"],
		["agent", "read"],
	]);
	const second = await coord.dispatch({
		action: "wait",
		handle: timed.handle?.token as string,
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	}, { cwd: root, trusted: true });
	assert.equal(second.error?.code, "continuation_budget_exhausted");
});

test("one clarification is allowed and a duplicate intent is rejected", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	await writeFile(join(recipient, "src.ts"), "changed\n");
	const { coord } = await coordinator(t, recipient);
	const first = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	assert.equal(first.bridgeStatus, "returned");
	const continued = await coord.dispatch({
		action: "continue",
		handle: first.handle?.token as string,
		intent: "clarification",
		message: "Use the frozen plan.",
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	}, { cwd: root, trusted: true });
	assert.ok(continued.handle);
	const duplicate = await coord.dispatch({
		action: "continue",
		handle: first.handle?.token as string,
		intent: "clarification",
		message: "again",
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	}, { cwd: root, trusted: true });
	assert.equal(duplicate.error?.code, "continuation_budget_exhausted");
});

test("cancel revalidates identity and skips input on mismatch", async (t) => {
	const root = await repository(t);
	const recipient = await linkedWorktree(t, root);
	await writeFile(join(recipient, "src.ts"), "changed\n");
	const { coord, fake } = await coordinator(t, recipient);
	const first = await coord.dispatch(beginInput("codex-worker"), { cwd: root, trusted: true });
	await writeFile(join(fake.dir, "scenario.json"), JSON.stringify({
		version: "herdr 0.8.2",
		agent: {
			name: "codex-worker",
			kind: "pi",
			status: "idle",
			pane_id: "w9:p9",
			workspace_id: "w9",
			tab_id: "w9:t1",
			cwd: recipient,
			session: { source: "test", agent: "pi", kind: "id", value: "other" },
		},
	}));
	const cancelled = await coord.dispatch({ action: "cancel", handle: first.handle?.token as string }, { cwd: root, trusted: true });
	assert.equal(cancelled.error?.code, "stale_handle");
	const log = await fake.log();
	assert.equal(log.some((entry) => entry.argv[1] === "send-keys"), false);
});
