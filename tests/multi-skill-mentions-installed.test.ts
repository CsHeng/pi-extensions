import { Terminal } from "@xterm/headless";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Installed-Pi evidence for multi-skill selection. A deterministic synthetic provider captures the
 * provider input, so this proves the authored extension -> native expansion/parse -> request path and
 * the TUI presentation without network, credentials or a live model.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function installedPi(): boolean {
	return spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0;
}

async function skills(base: string): Promise<{ alphaPath: string; alphaBase: string; betaPath: string; betaBase: string }> {
	const alphaBase = join(base, "skills", "probe-alpha");
	const betaBase = join(base, "skills", "probe-beta");
	await mkdir(alphaBase, { recursive: true });
	await mkdir(betaBase, { recursive: true });
	const alphaPath = join(alphaBase, "SKILL.md");
	const betaPath = join(betaBase, "SKILL.md");
	await writeFile(alphaPath, "---\nname: probe-alpha\ndescription: Isolated alpha probe skill.\n---\nAlpha probe body.\n");
	await writeFile(betaPath, "---\nname: probe-beta\ndescription: Isolated beta probe skill.\n---\nBeta probe body.\n");
	return { alphaPath, alphaBase, betaPath, betaBase };
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

interface Capture {
	call: number;
	messages: Array<{ role: string; text: string }>;
}

function userTexts(capture: Capture): string[] {
	return capture.messages.filter((message) => message.role === "user").map((message) => message.text);
}

test("installed Pi RPC: grouped multi-selection reaches the provider as one parsed skill envelope", { timeout: 45_000 }, async (t) => {
	if (!installedPi()) {
		t.skip("requires installed Pi; no installation performed");
		return;
	}
	const base = await mkdtemp(join(tmpdir(), "multi-skill-rpc-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
	const fixture = await skills(base);
	const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "--approve",
		"-e", join(root, "extensions/multi-skill-mentions/index.ts"),
		"-e", join(root, "tests/fixtures/multi-skill/installed-fixture.ts"),
		"--skill", fixture.alphaBase, "--skill", fixture.betaBase,
		"--model", "multi-skill-fixture/fixture", "--thinking", "off"], {
		cwd: base,
		env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "dumb" },
	});
	let bytes = 0;
	let pending = "";
	let settled = 0;
	let extensionError = false;
	child.stdout.on("data", (data: Buffer) => {
		bytes += data.length;
		if (bytes > 1024 * 1024) {
			child.kill("SIGTERM");
			return;
		}
		pending += data.toString();
		let boundary: number;
		while ((boundary = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, boundary);
			pending = pending.slice(boundary + 1);
			try {
				const event = JSON.parse(line) as { type?: string };
				if (event.type === "extension_error") extensionError = true;
				if (event.type === "agent_settled") settled += 1;
			} catch { /* startup text is not protocol */ }
		}
	});
	child.stderr.on("data", (data: Buffer) => {
		bytes += data.length;
		if (bytes > 1024 * 1024) child.kill("SIGTERM");
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("exit", resolve);
		child.once("error", reject);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
	const capturePath = (index: number) => join(agent, `multi-skill-capture-${index}.json`);
	const waitForFile = async (path: string, label: string) => {
		const deadline = Date.now() + 25_000;
		while (Date.now() < deadline) {
			try {
				return JSON.parse(await readFile(path, "utf8")) as Capture;
			} catch {
				if (child.exitCode !== null) break;
				await delay(25);
			}
		}
		assert.fail(`${label}; captured events pending=${JSON.stringify(pending.slice(-800))}`);
	};
	t.after(async () => {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.catch(() => {});
		await rm(base, { recursive: true, force: true });
	});

	child.stdin.write(`${JSON.stringify({ id: "mixed", type: "prompt", message: "/skill:probe-alpha $probe-beta verify installed tail" })}\n`);
	const first = await waitForFile(capturePath(0), "first provider request was not captured");
	const waitForSettled = async (count: number) => {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && settled < count && child.exitCode === null) await delay(25);
		assert.ok(settled >= count, `expected ${count} settled turns, saw ${settled}`);
	};
	await waitForSettled(1);

	child.stdin.write(`${JSON.stringify({ id: "single", type: "prompt", message: "/skill:probe-alpha verify single tail" })}\n`);
	const second = await waitForFile(capturePath(1), "second provider request was not captured");
	await waitForSettled(2);
	child.stdin.end();
	const exitCode = await exited;

	assert.equal(exitCode, 0, "offline installed-host RPC run must exit cleanly");
	assert.equal(extensionError, false);

	const grouped = userTexts(first).at(-1);
	assert.ok(grouped, "provider request carries the transformed user message");
	assert.equal(grouped.match(/^<skill name=/gm)?.length, 1, "one grouped envelope, not stacked skill blocks");
	assert.match(grouped, new RegExp(`^<skill name="probe-alpha, probe-beta" location="${fixture.alphaPath.replaceAll("/", "\\/")}">\\n`));
	assert.match(grouped, new RegExp(`## Skill: probe-alpha\\nLocation: ${fixture.alphaPath.replaceAll("/", "\\/")}\\nReferences are relative to ${fixture.alphaBase.replaceAll("/", "\\/")}\\.`));
	assert.match(grouped, new RegExp(`## Skill: probe-beta\\nLocation: ${fixture.betaPath.replaceAll("/", "\\/")}\\nReferences are relative to ${fixture.betaBase.replaceAll("/", "\\/")}\\.`));
	assert.equal(occurrences(grouped, "Alpha probe body."), 1);
	assert.equal(occurrences(grouped, "Beta probe body."), 1);
	assert.ok(grouped.endsWith("\n\nverify installed tail"), "user tail stays intact and separate");
	assert.equal(grouped.split("\n\nverify installed tail")[0]?.endsWith("</skill>"), true);

	const native = userTexts(second).at(-1);
	assert.ok(native, "second provider request carries the native single expansion");
	assert.match(native, new RegExp(`^<skill name="probe-alpha" location="${fixture.alphaPath.replaceAll("/", "\\/")}">\\nReferences are relative to ${fixture.alphaBase.replaceAll("/", "\\/")}\\.\\n\\nAlpha probe body\\.\\n</skill>\\n\\nverify single tail$`));
	assert.equal(occurrences(native, "Alpha probe body."), 1, "the extension must not expand the native single-slash path twice");
});

test("installed Pi TUI: grouped selection renders every selected name and a clean user tail", { timeout: 60_000 }, async (t) => {
	if (!installedPi()) {
		t.skip("requires installed Pi; no installation performed");
		return;
	}
	try {
		await access("/usr/bin/script");
	} catch {
		t.skip("requires util-linux script; no installation performed");
		return;
	}
	const base = await mkdtemp(join(tmpdir(), "multi-skill-tui-"));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], tuiMode: "fullscreen" }));
	const fixture = await skills(base);
	const columns = 120;
	const rows = 30;
	const args = ["pi", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "--approve",
		"-e", join(root, "extensions/multi-skill-mentions/index.ts"),
		"-e", join(root, "tests/fixtures/multi-skill/installed-fixture.ts"),
		"--skill", fixture.alphaBase, "--skill", fixture.betaBase,
		"--model", "multi-skill-fixture/fixture", "--thinking", "off"];
	const child = spawn("script", ["-q", "-e", "-f", "-c", `set -eu; stty cols ${columns} rows ${rows}; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
		cwd: base,
		detached: true,
		env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
	});
	const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
	terminal.onData((data) => child.stdin.write(data));
	let output = "";
	const capture = (data: Buffer) => {
		output += data.toString();
		terminal.write(data, () => {});
		if (output.length > 4 * 1024 * 1024) child.kill("SIGTERM");
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("exit", resolve);
		child.once("error", reject);
	});
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
	const frame = async (): Promise<string> => {
		await new Promise<void>((resolve) => terminal.write("", resolve));
		const buffer = terminal.buffer.active;
		return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
	};
	const waitFor = async (predicate: () => Promise<boolean>, label: string, budgetMs = 25_000) => {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (await predicate()) return;
			if (child.exitCode !== null) break;
			await delay(50);
		}
		assert.fail(`${label}; synthetic terminal tail: ${output.slice(-1500)}`);
	};
	await waitFor(async () => {
		try {
			return (await readFile(join(agent, "multi-skill-ready"), "utf8")) === "ready";
		} catch {
			return false;
		}
	}, "fixture did not start");
	await delay(150);

	child.stdin.write("\u001b[200~$probe-alpha $probe-beta verify tui tail\u001b[201~");
	await waitFor(async () => (await frame()).includes("verify tui tail"), "pasted prompt did not reach the editor");
	child.stdin.write("\r");
	await waitFor(async () => {
		const text = await frame();
		return text.includes("[skill] probe-alpha, probe-beta") && text.includes("verify tui tail");
	}, "grouped skill card with every selected name and the user tail was not rendered");
	const rendered = await frame();
	assert.equal(rendered.includes("$probe-alpha $probe-beta verify tui tail"), false, "selector tokens must not remain in the transcript tail");
	assert.equal(rendered.includes("[skill] probe-alpha (ctrl+o to expand)"), false, "the grouped selection is one card, not a separate alpha card");

	const captured = JSON.parse(await readFile(join(agent, "multi-skill-capture-0.json"), "utf8")) as Capture;
	const grouped = userTexts(captured).at(-1);
	assert.ok(grouped, "TUI provider request carries the transformed prompt");
	assert.equal(grouped.match(/^<skill name=/gm)?.length, 1);
	assert.match(grouped, /^<skill name="probe-alpha, probe-beta" location="[^"]+">\n/);
	assert.ok(grouped.endsWith("\n\nverify tui tail"));

	child.stdin.write("\u001b[200~/quit\u001b[201~");
	await delay(100);
	child.stdin.write("\r");
	const exitCode = await Promise.race([exited, delay(15_000).then(() => "timeout" as const)]);
	assert.equal(exitCode, 0, "owned TUI run exits cleanly after /quit");
});
