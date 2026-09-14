import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	ExtensionRunner,
	SessionManager,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_SESSION_TOOL_NAME, type SessionActionResult } from "../extensions/subagents/session-contracts.ts";

import { JsonlProtocolParser } from "../extensions/subagents/protocol.ts";

function managedResult(status: SessionActionResult["status"], schemaVersion: 1 | 2 = 2): SessionActionResult {
	return { schemaVersion, action: "create", status, sessions: [] };
}

async function extensionRunner(t: test.TestContext): Promise<ExtensionRunner> {
	const agentDir = await mkdtemp(join(tmpdir(), "subagent-host-contract-"));
	t.after(async () => rm(agentDir, { recursive: true, force: true }));
	const loaded = await discoverAndLoadExtensions(
		["./extensions/subagents/index.ts"],
		process.cwd(),
		agentDir,
	);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	return new ExtensionRunner(
		loaded.extensions,
		createExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(process.cwd()),
		{} as ConstructorParameters<typeof ExtensionRunner>[4],
	);
}

function event(status: SessionActionResult["status"], toolName = SUBAGENT_SESSION_TOOL_NAME, details: unknown = managedResult(status)) {
	return {
		type: "tool_result" as const,
		toolCallId: `call-${status}`,
		toolName,
		input: {},
		content: [{ type: "text" as const, text: status }],
		details,
		isError: false,
	};
}

test("Pi host result interception maps managed session status to transport errors", async (t) => {
	const runner = await extensionRunner(t);
	for (const schemaVersion of [1, 2] as const) {
		assert.equal((await runner.emitToolResult(event("succeeded", SUBAGENT_SESSION_TOOL_NAME, managedResult("succeeded", schemaVersion))))?.isError, false);
		assert.equal((await runner.emitToolResult(event("partial", SUBAGENT_SESSION_TOOL_NAME, managedResult("partial", schemaVersion))))?.isError, true);
		assert.equal((await runner.emitToolResult(event("failed", SUBAGENT_SESSION_TOOL_NAME, managedResult("failed", schemaVersion))))?.isError, true);
		assert.equal((await runner.emitToolResult(event("aborted", SUBAGENT_SESSION_TOOL_NAME, managedResult("aborted", schemaVersion))))?.isError, true);
	}
});

test("Pi host result interception ignores other tools, the retired one-shot name, and malformed details", async (t) => {
	const runner = await extensionRunner(t);
	assert.equal(await runner.emitToolResult({ ...event("failed"), toolName: "other_tool" }), undefined);
	assert.equal(await runner.emitToolResult(event("failed", "csheng_subagents", managedResult("failed"))), undefined);
	assert.equal(await runner.emitToolResult({ ...event("failed"), details: { status: "failed" } }), undefined);
});

for (const installed of [false, true]) {
	test(`native ${installed ? "installed" : "development"} Pi appends one input per process and settles a delta JSON stream`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "subagent-native-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const sessionPath = join(root, "native.jsonl");
		const fixture = new URL("fixtures/subagents-native-session.ts", import.meta.url).pathname;
		const cli = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname;
		for (const count of [1, 2]) {
			const args = ["--mode", "json", "-p", "--session", sessionPath, "--no-extensions", "-e", fixture,
				"--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--no-tools",
				"--model", "subagent-fixture/fixture", "--thinking", "off", "--", `input-${count}`];
			const pending = promisify(execFile)(installed ? "pi" : process.execPath, installed ? args : [cli, ...args], {
				cwd: root, timeout: 30000, maxBuffer: 1024 * 1024,
				env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
			});
			pending.child.stdin?.end();
			const { stdout } = await pending;
			const parser = new JsonlProtocolParser();
			parser.push(stdout);
			assert.equal(parser.finish().reportComplete, true);
			const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
			const final = events.find((item) => item.type === "message_end" && item.message.role === "assistant");
			assert.equal(final?.message.content[0].text, `users=${count}`);
			assert.equal(final.message.stopReason, "stop");
			assert.ok(events.findIndex((item) => item.type === "agent_settled") > events.findIndex((item) => item.type === "agent_end"));
			const delta = events.find((item) => item.type === "message_update");
			assert.ok(delta);
			assert.equal(delta.message, undefined);
			assert.equal(delta.assistantMessageEvent.partial, undefined);
		}
		const entries = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(entries.filter((entry) => entry.type === "session").length, 1);
		assert.equal(entries.filter((entry) => entry.message?.role === "user").length, 2);
	});
}

test("native compaction context retains the selected tail and tool operations share state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-native-context-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
	manager.appendCompaction("summary", kept, 100);
	assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["compactionSummary", "user"]);
	const files = new Map<string, string>();
	const writer = createWriteTool(root, { operations: {
		mkdir: async () => {}, writeFile: async (path, content) => { files.set(path, content); },
	} });
	const reader = createReadTool(root, { operations: {
		readFile: async (path) => Buffer.from(files.get(path) ?? ""), access: async () => {},
	} });
	await writer.execute("write", { path: "candidate.txt", content: "candidate" });
	const result = await reader.execute("read", { path: "candidate.txt" });
	assert.deepEqual(result.content, [{ type: "text", text: "candidate" }]);
});
