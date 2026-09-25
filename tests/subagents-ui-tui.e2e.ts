import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Deliberate installed-host check (`bun run e2e:subagents-ui`). It spawns the real Pi fullscreen TUI,
// so it stays outside the deterministic `bun run test` lane, which owns marker geometry and close
// handling through the offline unit tests.
test("installed Pi fullscreen: clicking the observer close marker dismisses the overlay", { timeout: 40_000 }, async t => {
	try { await access("/usr/bin/script"); } catch { t.skip("requires util-linux script; no package installation performed"); return; }
	const base = await mkdtemp(join(tmpdir(), "observer-click-tui-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], tuiMode: "fullscreen" }));
	const cols = 120;
	const rows = 8;
	// Run the installed Pi, not this checkout's dev dependency: overlay pointer dispatch exists in
	// Pi 0.85 hosts, while the pinned 0.84.4 dev dependency never calls `handleMouse`.
	const installedDirs = (process.env.PATH ?? "").split(":").filter(entry => entry.length > 0 && !entry.includes("node_modules/.bin"));
	let installedPi = false;
	for (const dir of installedDirs) { try { await access(join(dir, "pi"), constants.X_OK); installedPi = true; break; } catch { /* keep searching */ } }
	if (!installedPi) { t.skip("no installed pi on PATH outside node_modules/.bin"); return; }
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve",
		"-e", join(root, "extensions/subagents-ui/index.ts"),
		"-e", join(root, "tests/fixtures/subagents-observer-tui.ts"),
		"--model", "observer-fixture/fixture", "--thinking", "off", "--", "observer fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `set -eu; stty cols ${cols} rows ${rows}; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true,
		env: { PATH: installedDirs.join(":"), HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
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
	const waitFor = async (predicate: () => Promise<boolean> | boolean, label: string, budgetMs = 15_000) => {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) { if (await predicate()) return; if (child.exitCode !== null) break; await delay(50); }
		await writeFile(join(tmpdir(), "observer-click-failure.log"), output);
		assert.fail(`${label}; synthetic terminal log retained in tmp`);
	};
	await waitFor(async () => { try { return (await readFile(join(agent, "observer-ready"), "utf8")) === "ready"; } catch { return false; } }, "fixture tool did not start");
	await delay(300);
	child.stdin.write("\u001b\u0006"); // Alt+Ctrl+F opens the floating observer.
	await waitFor(() => output.includes("Subagents"), "floating observer not visible");
	await waitFor(() => output.includes("1 finished"), "observer did not settle");
	await delay(300);
	// The marker sits in the panel's last column, so read its screen cell from the last drawn frame.
	const markerIndex = output.lastIndexOf("\u2715");
	const lineStart = markerIndex < 0 ? undefined : [...output.slice(0, markerIndex).matchAll(/\u001b\[(\d+);(\d+)H/g)].at(-1);
	const marker = lineStart?.index === undefined
		? undefined
		: {
			row: Number(lineStart[1]),
			col: Number(lineStart[2]) + visibleWidth(output.slice(lineStart.index + lineStart[0].length, markerIndex)),
		};
	if (!marker) {
		await writeFile(join(tmpdir(), "observer-click-failure.log"), output);
		assert.fail("close marker was not found in the rendered observer frame");
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		child.stdin.write(`\u001b[<0;${marker.col};${marker.row}M`);
		await delay(80);
		child.stdin.write(`\u001b[<0;${marker.col};${marker.row}m`);
		await delay(250);
	}
	await delay(200);
	child.stdin.write("/quit\r");
	await waitFor(() => child.exitCode !== null, "host did not quit after the close marker click", 8_000);
	assert.equal(await exited, 0);
});
