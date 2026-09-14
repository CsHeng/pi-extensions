import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cc = join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("installed Pi and CC: one working writer preserves fast tokens and slow durations", { timeout: 40_000 }, async t => {
	try { await access(cc); await access("/usr/bin/script"); } catch {
		t.skip("requires installed CC and util-linux script; no installation performed"); return;
	}
	if (spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5_000 }).status !== 0) {
		t.skip("requires installed Pi"); return;
	}
	const base = await mkdtemp(join(tmpdir(), "work-timing-tui-"));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	// CC's optional working-message writer must not co-own this row.
	await writeFile(join(agent, "claude-code-style.json"), JSON.stringify({ enableWorkingMessage: false, showStartupHeader: false,
		enableSessionReference: false, enableSubagentAutocomplete: false, enableAgentSummary: false }));
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve",
		"-e", join(root, "extensions/work-timing/index.ts"), "-e", cc, "-e", join(root, "tests/fixtures/work-timing-tui.ts"),
		"--model", "working-fixture/fixture", "--thinking", "off", "--tui-mode", "fullscreen", "--", "working fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `stty cols 160 rows 40; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true,
		env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" },
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
			if (child.exitCode === null && child.signalCode === null) {
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
			}
		}
		await rm(base, { recursive: true, force: true });
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const exitCode = await Promise.race([exited, new Promise<"timeout">(resolve => { timeout = setTimeout(() => resolve("timeout"), 25_000); })]);
	clearTimeout(timeout);
	assert.equal(exitCode, 0, "offline installed-host fixture must finish");
	assert.ok(output.includes("Working...") && output.includes("ΣR"), "custom working line must reach the real terminal");
	const writes = JSON.parse(await readFile(join(agent, "working-writes.json"), "utf8")) as Array<{ at: number; text?: string }>;
	assert.equal(writes.at(-1)?.text, undefined, "settlement restores the host default");
	const lines = writes.filter((item): item is { at: number; text: string } => typeof item.text === "string");
	assert.ok(lines.length > 10, "stream refreshes must not be limited to 1 Hz");
	const duration = (text: string) => /^Working\.\.\. (.*?) •.* • R (.*?) \/ ΣR ([^•]*?)(?: •|$)/.exec(text);
	for (const line of lines) assert.match(line.text, /^Working\.\.\. .* • R .* \/ ΣR /, "every writer uses the complete format");
	assert.ok(lines.some((line, index) => {
		const previous = lines[index - 1];
		if (!previous || line.at - previous.at >= 900) return false;
		const a = duration(previous.text); const b = duration(line.text);
		return a && b && a.slice(1).join("|") === b.slice(1).join("|") && previous.text !== line.text;
	}), "fast counters refresh between slow clock samples without replacing the template");
	assert.ok(lines.some(line => /ΣR [12]s/.test(line.text)), "slow reasoning clock must also advance");
	// The real bash tool runs `sleep 7`, so the live tool field must appear past its threshold and then vanish.
	const toolLines = lines.filter(line => line.text.includes("$ bash "));
	assert.ok(toolLines.length > 0, "the live tool timer must reach the real terminal while bash runs");
	assert.ok(toolLines.some(line => {
		const match = / \$ bash (\d+)s/.exec(line.text);
		return match !== null && Number(match[1]) >= 5;
	}), "the tool field appears once its threshold passes");
	const lastToolLine = lines.findLastIndex(line => line.text.includes("$ bash "));
	assert.ok(lines.slice(lastToolLine + 1).some(line => !line.text.includes("$ bash ")), "the tool field disappears when the tool ends");
});
