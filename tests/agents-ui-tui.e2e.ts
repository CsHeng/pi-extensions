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
const packageRoot = process.env.PI_EXTENSIONS_UI_PACKAGE_ROOT ?? root;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Frame = { sequence: number; width: number; lines: string[] };

async function host(t: test.TestContext, history: boolean, panels = false, tuiMode: "regular" | "fullscreen" = "fullscreen") {
	try { await access("/usr/bin/script"); } catch { t.skip("requires util-linux script; no installation performed"); return; }
	const installedDirs = (process.env.PATH ?? "").split(":").filter(entry => entry.length > 0 && !entry.includes("node_modules/.bin"));
	let installedPi = false;
	for (const dir of installedDirs) { try { await access(join(dir, "pi"), constants.X_OK); installedPi = true; break; } catch {} }
	if (!installedPi) { t.skip("no installed pi outside node_modules/.bin"); return; }
	const base = await mkdtemp(join(tmpdir(), "observer-host-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], tuiMode }));
	const columns = history ? 80 : 120;
	const rows = panels ? 36 : 24;
	const args = ["pi", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--approve",
		"-e", join(packageRoot, "extensions/agents-ui/index.ts"),
		...(panels ? ["-e", join(packageRoot, "extensions/tasks-ui/index.ts"), "-e", join(packageRoot, "extensions/jobs-ui/index.ts"),
			"-e", join(root, "tests/fixtures/above-editor-panels.ts")]
			: ["-e", join(root, "tests/fixtures/agents-observer-tui.ts"), "--model", "observer-fixture/fixture", "--thinking", "off", "--", "observer fixture"])];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `set -eu; stty cols ${columns} rows ${rows}; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base, detached: true, env: { PATH: installedDirs.join(":"), HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0",
			TERM: "xterm-256color", COLORTERM: "truecolor", PI_EXTENSIONS_UI_PACKAGE_ROOT: packageRoot, PI_EXTENSIONS_UI_HISTORY_FIXTURE: history ? "1" : "0" },
	});
	const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
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
	if (!panels) {
		child.stdin.write("\u001b\u0006");
		await waitFor(() => output.includes("Agents"), "observer overlay did not open");
	}
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

test("installed Pi fullscreen: three bottom sections expand independently without opening dialogs", { timeout: 45_000 }, async t => {
	const f = await host(t, false, true);
	if (!f) return;
	const names = ["Tasks", "Jobs", "Agents"] as const;
	type Section = typeof names[number];
	const expanded: Record<Section, boolean> = { Tasks: false, Jobs: false, Agents: false };
	const heading = (lines: string[], name: Section) => lines.findIndex(line => new RegExp(`[▸▾].*${name}`).test(line));
	const check = async (hidden?: Section) => {
		await f.waitFor(async () => {
			const { lines, width } = await f.frame();
			let previous = -1;
			for (const name of names) {
				const row = heading(lines, name);
				if (name === hidden) { if (row !== -1) return false; continue; }
				if (row <= previous || !lines[row]?.includes(expanded[name] ? "▾" : "▸")) return false;
				previous = row;
			}
			return lines.every(line => visibleWidth(line) <= width);
		}, "independent section headings did not match expected order/fold state");
	};
	const click = async (name: Section) => {
		const frame = await f.frame();
		const row = heading(frame.lines, name);
		assert.ok(row >= 0, `${name} title is visible`);
		const column = visibleWidth(frame.lines[row]!.split(/[▸▾]/)[0]!) + 1;
		f.child.stdin.write(`\u001b[<0;${column};${row + 1}M`);
		await delay(60);
		f.child.stdin.write(`\u001b[<0;${column};${row + 1}m`);
		expanded[name] = !expanded[name];
		await check();
	};
	await check();
	for (const name of names) await click(name);
	await f.waitFor(async () => {
		const text = (await f.frame()).lines.join("\n");
		return text.includes("Task inline detail") && text.includes("Job inline detail") && text.includes("Fix focus");
	}, "all three inline detail groups must coexist in the same physical frame");
	f.child.stdin.write("/panels-update\r");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("Task inline updated"), "header interaction took editor focus or refresh lost inline detail");
	await check();
	await click("Jobs");
	await click("Tasks");
	await click("Agents");
	f.child.stdin.write("/jobs-ui hide\r");
	await check("Jobs");
	f.child.stdin.write("/panels-update\r");
	await delay(150);
	await check("Jobs");
	f.child.stdin.write("/jobs-ui show\r");
	await check();
	await f.resize(50, 36);
	await check();
	await click("Tasks");
	await click("Agents");
	await f.resize(120, 36);
	for (const [command, title] of [["tasks-ui", "Tasks"], ["jobs-ui", "Jobs"], ["agents-ui", "Agents · session"]]) {
		f.child.stdin.write(`/${command} list\r`);
		await f.waitFor(async () => {
			const { lines } = await f.frame();
			const row = lines.findIndex(line => line.includes(title!) && /[×✕]/u.test(line));
			return row > 0 && row < 24;
		}, `${command} list did not open a central overlay with a close control`);
		if (command === "jobs-ui") {
			const clickInOverlay = async (find: (line: string) => boolean, target: string) => {
				const { lines } = await f.frame();
				const y = lines.findIndex(line => line.includes("│") && find(line));
				assert.ok(y >= 0);
				const x = visibleWidth(lines[y]!.split(target)[0]!) + 1;
				f.child.stdin.write(`\u001b[<0;${x};${y + 1}M`); await delay(60); f.child.stdin.write(`\u001b[<0;${x};${y + 1}m`);
			};
			await clickInOverlay(line => line.includes("wide-job"), "wide-job");
			await f.waitFor(async () => (await f.frame()).lines.some(line => line.includes("│") && /›.*wide-job/.test(line)), "central Job row click did not select that command");
			f.child.stdin.write("\r");
			await f.waitFor(async () => (await f.frame()).lines.some(line => line.includes("Status: exited · exit 7")), "central list opened another job");
			f.child.stdin.write("\u001b");
			await f.waitFor(async () => (await f.frame()).lines.some(line => line.includes("│") && /›.*wide-job/.test(line)), "Job detail did not restore its selected row");
			await clickInOverlay(line => line.includes("Jobs") && line.includes("×"), "×");
		} else f.child.stdin.write(command === "agents-ui" ? "\u001b\u0006" : "\u001b");
		await f.waitFor(async () => !(await f.frame()).lines.some(line => line.includes(title!) && /[×✕]/u.test(line)), `${command} list did not close its central overlay`);
	}
	for (const [command, title] of [["tasks-ui", "Tasks"], ["jobs-ui", "Jobs"], ["agents-ui", "Agents"]]) {
		for (const state of ["off", "on"]) {
			f.child.stdin.write(`/${command}\r`);
			await f.waitFor(async () => (await f.frame()).lines.join("\n").includes(`${title} UI ${state}.`), `${command} did not acknowledge its visibility toggle`);
		}
	}
	f.child.stdin.write("/quit\r");
	await f.waitFor(() => f.child.exitCode !== null, "host did not quit from the still-focused editor", 8_000);
	assert.equal(await f.exited, 0);
});

test("installed Pi: keyboard and pointer enter the right inline detail and return to the same row and chat draft", { timeout: 45_000 }, async t => {
	const f = await host(t, false, true);
	if (!f) return;
	const send = (keys: string) => f.child.stdin.write(keys);
	const screen = async () => (await f.frame()).lines.join("\n");
	const waitText = (text: string) => f.waitFor(async () => (await screen()).includes(text), `missing ${text}`);
	const waitSelected = (name: string) => f.waitFor(async () => (await f.frame()).lines.some(line => line.includes("›") && line.includes(name)), `no selection on ${name}`);
	await f.resize(180, 36);
	send("/agents-ui expand\r"); await waitText("Second fixture");
	const agentLine = async () => (await f.frame()).lines.find(line => line.includes("Fix focus")) ?? "";
	await f.waitFor(async () => (await agentLine()).includes("bash · bun test"), "wide agent row missing active action");
	const wideAgent = await agentLine();
	assert.match(wideAgent, /Worker: Fix focus.*bash · bun test.*1s/, "wide agent row exposes identity, action and duration");
	assert.ok(!wideAgent.includes("AgentInline") && !wideAgent.includes("call_wide"), "row excludes internal IDs");
	send("/jobs-ui focus\r"); await waitSelected("Job inline detail");
	send("\u001b[B"); await waitSelected("wide-job");
	let jobLine = (await f.frame()).lines.find(line => line.includes("›") && line.includes("wide-job"))!;
	assert.ok(visibleWidth(jobLine) > 120 && jobLine.includes("WIDE-END") && jobLine.includes("exit 7"), "wide pane exposes the long command and exit status");
	await f.resize(48, 36);
	const narrowAgent = await agentLine();
	assert.match(narrowAgent, /Fix focus.*1s/, `narrow agent row keeps its identity and duration; frame=${JSON.stringify(await f.frame())}`);
	assert.ok(!narrowAgent.includes("AgentInline") && !narrowAgent.includes("call_wide"), "narrow row excludes internal IDs");
	jobLine = (await f.frame()).lines.find(line => line.includes("›") && line.includes("wide-job"))!;
	assert.ok(jobLine?.includes("exit 7") && !jobLine.includes("WIDE-END"), "narrow pane clips the command, not the failed exit");
	send("\r"); await waitText("Esc back");
	assert.match(await screen(), /wide-job/);
	send("\u001b"); await waitSelected("wide-job");
	await f.waitFor(async () => !(await screen()).includes("Esc back"), "Job detail did not close");
	send("\u001b"); await f.resize(120, 36);
	send("draft survives"); await waitText("draft survives");
	const lines = (await f.frame()).lines;
	const row = lines.findIndex(line => line.includes("Second fixture"));
	assert.ok(row >= 0);
	const column = visibleWidth(lines[row]!.split("Second fixture")[0]!) + 2;
	send(`\u001b[<0;${column};${row + 1}M`); await delay(60); send(`\u001b[<0;${column};${row + 1}m`);
	await waitSelected("Second fixture"); send("\r"); await waitText("Esc back");
	await waitText("Second fixture evidence");
	send("\u001b"); await waitSelected("Second fixture");
	await f.waitFor(async () => !(await screen()).includes("Esc back"), "Agent detail did not close");
	send("\u001b"); await delay(100); send(" intact"); await waitText("draft survives intact");
	send("\u0015/quit\r"); await f.waitFor(() => f.child.exitCode !== null, "draft could not be cleared and editor did not quit");
	assert.equal(await f.exited, 0);
});

test("installed Pi regular mode: inline inspection is reachable without mouse input", { timeout: 35_000 }, async t => {
	const f = await host(t, false, true, "regular");
	if (!f) return;
	const waitForLine = (match: RegExp) => f.waitFor(async () => (await f.frame()).lines.some(line => match.test(line)), `regular screen missing ${match}`);
	f.child.stdin.write("/agents-ui focus\r"); await waitForLine(/›.*Fix focus/);
	f.child.stdin.write("\u001b[B"); await waitForLine(/›.*Second fixture/);
	f.child.stdin.write("\r"); await waitForLine(/Second fixture evidence/);
	f.child.stdin.write("\u001b"); await f.waitFor(async () => !(await f.frame()).lines.some(line => line.includes("Esc back")), "detail remained open");
	await waitForLine(/›.*Second fixture/);
	f.child.stdin.write("/quit\r");
	await f.waitFor(() => f.child.exitCode !== null, "regular mode did not return input to chat");
	assert.equal(await f.exited, 0);
});

test("installed Pi fullscreen: clicking the observer close marker dismisses the overlay", { timeout: 40_000 }, async t => {
	const f = await host(t, false);
	if (!f) return;
	await f.waitFor(() => f.output.includes("1 live"), "live fixture row did not appear");
	await f.waitFor(async () => (await f.frame()).lines.some(line => line.includes("Review 000000")), "readable live identity did not appear");
	await delay(300);
	const markerIndex = f.output.lastIndexOf("\u00d7");
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
	await f.waitFor(async () => { try { return (await f.frame()).lines.join("\n").includes("37 agents"); } catch { return false; } }, "session frame missing");
	const id = (n: number) => `Review ${String(n).padStart(6, "0")}`;
	const inspect = (frame: Frame) => {
		assert.ok(frame.lines.length <= 24, `host requested an over-height frame: ${frame.lines.length}`);
		for (const line of frame.lines) assert.ok(visibleWidth(line) <= frame.width);
		const text = frame.lines.join("\n");
		for (let index = 0; index < 10; index++) assert.ok(text.includes(id(index)), "all ten live identities remain pinned");
	};
	// Synchronize each arrow with the displayed selection; the host can coalesce paints under load.
	const selected = (frame: Frame) => frame.lines.find(line => line.includes("›"))?.match(/Review \d{6}/)?.[0];
	const waitSelected = async (key: string) => f.waitFor(async () => {
		const frame = await f.frame();
		if (selected(frame) !== key) return false;
		inspect(frame);
		return true;
	}, `selected identity ${key} did not appear`);
	const walkPage = async (start: number, count: number) => {
		const keys = [...Array.from({ length: 10 }, (_, i) => id(i)), ...Array.from({ length: count }, (_, i) => id(start + i))];
		let at = keys.indexOf(selected(await f.frame()) ?? "");
		assert.ok(at >= 0, "a visible keyed selection on this page");
		while (at > 0) { f.child.stdin.write("\u001b[A"); await waitSelected(keys[--at]!); }
		await waitSelected(keys[0]!);
		for (const key of keys.slice(1)) { f.child.stdin.write("\u001b[B"); await waitSelected(key); }
	};
	inspect(await f.frame());
	f.child.stdin.write("h");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 1/2"), "history navigation did not expand");
	await walkPage(10, 20);
	f.child.stdin.write("\u001b[6~");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 2/2"), "PageDown did not navigate retained history");
	await walkPage(30, 7);
	f.child.stdin.write("\u001b[5~");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 1/2"), "PageUp did not navigate back");
	await f.resize(40, 24);
	await walkPage(10, 20);
	f.child.stdin.write("\u001b[6~");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 2/2"), "narrow PageDown did not navigate retained history");
	await walkPage(30, 7);
	f.child.stdin.write("\u001b[5~");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("page 1/2"), "narrow PageUp did not navigate back");
	await walkPage(10, 20);
	await f.resize(80, 24);
	await waitSelected(id(29));
	await writeFile(join(f.agent, "observer-release"), "release");
	await f.waitFor(async () => (await f.frame()).lines.join("\n").includes("0 live"), "settlement did not refresh the open session view");
	f.child.stdin.write("\u001b\u0006");
	await f.waitFor(() => f.output.includes("FIXTURE_FINISHED"), "synthetic turn did not finish after revealing the transcript");
	await delay(100);
	f.child.stdin.write("/quit\r");
	await f.waitFor(() => f.child.exitCode !== null, "host did not quit after keyboard close", 8_000);
	assert.equal(await f.exited, 0);
});
