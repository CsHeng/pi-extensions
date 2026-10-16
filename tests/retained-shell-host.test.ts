import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { installedHostEnvironment } from "../scripts/installed-host-env.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostEnv = installedHostEnvironment();

async function scratch(): Promise<string> {
	const directory = join(process.env.TMPDIR ?? tmpdir(), "extensions");
	await mkdir(directory, { recursive: true });
	return mkdtemp(join(directory, "retained-shell-host-"));
}

function piAvailable(): boolean {
	return spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000, env: hostEnv }).status === 0;
}

async function runPrompt(t: TestContext, mode: string, ready: (proof: Proof) => boolean, extensions: string[] = [], shellFirst = false): Promise<Proof> {
	const base = await scratch();
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
	const shell = join(root, "extensions/retained-shell/index.ts");
	const consumer = join(root, "extensions/loop-notifications/index.ts");
	const ordered = shellFirst ? [shell, ...extensions, consumer] : [consumer, ...extensions, shell];
	const child = spawn("pi", [
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve",
		...ordered.flatMap((path) => ["-e", path]),
		"-e", join(root, "tests/fixtures/retained-shell/provider.ts"),
		"--model", "retained-shell-fixture/fixture", "--thinking", "off",
	], {
		cwd: base,
		env: { ...hostEnv, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "dumb", RETAINED_SHELL_EXPECT: mode },
	});
	const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
	const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
	t.after(async () => {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.catch(() => undefined);
		await rm(base, { recursive: true, force: true });
	});
	child.stdin.write(`${JSON.stringify({ id: "start", type: "prompt", message: "Run the shell fixture." })}\n`);
	const proof = await waitForProof(agent, ready);
	await new Promise((resolve) => setTimeout(resolve, mode === "before-return" ? 700 : 200));
	const latest = JSON.parse(await readFile(join(agent, "retained-shell-proof.json"), "utf8")) as Proof;
	child.stdin.end();
	return latest.calls === undefined ? proof : latest;
}

for (const mode of ["drain", "reject"] as const) test(`print/json ${mode === "drain" ? "drains foreground bash" : "rejects unsupported async before effects"}`, async (t) => {
	if (!piAvailable()) {
		t.skip("requires installed Pi; no installation performed");
		return;
	}
	const base = await scratch();
	t.after(() => rm(base, { recursive: true, force: true }));
	const agent = join(base, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
	const result = spawnSync("pi", [
		"--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve",
		"-e", join(root, "extensions/retained-shell/index.ts"),
		"-e", join(root, "tests/fixtures/retained-shell/provider.ts"),
		"--model", "retained-shell-fixture/fixture", "--thinking", "off",
		"drain the shell",
	], {
		cwd: base,
		encoding: "utf8",
		timeout: 20_000,
		env: { ...hostEnv, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", RETAINED_SHELL_EXPECT: mode },
	});
	assert.equal(result.status, 0, result.stderr);
	const proof = JSON.parse(await readFile(join(agent, "retained-shell-proof.json"), "utf8")) as {
		mode: string; elapsedMs: number; text: string; running: boolean; toolResultPresent: boolean; started: boolean;
	};
	assert.equal(proof.mode, mode);
	if (mode === "reject") {
		assert.equal(proof.toolResultPresent, true); assert.equal(proof.started, false);
	} else {
		assert.equal(proof.running, false);
		assert.match(proof.text, /drained/);
		assert.ok(proof.elapsedMs >= 2_500, `expected the native shell to drain, elapsed ${proof.elapsedMs}`);
	}
});

test("rpc provider request happens while the same silent command is still alive", async (t) => {
	if (!piAvailable()) {
		t.skip("requires installed Pi; no installation performed");
		return;
	}
	const base = await scratch();
	const agent = join(base, "agent");
	const marker = join(base, "marker");
	const release = join(base, "release");
	const pidfile = join(base, "pid");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
	const child = spawn("pi", [
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve",
		"-e", join(root, "extensions/loop-notifications/index.ts"),
		"-e", join(root, "extensions/retained-shell/index.ts"),
		"-e", join(root, "tests/fixtures/retained-shell/provider.ts"),
		"--model", "retained-shell-fixture/fixture", "--thinking", "off",
	], {
		cwd: base,
		env: {
			...hostEnv,
			HOME: base,
			PI_CODING_AGENT_DIR: agent,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			TERM: "dumb",
			RETAINED_SHELL_EXPECT: "idle",
			RETAINED_SHELL_MARKER: marker,
			RETAINED_SHELL_RELEASE: release,
			RETAINED_SHELL_PID: pidfile,
		},
	});
	const events = collect(child);
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("exit", resolve);
		child.once("error", reject);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
	t.after(async () => {
		clearTimeout(timer);
		await killRecordedProcess(pidfile);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.catch(() => undefined);
		await rm(base, { recursive: true, force: true });
	});
	child.stdin.write(`${JSON.stringify({ id: "start", type: "prompt", message: "Start the silent command, then answer independently." })}\n`);
	const alive = await waitForProof(agent, (proof) => proof.whileAlive !== undefined);
	assert.equal(events.extensionError, false, JSON.stringify(events.tail));
	assert.equal(alive.whileAlive?.toolResultPresent, true);
	assert.equal(alive.whileAlive?.releaseExists, false);
	assert.equal(alive.whileAlive?.marker, "start\n");
	assert.ok((alive.whileAlive?.elapsedMs ?? 10_000) < 5_000);
	await waitFor(() => events.settled >= 1, "first run did not settle");
	await writeFile(release, "go\n");
	const delivered = await waitForProof(agent, (proof) => proof.delivered === true);
	assert.equal(delivered.firstIdCount, 1);
	assert.equal(await readFile(marker, "utf8"), "start\nfinished\n");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal((JSON.parse(await readFile(join(agent, "retained-shell-proof.json"), "utf8")) as { calls?: number }).calls, delivered.calls);
	child.stdin.end();
	const exitCode = await Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5_000))]);
	if (exitCode === -1) child.kill("SIGTERM");
});

test("busy completion is projected onto the next request and a returned terminal does not wake again", async (t) => {
	if (!piAvailable()) { t.skip("requires installed Pi; no installation performed"); return; }
	const busy = await runPrompt(t, "busy", (proof) => proof.phase === "next");
	assert.equal(busy.projected, true);
	const returned = await runPrompt(t, "before-return", (proof) => proof.returned !== undefined);
	assert.equal(returned.returned, true);
	assert.equal(returned.running, false);
	assert.equal(returned.wake, false);
	assert.equal(returned.calls, 2);
});

for (const shellFirst of [false, true]) test(`a shell terminal precedes one bounded task renewal (shell first: ${shellFirst})`, async (t) => {
	if (!piAvailable()) { t.skip("requires installed Pi; no installation performed"); return; }
	const proof = await runPrompt(t, "coload", (value) => value.delivered === true, [join(root, "extensions/workflow/index.ts")], shellFirst);
	assert.equal(proof.reminder, true);
	assert.equal(proof.delivered, true);
	assert.equal(proof.terminalRequests, 1);
	assert.equal(proof.reminderRequests, 1);
	assert.equal(proof.calls, 5, "one completion turn and one later task renewal");
});

interface Proof {
	whileAlive?: { toolResultPresent: boolean; releaseExists: boolean; marker: string; elapsedMs: number };
	delivered?: boolean;
	firstIdCount?: number;
	calls?: number;
	phase?: string;
	projected?: boolean;
	returned?: boolean;
	running?: boolean;
	wake?: boolean;
	reminder?: boolean;
	terminalRequests?: number;
	reminderRequests?: number;
}

function collect(child: ChildProcessWithoutNullStreams): { settled: number; extensionError: boolean; tail: unknown[] } {
	const state = { settled: 0, extensionError: false, tail: [] as unknown[] };
	let pending = "";
	child.stdout.on("data", (data: Buffer) => {
		pending += data.toString();
		let boundary = pending.indexOf("\n");
		while (boundary >= 0) {
			const line = pending.slice(0, boundary);
			pending = pending.slice(boundary + 1);
			try {
				const event = JSON.parse(line) as { type?: string; command?: string; success?: boolean };
				if (event.type === "agent_settled") state.settled += 1;
				if (event.type === "extension_error") state.extensionError = true;
				if (event.type !== "message_update") {
					state.tail.push({ type: event.type, command: event.command, success: event.success });
					if (state.tail.length > 40) state.tail.shift();
				}
			} catch { /* startup text is not protocol */ }
			boundary = pending.indexOf("\n");
		}
	});
	child.stderr.on("data", () => {});
	return state;
}

async function waitForProof(agent: string, ready: (proof: Proof) => boolean): Promise<Proof> {
	const path = join(agent, "retained-shell-proof.json");
	const started = Date.now();
	while (Date.now() - started < 20_000) {
		try {
			const proof = JSON.parse(await readFile(path, "utf8")) as Proof;
			if (ready(proof)) return proof;
		} catch { /* proof not written yet */ }
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`retained-shell host proof was not written: ${path}`);
}

async function waitFor(ready: () => boolean, message: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 20_000) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(message);
}

async function killRecordedProcess(pidfile: string): Promise<void> {
	try {
		const pid = Number(await readFile(pidfile, "utf8"));
		if (pid > 1) process.kill(-pid, "SIGKILL");
	} catch { /* already gone or never started */ }
}
