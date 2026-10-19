import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("installed Pi RPC: active task list awaiting design confirmation does not start another turn", { timeout: 30_000 }, async (t) => {
	if (spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 }).status !== 0) {
		t.skip("requires installed Pi; no installation performed"); return;
	}
	const base = await mkdtemp(join(tmpdir(), "workflow-installed-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	const extensions = ["workflow", "subagents", "loop-notifications", "subagents-ui", "work-timing", "status-footer"];
	const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "--approve",
		...extensions.flatMap((name) => ["-e", join(root, "extensions", name, "index.ts")]),
		"-e", join(root, "tests/fixtures/workflow/installed-continuation.ts"), "--model", "workflow-installed-fixture/fixture", "--thinking", "off"], {
		cwd: base, env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "dumb" },
	});
	let bytes = 0;
	let extensionError = false;
	let pending = "";
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
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
				// Observe beyond settlement instead of shutting down inside the hook and hiding a renewal.
				if (event.type === "agent_settled" && !closeTimer) closeTimer = setTimeout(() => child.stdin.end(), 250);
				if (event.type !== "message_update") {
					events.push({ type: event.type, command: event.command, success: event.success, role: event.message?.role, stop: event.message?.stopReason, code: event.result?.details?.code });
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
		if (closeTimer) clearTimeout(closeTimer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.catch(() => {});
		await rm(base, { recursive: true, force: true });
	});
	child.stdin.write(`${JSON.stringify({ id: "fixture", type: "prompt", message: "discuss the design and wait for confirmation" })}\n`);
	const exitCode = await exited;
	if (exitCode !== 0) {
		t.diagnostic(JSON.stringify(events));
		try { t.diagnostic(await readFile(join(agent, "continuation-proof.json"), "utf8")); } catch { /* no fixture proof */ }
	}
	assert.equal(exitCode, 0, "offline installed-host no-renewal check must settle and shut down cleanly");
	assert.equal(extensionError, false);
	const proof = JSON.parse(await readFile(join(agent, "continuation-proof.json"), "utf8"));
	assert.deepEqual(proof, { calls: 2, settled: 1, starts: [0], sources: ["rpc"], disposition: "active",
		facts: [{ mode: "rpc", trusted: true, signal: true, idle: false }],
	});
});
