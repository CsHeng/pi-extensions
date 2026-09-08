import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkerTools } from "../extensions/subagents/worker-tools.ts";

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
const fixturePath = new URL("fixtures/subagents-worker-command.mjs", import.meta.url).pathname;
const command = (mode: string) => `${quote(process.execPath)} ${quote(fixturePath)} ${quote(mode)}`;

async function setup(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "worker-tools-"));
	const cwd = join(base, "source");
	const scratch = join(base, "scratch");
	await mkdir(cwd);
	await mkdir(scratch);
	const worker = await createWorkerTools({ cwd, scratch, env: { PATH: process.env.PATH, HOME: base } });
	t.after(async () => { await worker.shutdown(); await rm(base, { recursive: true, force: true }); });
	const execute = (name: string, args: any, signal?: AbortSignal) => worker.tools.find((tool) => tool.name === name)!.execute(name, args, signal, undefined, {} as any);
	return { cwd, scratch, worker, execute };
}

async function waitFor(file: string): Promise<void> {
	for (let count = 0; count < 200; count++) {
		try { await access(file); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
	throw new Error("fixture did not start");
}

test("host worker tools preserve Pi schemas and share edit/test/repair state", async (t) => {
	const { execute, worker } = await setup(t);
	assert.deepEqual(worker.tools.map((tool) => tool.name), ["read", "grep", "find", "ls", "edit", "write", "bash"]);
	assert.ok(worker.tools.every((tool) => tool.parameters && tool.description && tool.promptSnippet));
	await execute("write", { path: "candidate.txt", content: "broken" });
	await assert.rejects(execute("bash", { command: command("check") }), /code 2/);
	await execute("edit", { path: "candidate.txt", edits: [{ oldText: "broken", newText: "fixed" }] });
	assert.match(JSON.stringify(await execute("bash", { command: command("check") })), /verified/);
	assert.match(JSON.stringify(await execute("read", { path: "candidate.txt" })), /fixed/);
	assert.deepEqual(worker.commands.map((span) => span.exitCode), [2, 0]);
	assert.ok(worker.commands.every((span) => span.endMs !== null && span.endMs >= span.startMs));
});

test("native read preserves image content instead of decoding bytes as text", async (t) => {
	const { cwd, execute } = await setup(t);
	await writeFile(join(cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
	const result = await execute("read", { path: "pixel.png" });
	assert.ok(result.content.some((part) => part.type === "image"), JSON.stringify(result));
});

test("ordinary background writers are stopped before drain and signal exits are failures", async (t) => {
	const { cwd, execute, worker } = await setup(t);
	await execute("bash", { command: `(${command("delay")}) >/dev/null 2>&1 &` });
	await worker.drain();
	await new Promise((resolve) => setTimeout(resolve, 300));
	await assert.rejects(access(join(cwd, "candidate.txt")));
	await assert.rejects(execute("bash", { command: "kill -KILL $$" }), /signalled/);
	assert.equal(worker.commands.at(-1)?.status, "failed");
});

test("a worker queue covers bash and file tools while separate workers stay independent", async (t) => {
	const first = await setup(t);
	const second = await setup(t);
	const bash = first.execute("bash", { command: command("delay") });
	await waitFor(join(first.cwd, "started"));
	const write = first.execute("write", { path: "candidate.txt", content: "after-command" });
	await second.execute("write", { path: "candidate.txt", content: "independent" });
	assert.equal(await readFile(join(second.cwd, "candidate.txt"), "utf8"), "independent");
	await Promise.all([bash, write]);
	assert.equal(await readFile(join(first.cwd, "candidate.txt"), "utf8"), "after-command");
});

test("shutdown aborts an active command and rejects queued work before mutation", async (t) => {
	const { cwd, execute, worker } = await setup(t);
	const running = assert.rejects(execute("bash", { command: command("wait") }), /aborted/i);
	await waitFor(join(cwd, "started"));
	const descendant = Number(await readFile(join(cwd, "started"), "utf8"));
	const queued = assert.rejects(execute("write", { path: "not-written", content: "no" }), /closed|aborted/i);
	await worker.shutdown();
	if (process.platform === "linux") {
		try { assert.equal((await readFile(`/proc/${descendant}/stat`, "utf8")).split(") ")[1]?.startsWith("Z"), true); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	await Promise.all([running, queued]);
	await assert.rejects(access(join(cwd, "not-written")));
	await assert.rejects(execute("read", { path: "started" }), /closed|aborted/i);
	assert.equal(worker.commands[0]?.status, "aborted");
});

test("search retains its completion barrier on cancellation with cached and fdfind-only binaries", async (t) => {
	for (const managed of [true, false]) {
		const base = await mkdtemp(join(tmpdir(), "worker-search-"));
		t.after(() => rm(base, { recursive: true, force: true }));
		const agent = join(base, "agent");
		const binaryDir = managed ? join(agent, "bin") : join(base, "bin");
		const scratch = join(base, "scratch");
		const cwd = join(base, "source");
		await mkdir(binaryDir, { recursive: true }); await mkdir(scratch); await mkdir(cwd);
		const binary = join(binaryDir, managed ? "fd" : "fdfind");
		await writeFile(binary, `#!${process.execPath}\nif (process.argv.includes('--version')) process.exit(0);\nconst fs = require('node:fs');\nfs.writeFileSync('search-started', 'yes');\nsetTimeout(() => { fs.writeFileSync('search-finished', 'yes'); console.log('candidate.txt'); }, 150);\n`);
		await chmod(binary, 0o700);
		const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fixturePath, "search-check", scratch], {
			cwd, timeout: 15_000, env: { PATH: managed ? "/nonexistent-fixture-path" : binaryDir, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
		});
		assert.match(stdout, /search-drained/);
	}
});

test("command timeouts do not poison later tasks and native truncated output is owned by scratch", async (t) => {
	const { scratch, execute, worker } = await setup(t);
	await assert.rejects(execute("bash", { command: command("wait"), timeout: 0.15 }), /timed out/i);
	const result = await execute("bash", { command: command("output") });
	const fullOutputPath = (result.details as { fullOutputPath: string }).fullOutputPath;
	assert.ok(fullOutputPath.startsWith(`${scratch}/`));
	assert.ok((await readFile(fullOutputPath)).length > 80_000);
	assert.equal(worker.commands[0]?.status, "timed-out");
	await worker.shutdown();
	await assert.rejects(access(fullOutputPath));
});
