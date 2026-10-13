import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installedHostEnvironment } from "../scripts/installed-host-env.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostEnv = installedHostEnvironment();

/** Real installed Pi lifecycle: the parent's internal custom wake must not reach the hook. */
test("installed Pi: only a user run reaches the Bark hook, not an internal custom wake", { timeout: 30_000 }, async (t) => {
	if (spawnSync("pi", ["--version"], { env: hostEnv, encoding: "utf8", timeout: 5000 }).status !== 0) {
		t.skip("requires installed Pi; no installation performed"); return;
	}
	const base = await mkdtemp(join(tmpdir(), "agent-bark-installed-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	const hookDirectory = join(base, ".local", "bin");
	await mkdir(hookDirectory, { recursive: true });
	await writeFile(join(hookDirectory, "agent-bark-hook"), `#!/bin/sh
set -eu
[ "$1" = pi ]
cat >> "$HOME/bark-events.jsonl"
printf '\\n' >> "$HOME/bark-events.jsonl"
`, { mode: 0o700 });

	// The minimal environment is deliberate: a worker that is itself a managed child must not
	// leak CSHENG_SUBAGENT_CHILD into this simulated parent session.
	const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "--approve",
		"-e", join(root, "extensions", "agent-bark.ts"),
		"-e", join(root, "tests/fixtures/agent-bark/custom-wake.ts"),
		"--model", "agent-bark-fixture/fixture", "--thinking", "off"], {
		cwd: base, env: { PATH: hostEnv.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "dumb" },
	});
	let bytes = 0;
	let extensionError = false;
	let pending = "";
	const events: unknown[] = [];
	child.stdout.on("data", (data: Buffer) => {
		bytes += data.length;
		if (bytes > 1024 * 1024) { child.kill("SIGTERM"); return; }
		pending += data.toString();
		let boundary: number;
		while ((boundary = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
			try {
				const event = JSON.parse(line);
				if (event.type === "extension_error") extensionError = true;
				if (event.type !== "message_update") {
					events.push({ type: event.type, success: event.success, role: event.message?.role, stop: event.message?.stopReason });
					if (events.length > 30) events.shift();
				}
			} catch { /* startup text is not protocol */ }
		}
	});
	child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 1024 * 1024) child.kill("SIGTERM"); });
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
	t.after(async () => {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.catch(() => {});
		await rm(base, { recursive: true, force: true });
	});
	child.stdin.write(`${JSON.stringify({ id: "fixture", type: "prompt", message: "user prompt" })}\n`);
	const exitCode = await exited;
	if (exitCode !== 0) {
		t.diagnostic(JSON.stringify(events));
		try { t.diagnostic(await readFile(join(agent, "agent-bark-proof.json"), "utf8")); } catch { /* no fixture proof */ }
	}
	assert.equal(exitCode, 0, "offline installed-host Bark fixture must settle and shut down cleanly");
	assert.equal(extensionError, false);
	// Both runs ran: the RPC user run and the idle custom-triggered wake.
	assert.deepEqual(JSON.parse(await readFile(join(agent, "agent-bark-proof.json"), "utf8")), { calls: 2, settled: 2, starts: ["user", "custom"] });
	const barkEvents = (await readFile(join(base, "bark-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(barkEvents.map(event => event.hook_event_name), ["UserPromptSubmit", "Stop"]);
	assert.equal(barkEvents[1].last_assistant_message, "user run reply");
});
