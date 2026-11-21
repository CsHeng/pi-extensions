import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, createReadTool, createWriteTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerContinuationTool, type ContinuationService } from "../extensions/agents/continuation.ts";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { defaultConfig } from "../extensions/agents/config.ts";
import { emptyUsage } from "../extensions/agents/contracts.ts";
import { JsonlProtocolParser } from "../extensions/agents/protocol.ts";
import { createHostHarness } from "./fixtures/host-fixture.ts";

test("Pi host distinguishes a refused peer operation from returned child failure evidence", async t => {
	const base = await mkdtemp(join(tmpdir(), "agent-host-contract-"));
	let service!: ContinuationService;
	const results: Array<{ tool: string; isError: boolean; text: string }> = [];
	const extension = (pi: ExtensionAPI) => {
		service = registerContinuationTool(pi, { store: new ManagedSessionStore(base), loadConfig: async () => ({ config: defaultConfig() }), runChild: async options => {
			options.onChildStarted?.(); options.onChildSettled?.();
			return { id: options.task.id, role: options.task.role, status: "failed", output: "fixture failure evidence", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable", reportComplete: true };
		} });
		pi.registerTool({ name: "other_tool", label: "Other tool", description: "Unrelated fixture", parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "ordinary result" }], details: { schemaVersion: 5, status: "failed" } }; } });
		pi.on("tool_execution_end", event => { results.push({ tool: event.toolName, isError: event.isError, text: JSON.stringify(event.result.content) }); });
	};
	const h = await createHostHarness({ mode: "rpc", extensions: [extension] });
	t.after(async () => { await service.shutdown(); await h.dispose(); await rm(base, { recursive: true, force: true }); });
	await promisify(execFile)("git", ["init", "-q", h.workDir]);
	const access = [{ permission: "read", scope: h.workDir }];
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("invoke_agent", { name: "unknown", role: "undefined-role", prompt: "inspect", access })),
		fauxAssistantMessage(fauxToolCall("invoke_agent", { name: "worker", role: "worker", prompt: "inspect", access })),
		fauxAssistantMessage(fauxToolCall("wait_agents", { names: ["worker"], waitSeconds: 10 })),
		fauxAssistantMessage(fauxToolCall("other_tool", {})),
		fauxAssistantMessage("results observed"),
	]);
	await h.session.prompt("Run host result fixture");
	assert.deepEqual(results.map(({ tool, isError }) => ({ tool, isError })), [
		{ tool: "invoke_agent", isError: true }, { tool: "invoke_agent", isError: false },
		{ tool: "wait_agents", isError: false }, { tool: "other_tool", isError: false },
	]);
	assert.match(results[0]!.text, /unknown_role/);
	assert.match(results[2]!.text, /turn failed.*fixture failure evidence/);
	assert.deepEqual(h.errors, []);
});

for (const installed of [false, true]) {
	test(`native ${installed ? "installed" : "development"} Pi appends one input per process and settles a delta JSON stream`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "agent-native-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const sessionPath = join(root, "native.jsonl");
		const fixture = new URL("fixtures/agents-native-session.ts", import.meta.url).pathname;
		const cli = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname;
		for (const count of [1, 2]) {
			const args = ["--mode", "json", "-p", "--session", sessionPath, "--no-extensions", "-e", fixture,
				"--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--no-tools",
				"--model", "agent-fixture/fixture", "--thinking", "off", "--", `input-${count}`];
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
	const root = await mkdtemp(join(tmpdir(), "agent-native-context-"));
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
