import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cc = join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ["on", "compact"]) test(`installed Pi and real CC ${mode}: floating observer survives replaced tool cards`, { timeout: 35_000 }, async t => {
	try { await access(cc); await access("/usr/bin/script"); } catch { t.skip("requires installed CC and util-linux script; no package installation performed"); return; }
	const base = await mkdtemp(join(tmpdir(), "observer-cc-tui-"));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	await writeFile(join(agent, "claude-code-style.json"), JSON.stringify({ mode, showStartupHeader: false, enableWorkingMessage: false, enableSessionReference: false, enableSubagentAutocomplete: false }));
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve",
		"-e", join(root, "extensions/subagents-ui/index.ts"), "-e", cc,
		"-e", join(root, "tests/fixtures/subagents-observer-tui.ts"), "--model", "observer-fixture/fixture", "--thinking", "off", "--", "observer fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `set -eu; stty cols 160 rows 40; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true,
		env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
	});
	let output = "";
	const capture = (data: Buffer) => {
		output += data.toString();
		if (output.length > 1024 * 1024) { child.kill("SIGTERM"); return; }
		if (data.toString().includes("\u001b[6n")) child.stdin.write("\u001b[1;1R");
	};
	child.stdout.on("data", capture); child.stderr.on("data", capture);
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null && child.pid) {
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
			await Promise.race([exited.catch(() => {}), delay(500)]);
			if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		}
		await rm(base, { recursive: true, force: true });
	});
	const waitFor = async (predicate: () => Promise<boolean> | boolean, label: string) => {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) { if (await predicate()) return; if (child.exitCode !== null) break; await delay(50); }
		// Save bounded synthetic-only diagnostics outside the repository; never dump user state.
		await writeFile(join(tmpdir(), `observer-cc-${mode}-failure.log`), output);
		assert.fail(`CC ${mode}: ${label}; synthetic terminal log retained in tmp`);
	};
	await waitFor(async () => { try { return (await readFile(join(agent, "observer-ready"), "utf8")) === "ready"; } catch { return false; } }, "fixture tool did not start");
	await delay(300);
	child.stdin.write("\u001b\u0006"); // Alt+Ctrl+F, the registered shortcut.
	await waitFor(() => output.includes("Subagents") && output.includes("1 running"), "real floating observer not visible");
	await waitFor(() => output.includes("1 finished") && output.includes("8 turns"), "observer did not update to settled work");
	child.stdin.write("\r"); // Enter expands the folded settled group; routes are tertiary detail.
	await waitFor(() => output.includes("OBSERVER_MODEL") && output.includes("thinking:high"), "folded settled route not revealed by enter");
	assert.ok(output.includes("1 running"));
	assert.equal(output.includes("CC_HIDDEN_LIVE_MARKER"), false, "CC must really replace/hide the partial tool card in this oracle");
	child.stdin.write("\u001b\u0006"); // Alt+Ctrl+F toggles the observer closed.
	await delay(200); child.stdin.write("/quit\r");
	await waitFor(() => child.exitCode !== null, "host did not shut down after toggling the observer closed");
	assert.equal(await exited, 0);
});
