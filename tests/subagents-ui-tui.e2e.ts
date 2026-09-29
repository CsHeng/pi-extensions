import { Terminal } from "@xterm/headless";
import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = process.env.CSHENG_UI_PACKAGE_ROOT ?? root;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Frame = { sequence: number; width: number; lines: string[] };

async function host(t: test.TestContext, history: boolean) {
	try { await access("/usr/bin/script"); } catch { t.skip("requires util-linux script; no installation performed"); return; }
	const installedDirs = (process.env.PATH ?? "").split(":").filter(entry => entry.length > 0 && !entry.includes("node_modules/.bin"));
	let installedPi = false;
	for (const dir of installedDirs) { try { await access(join(dir, "pi"), constants.X_OK); installedPi = true; break; } catch { /* next PATH entry */ } }
	if (!installedPi) { t.skip("no installed pi outside node_modules/.bin"); return; }
	const base = await mkdtemp(join(tmpdir(), "observer-host-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], tuiMode: "fullscreen" }));
	const columns = history ? 80 : 120;
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve",
		"-e", join(packageRoot, "extensions/subagents-ui/index.ts"), "-e", join(root, "tests/fixtures/subagents-observer-tui.ts"),
		"--model", "observer-fixture/fixture", "--thinking", "off", "--", "observer fixture"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `set -eu; stty cols ${columns} rows 24; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true, env: { PATH: installedDirs.join(":"), HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0",
			TERM: "xterm-256color", COLORTERM: "truecolor", CSHENG_UI_PACKAGE_ROOT: packageRoot, CSHENG_UI_HISTORY_FIXTURE: history ? "1" : "0" },
	});
	const terminal = new Terminal({ cols: columns, rows: 24, allowProposedApi: true, scrollback: 0 });
	terminal.onData(data => child.stdin.write(data));
	let sequence = 0;
	let output = "";
	const capture = (data: Buffer) => {
		output += data.toString();
		terminal.write(data, () => { sequence++; });
		if (output.length > 4 * 1024 * 1024) child.kill("SIGTERM");
	};
	child.stdout.on("data", capture); child.stderr.on("data", capture);
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null && child.pid) {
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
			await Promise.race([exited.catch(() => {}), delay(500)]);
			if (child.exitCode === null && child.signalCode === null) {
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
				await Promise.race([exited.catch(() => {}), delay(500)]);
			}
		}
		terminal.dispose();
		await rm(base, { recursive: true, force: true });
		assert.ok(child.exitCode !== null || child.signalCode !== null, "owned PTY process was reaped");
	});
	const waitFor = async (predicate: () => Promise<boolean> | boolean, label: string, budgetMs = 15_000) => {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) { if (await predicate()) return; if (child.exitCode !== null) break; await delay(25); }
		const captured = JSON.stringify(await frame());
		assert.fail(`${label}; captured=${captured}; synthetic terminal tail: ${output.slice(-1200)}`);
	};
	const frame = async (): Promise<Frame> => {
		await new Promise<void>(resolve => terminal.write("", resolve));
		const buffer = terminal.buffer.active;
		return { sequence, width: terminal.cols, lines: Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "") };
	};
	await waitFor(async () => { try { return (await readFile(join(agent, "observer-ready"), "utf8")) === "ready"; } catch { return false; } }, "fixture did not start");
	await delay(150);
	child.stdin.write("\u001b\u0006");
	await waitFor(() => output.includes("Subagents"), "observer overlay did not open");
	const resize = async (cols: number, rows: number) => {
		// Resize only the slave belonging to this owned script process, never the caller's TTY.
		const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/);
		assert.equal(children.length, 1, "one owned Pi slave process");
		const slave = await readlink(`/proc/${children[0]}/fd/0`);
		assert.match(slave, /^\/dev\/pts\/\d+$/);
		const before = sequence;
		terminal.resize(cols, rows);
		await promisify(execFile)("stty", ["-F", slave, "cols", String(cols), "rows", String(rows)]);
		await waitFor(() => sequence > before, "host did not repaint after PTY resize");
		await delay(100);
	};
	return { child, exited, waitFor, frame, resize, agent, get output() { return output; } };
}

test("installed Pi fullscreen: clicking the observer close marker dismisses the overlay", { timeout: 40_000 }, async t => {
	const f = await host(t, false);
	if (!f) return;
	await f.waitFor(() => f.output.includes("1 live (t"), "live fixture row did not appear");
	await f.waitFor(() => f.output.includes("review fixture"), "live detail did not appear");
	await delay(300);
	const markerIndex = f.output.lastIndexOf("\u2715");
	const lineStart = markerIndex < 0 ? undefined : [...f.output.slice(0, markerIndex).matchAll(/\u001b\[(\d+);(\d+)H/g)].at(-1);
	assert.ok(lineStart?.index !== undefined, "close marker present in a terminal frame");
	const row = Number(lineStart[1]);
	const column = Number(lineStart[2]) + visibleWidth(f.output.slice(lineStart.index + lineStart[0].length, markerIndex));
	for (let attempt = 0; attempt < 2; attempt++) {
		f.child.stdin.write(`\u001b[<0;${column};${row}M`);
		await delay(80);
		f.child.stdin.write(`\u001b[<0;${column};${row}m`);
		await delay(250);
	}
	await f.waitFor(() => f.output.includes("FIXTURE_FINISHED"), "synthetic turn did not finish");
	f.child.stdin.write("/quit\r");
	await f.waitFor(() => f.child.exitCode !== null, "host did not quit after close-marker click", 8_000);
	assert.equal(await f.exited, 0);
});

test("installed Pi keys page all session history while ten live rows remain in each physical frame", { timeout: 45_000 }, async t => {
	const f = await host(t, true);
	if (!f) return;
	await f.waitFor(async () => { try { return (await f.frame()).lines.join("\n").includes("37 agents · 49 episodes"); } catch { return false; } }, "session frame missing");
	const inspect = async (seen: Set<string>) => {
		const frame = await f.frame();
		assert.ok(frame.lines.length <= 24, `host requested an over-height frame: ${frame.lines.length}`);
		for (const line of frame.lines) assert.ok(visibleWidth(line) <= frame.width);
		const text = frame.lines.join("\n");
		for (let index = 0; index < 10; index++) assert.ok(text.includes(`ui${String(index).padStart(6, "0")} ep2`), "all ten live identities remain pinned");
		for (const match of text.matchAll(/ui\d{6}/g)) if (Number(match[0].slice(2)) >= 10) seen.add(match[0]);
		return text;
	};
	const seen = new Set<string>();
	await inspect(seen);
	f.child.stdin.write("\r");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 1/2"), "Enter did not expand history");
	for (let page = 1; page <= 2; page++) {
		for (let index = 0; index < 80; index++) { await inspect(seen); f.child.stdin.write("\u001b[B"); await delay(40); }
		if (page === 1) {
			f.child.stdin.write("\u001b[6~");
			await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 2/2"), "PageDown did not navigate retained history");
		}
	}
	assert.deepEqual([...seen].sort(), Array.from({ length: 27 }, (_, index) => `ui${String(index + 10).padStart(6, "0")}`));
	f.child.stdin.write("\u001b[5~");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 1/2"), "PageUp did not navigate back");
	await f.resize(40, 24);
	const narrow = new Set<string>();
	for (let index = 0; index < 100; index++) { await inspect(narrow); f.child.stdin.write("\u001b[B"); await delay(40); }
	assert.deepEqual([...narrow].sort(), Array.from({ length: 20 }, (_, index) => `ui${String(index + 10).padStart(6, "0")}`), "all first-page history remains reachable after a real PTY resize");
	await f.resize(80, 24);
	await inspect(seen);
	await writeFile(join(f.agent, "observer-release"), "release");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("0 live"), "settlement did not refresh the open session view");
	f.child.stdin.write("\u001b\u0006");
	await f.waitFor(() => f.output.includes("FIXTURE_FINISHED"), "synthetic turn did not finish after revealing the transcript");
	await delay(100);
	f.child.stdin.write("/quit\r");
	await f.waitFor(() => f.child.exitCode !== null, "host did not quit after keyboard close", 8_000);
	assert.equal(await f.exited, 0);
});
