import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} from "../extensions/herdr-handoff/contracts.ts";
import { HerdrClient, type ExecResult, type HerdrContract, type HerdrExec } from "../extensions/herdr-handoff/herdr-client.ts";

const SCRIPT = new URL("../scripts/run-installed-herdr-handoff-probe.sh", import.meta.url).pathname;

test("installed probe distinguishes the herdr-handoff package from extension-off", async (t) => {
	const shimRoot = await mkdtemp(join(tmpdir(), "herdr-handoff-pi-shim-"));
	t.after(async () => rm(shimRoot, { recursive: true, force: true }));
	const shim = join(shimRoot, "pi");
	await writeFile(shim, `#!/usr/bin/env bash
set -euo pipefail
instance=1
for argument in "$@"; do
	if [[ $argument == --no-extensions ]]; then instance=0; fi
done
if [[ $instance == 1 ]]; then
	printf '%s\\n' \\
		'{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"herdr-handoff"}]}}' \\
		'{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-herdr-handoff-probe","data":{"present":true}}]}}'
else
	printf '%s\\n' '{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"custom","customType":"csheng-herdr-handoff-probe","data":{"present":false}}]}}'
fi
`);
	await chmod(shim, 0o700);
	const result = spawnSync("bash", [SCRIPT], {
		encoding: "utf8",
		env: { PATH: `${shimRoot}:${process.env.PATH ?? ""}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		result: "pass",
		source: "installed",
		tool: 1,
		command: 1,
		extension_off_tool: 0,
		fixture: 1,
	});
});

test("offline fake-herdr delegate-return fixture stays redacted", async (t) => {
	const exec = promisify(execFile);
	const fakePath = new URL("./fixtures/herdr/fake-herdr.mjs", import.meta.url).pathname;
	const contract = JSON.parse(await readFile(new URL("./fixtures/herdr/herdr-0.8.2-contract.json", import.meta.url), "utf8")) as HerdrContract;
	const parent = await mkdtemp(join(tmpdir(), "herdr-probe-git-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	await exec("git", ["init", "-q", parent]);
	await exec("git", ["-C", parent, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", parent, "config", "user.name", "test"]);
	await writeFile(join(parent, "src.ts"), "base\n");
	await exec("git", ["-C", parent, "add", "src.ts"]);
	await exec("git", ["-C", parent, "commit", "-qm", "init"]);
	const recipient = await mkdtemp(join(tmpdir(), "herdr-probe-wt-"));
	t.after(async () => {
		await exec("git", ["-C", parent, "worktree", "remove", "--force", recipient]).catch(() => undefined);
		await rm(recipient, { recursive: true, force: true });
	});
	await rm(recipient, { recursive: true, force: true });
	await exec("git", ["-C", parent, "worktree", "add", "-q", recipient, "HEAD"]);

	const fakeDir = await mkdtemp(join(tmpdir(), "herdr-probe-fake-"));
	t.after(async () => rm(fakeDir, { recursive: true, force: true }));
	await writeFile(join(fakeDir, "scenario.json"), JSON.stringify({
		version: "herdr 0.8.2",
		agent: {
			name: "codex-worker",
			kind: "codex",
			status: "idle",
			pane_id: "w2:p1",
			workspace_id: "w2",
			tab_id: "w2:t1",
			cwd: recipient,
			session: { source: "test", agent: "codex", kind: "id", value: "sess-1" },
		},
		promptStatus: "idle",
		readText: `${RETURN_START_SENTINEL}\n${JSON.stringify({
			protocol: HANDOFF_RETURN_PROTOCOL,
			handoff_id: "hid-1",
			outcome: "implemented",
			summary: "claimed",
			changed_paths: ["src.ts"],
			verification: [{ check: "test", status: "passed", evidence: "ok" }],
			questions: [],
			risks: [],
		})}\n${RETURN_END_SENTINEL}\n`,
	}));
	await writeFile(join(fakeDir, "commands.jsonl"), "");
	const run: HerdrExec = (command, args, runOptions) => new Promise((resolve, reject) => {
		assert.equal(command, "herdr");
		const child = spawn(process.execPath, [fakePath, ...args], {
			env: { ...process.env, HERDR_FAKE_DIR: fakeDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		const timer = runOptions?.timeout === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), runOptions.timeout);
		runOptions?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
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
	const execWithMutation: HerdrExec = async (command, args, runOptions) => {
		const executed = await run(command, args, runOptions);
		if (args[1] === "prompt" && executed.code === 0) await writeFile(join(recipient, "src.ts"), "changed\n");
		return executed;
	};
	const client = new HerdrClient({
		exec: execWithMutation,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
		contract,
	});
	const coord = new HandoffCoordinator({
		client,
		loadLaunchConfig,
		now: () => 1,
		createHandoffId: () => "hid-1",
	});
	const result = await coord.dispatch({
		action: "begin",
		mode: "delegate-return",
		target: { type: "message-existing", target: "codex-worker", kind: "codex" },
		request: {
			objective: "Implement the bounded change",
			plan: { source: "inline", text: "Change only src.ts." },
			allowedWrites: ["src.ts"],
			nonGoals: ["Do not commit"],
			verification: ["focused test"],
		},
		waitTimeoutMs: HARD_LIMITS.minWaitMs,
	}, { cwd: parent, trusted: true });
	assert.equal(result.bridgeStatus, "returned");
	assert.equal(result.workspaceStatus, "within_declared_writes");
	const serialized = JSON.stringify(result);
	assert.doesNotMatch(serialized, /SECRET/);
	assert.doesNotMatch(serialized, /--secret/);
	const log = (await readFile(join(fakeDir, "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: unknown[] });
	assert.equal(log.filter((entry) => entry.argv[1] === "prompt").length, 1);
	assert.equal(log.filter((entry) => entry.argv[1] === "read").length, 1);
});
