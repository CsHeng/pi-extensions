import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("installed Pi RPC preserves completion prefixes across busy/idle delivery and resume", { timeout: 60_000 }, async t => {
	assert.equal(spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 }).status, 0, "requires installed Pi; no installation or live provider used");
	const base = await mkdtemp(join(tmpdir(), "notifications-installed-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	t.after(() => rm(base, { recursive: true, force: true }));
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	const session = join(base, "session.jsonl");
	async function run(phase: "initial" | "resume") {
		const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--session", session, "--approve",
			"-e", join(root, "extensions/notices/index.ts"), "-e", join(root, "tests/fixtures/tasklist/installed-notification-continuity.ts"),
			"--model", "notification-fixture/fixture", "--thinking", "off"], {
			cwd: base, env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "dumb", NOTIFICATION_FIXTURE_PHASE: phase },
		});
		let bytes = 0;
		let pending = "";
		let settlements = 0;
		let errors = 0;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
		const deadline = setTimeout(() => child.kill("SIGKILL"), 25_000);
		child.stdout.on("data", (data: Buffer) => {
			bytes += data.length;
			if (bytes > 2 * 1024 * 1024) { child.kill("SIGTERM"); return; }
			pending += data.toString();
			let boundary: number;
			while ((boundary = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
				try {
					const event = JSON.parse(line);
					if (event.type === "extension_error" || event.type === "response" && event.success === false) errors++;
					if (event.type === "agent_settled") {
						settlements++;
						if (settlements >= (phase === "initial" ? 2 : 1) && !closeTimer) closeTimer = setTimeout(() => child.stdin.end(), 150);
					}
				} catch { /* ignore non-protocol startup text */ }
			}
		});
		child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 2 * 1024 * 1024) child.kill("SIGTERM"); });
		try {
			child.stdin.write(`${JSON.stringify({ id: phase, type: "prompt", message: "exercise immutable completion history" })}\n`);
			assert.equal(await exited, 0, "offline CLI must settle and exit without timeout");
			assert.equal(errors, 0, "no extension/protocol errors");
			return JSON.parse(await readFile(join(agent, `notification-${phase}.json`), "utf8"));
		} finally {
			clearTimeout(deadline);
			if (closeTimer) clearTimeout(closeTimer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited.catch(() => {});
		}
	}
	assert.deepEqual(await run("initial"), { calls: 6, settled: 2, prefixes: 5, noticeCounts: [0, 1, 1, 1, 2, 2], nativeNotices: 2, acknowledgments: ["first", "second"] });
	assert.deepEqual(await run("resume"), { calls: 2, settled: 1, prefixes: 1, noticeCounts: [2, 2], nativeNotices: 2, acknowledgments: ["first", "second"] });
});
