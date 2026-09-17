import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("installed Pi RPC: actual co-loaded public command waiter produces one bounded continuation", { timeout: 30_000 }, async (t) => {
	if (spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 }).status !== 0) {
		t.skip("requires installed Pi; no installation performed"); return;
	}
	const base = await mkdtemp(join(tmpdir(), "workflow-installed-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	const extensions = ["workflow", "subagents", "subagents-ui", "work-timing", "status-footer"];
	const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "--approve",
		...extensions.flatMap((name) => ["-e", join(root, "extensions", name, "index.ts")]),
		"-e", join(root, "tests/fixtures/workflow/installed-continuation.ts"), "--model", "workflow-installed-fixture/fixture", "--thinking", "off"], {
		cwd: base, env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "dumb" },
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
					events.push({ type: event.type, command: event.command, success: event.success, role: event.message?.role, stop: event.message?.stopReason, code: event.result?.details?.code, alignment: event.result?.details?.workflow?.workset?.alignment });
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
	child.stdin.write(`${JSON.stringify({ id: "fixture", type: "prompt", message: "enroll and continue the fixture" })}\n`);
	const exitCode = await exited;
	if (exitCode !== 0) {
		t.diagnostic(JSON.stringify(events));
		try { t.diagnostic(await readFile(join(agent, "continuation-proof.json"), "utf8")); } catch { /* no fixture proof */ }
	}
	assert.equal(exitCode, 0, "offline installed-host continuation must settle and shut down cleanly");
	assert.equal(extensionError, false);
	const proof = JSON.parse(await readFile(join(agent, "continuation-proof.json"), "utf8"));
	assert.deepEqual(proof, { calls: 4, settled: 2, starts: [0, 1], sources: ["rpc", "extension"], disposition: "paused", used: 1,
		facts: [{ mode: "rpc", trusted: true, signal: true, idle: false }, { mode: "rpc", trusted: true, signal: true, idle: false }],
	});
});
