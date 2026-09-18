import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = fileURLToPath(new URL("../", import.meta.url));
const cc = join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Proof {
	calls: number; stage: number; settled: number; widget: string[]; overlay: string[]; widgetWidth: number; overlayWidth: number;
	rows: number; columns: number; revision: number; generation?: number; review?: number; goal?: string; disposition?: string;
}

for (const mode of ["on", "compact"]) test(`historical v1 Pi/CC ${mode}: workflow task UI follows tools, inspection, resize and branch lifecycle`, { timeout: 65_000 }, async t => {
	try { await access(cc); await access("/usr/bin/script"); } catch { t.skip("requires installed CC and util-linux script; UI evidence remains unverified"); return; }
	if (spawnSync("pi", ["--version"], { timeout: 5_000 }).status !== 0) { t.skip("requires installed Pi; UI evidence remains unverified"); return; }
	const base = await mkdtemp(join(tmpdir(), "workflow-ui-tui-"));
	const agent = join(base, "agent"); await mkdir(agent);
	await writeFile(join(base, "basis"), "stable synthetic basis");
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	await writeFile(join(agent, "claude-code-style.json"), JSON.stringify({ mode, showStartupHeader: false, enableWorkingMessage: false,
		enableSessionReference: false, enableSubagentAutocomplete: false, enableAgentSummary: false }));
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve", "--session", join(base, "session.jsonl"),
		"-e", join(root, "tests/fixtures/workflow/ui-tui.ts"),
		"-e", join(root, "tests/fixtures/workflow/legacy-extension.ts"),
		...(["status-footer", "work-timing", "subagents-ui"].flatMap(name => ["-e", join(root, `extensions/${name}/index.ts`)])),
		"-e", cc, "--model", "workflow-ui-fixture/fixture", "--thinking", "off", "--tui-mode", "fullscreen", "--", "workflow UI fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `stty cols 160 rows 40; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true,
		env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" },
	});
	let output = "";
	const capture = (data: Buffer) => {
		output += data.toString();
		if (output.length > 2 * 1024 * 1024) { child.kill("SIGTERM"); return; }
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
	const path = (name: string) => join(agent, `workflow-ui-${name}.json`);
	const proof = async (): Promise<Proof> => JSON.parse(await readFile(path("proof"), "utf8")) as Proof;
	const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			try { if (await predicate()) return; } catch { /* fixture may be writing its next frame */ }
			if (child.exitCode !== null || child.signalCode !== null) break;
			await delay(35);
		}
		await writeFile(join(tmpdir(), `workflow-ui-${mode}-failure.log`), output);
		try { await writeFile(join(tmpdir(), `workflow-ui-${mode}-proof.json`), JSON.stringify(await proof())); } catch {}
		assert.fail(`${mode}: ${label}; bounded synthetic diagnostics retained in tmp`);
	};
	const command = async (value: string) => { child.stdin.write(`${value}\r`); await delay(120); };
	const widget = async () => (await proof()).widget.join("\n");
	const release = async (stage: number) => {
		await writeFile(path("release"), String(stage));
		await waitFor(async () => { await access(path(`result-${stage}`)); return true; }, `workflow operation ${stage} did not finish`);
		const result = JSON.parse(await readFile(path(`result-${stage}`), "utf8")) as { ok: boolean; code?: string };
		assert.equal(result.ok, true, `public workflow operation ${stage} rejected: ${result.code ?? "unknown"}`);
		await waitFor(async () => (await proof()).calls >= stage + 1, `provider did not reach pause after ${stage}`);
	};
	await waitFor(async () => (await proof()).calls === 0 || (await proof()).calls === 1, "fixture did not mount");
	assert.deepEqual((await proof()).widget, [], "no workset leaves no widget");
	await release(1);
	await waitFor(async () => (await widget()).includes("UI_TASK_01"), "open did not render task tree");
	assert.match(await widget(), /0\/25/);
	assert.ok((await proof()).widget.length <= 13, "normal widget has at most twelve content rows and spacer");
	await release(2); await waitFor(async () => /◐.*T-1/.test(await widget()), "start did not render running task");
	await release(3); await waitFor(async () => /◇.*T-1/.test(await widget()), "record did not render awaiting acceptance");
	await release(4); await waitFor(async () => /1\/25/.test(await widget()), "assess did not update accepted count");
	await release(5); await release(6);
	await waitFor(async () => /!.*T-2/.test(await widget()), "blocked task not retained in overflow");
	await release(7); await waitFor(async () => (await widget()).includes("UI_AMENDED_TASK"), "amend did not refresh task outcome");
	const baseline = await proof();
	await command("/workflow-ui");
	await waitFor(async () => !(await widget()).includes("UI_AMENDED_TASK") && (await widget()).includes("Tasks"), "collapse did not replace tree with summary");
	await command("/workflow-ui"); await waitFor(async () => (await widget()).includes("UI_AMENDED_TASK"), "expand did not restore tree");
	await command("/workflow-ui hide"); await waitFor(async () => (await proof()).widget.length === 0, "hide did not unregister widget");
	await command("/workflow-ui show"); await waitFor(async () => (await widget()).includes("UI_AMENDED_TASK"), "show did not restore widget");
	await command("/workflow-fixture-resize 80 20");
	await waitFor(async () => (await proof()).widgetWidth === 80 && (await proof()).rows === 20, "real terminal resize did not reach widget");
	const small = await proof();
	assert.ok(small.widget.length < 13, "short terminal reduces widget row budget");
	assert.ok(small.widget.every(line => visibleWidth(line) <= 80));
	await command("/workflow-ui list");
	await waitFor(async () => (await proof()).overlay.some(line => line.includes("Tasks · workflow")), "full list did not open");
	const firstPage = (await proof()).overlay.join("\n");
	child.stdin.write("\u001b[6~");
	await waitFor(async () => (await proof()).overlay.join("\n") !== firstPage, "PageDown did not scroll full list");
	for (let index = 0; index < 8; index++) { child.stdin.write("\u001b[B\u001b[6~"); await delay(40); }
	await waitFor(async () => (await proof()).overlay.some(line => line.includes("UI_TASK_25")), "full list could not reach final overflow task");
	assert.ok((await proof()).overlay.every(line => visibleWidth(line) <= (small.columns)));
	child.stdin.write("\u001b"); await waitFor(async () => (await proof()).overlay.length === 0, "Escape did not close full list");
	await command("/workflow-fixture-proof");
	const afterInspect = await proof();
	for (const key of ["revision", "generation", "review", "calls"] as const) assert.equal(afterInspect[key], baseline[key], `UI inspection changed ${key}`);
	await command("/workflow-fixture-resize 160 40"); await waitFor(async () => (await proof()).widgetWidth === 160, "wide resize did not refresh widget");
	await command("/workflow-ui list");
	await waitFor(async () => (await proof()).overlay.length > 0, "full list did not reopen");
	await release(8);
	await waitFor(async () => (await proof()).overlay.some(line => line.includes("cancelled")), "committed close did not refresh the open full list");
	child.stdin.write("\u001b"); await waitFor(async () => (await proof()).overlay.length === 0, "Escape did not close updated full list");
	await waitFor(async () => /cancelled/.test(await widget()), "close did not render truthful cancelled summary");
	await waitFor(async () => (await proof()).settled > 0, "synthetic interaction did not settle");
	assert.ok(output.includes("Tasks") && output.includes("UI_AMENDED_TASK") && output.includes("UI_TASK_25"), "UI must reach the actual PTY, not just render taps");
	await waitFor(() => output.includes("Worked for") && /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(output), "co-loaded timing and footer must still render");
	await command("/reload");
	await waitFor(async () => { await access(path("session-reload")); return /cancelled/.test(await widget()) && output.includes("Reloaded keybindings"); }, "reload did not restore closed snapshot UI");
	await delay(150);
	await command("/workflow-fixture-branch");
	await waitFor(async () => { await access(path("branch-command")); return true; }, "branch command was not received");
	await waitFor(async () => { await access(path("tree")); await access(path("branch-ready")); return (await proof()).revision === 0 && (await proof()).widget.length === 0; }, "tree replacement leaked abandoned task UI");
	await command("/workflow-fixture-new");
	await waitFor(async () => { await access(path("session-new")); return (await proof()).widget.length === 0; }, "new session leaked old task UI");
	await command("/quit"); await waitFor(() => child.exitCode !== null, "host did not quit");
	assert.equal(await exited, 0);
});
