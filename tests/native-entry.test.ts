import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const EXTENSION = new URL("../extensions/workflow-harness/index.ts", import.meta.url).pathname;

test("temporary Pi loading exposes exactly one generic diagnostic", async (t) => {
	const agentRoot = await mkdtemp(join(tmpdir(), "workflow-agent-"));
	const workRoot = await mkdtemp(join(tmpdir(), "workflow-work-"));
	t.after(async () => { await rm(agentRoot, { recursive: true, force: true }); await rm(workRoot, { recursive: true, force: true }); });
	const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-skills", "--no-context-files", "--no-approve", "--extension", EXTENSION], {
		cwd: workRoot,
		env: { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end('{"type":"get_commands"}\n');
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
	assert.equal(exitCode, 0, stderr);
	const responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	const response = responses.find((item) => item.type === "response") as { data: { commands: Array<{ name: string }> } } | undefined;
	assert.equal(response?.data.commands.filter((item) => item.name === "workflow-harness-status").length, 1);
});
