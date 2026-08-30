import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	ExtensionRunner,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_TOOL_NAME,
	TELEMETRY_SCHEMA_VERSION,
	emptyUsage,
	type RunStatus,
	type SubagentRunResult,
} from "../extensions/subagents/contracts.ts";

function runResult(status: RunStatus): SubagentRunResult {
	return {
		status,
		tasks: [],
		usage: emptyUsage(),
		telemetry: {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			runId: "host-contract",
			runDurationMs: 0,
			requestedTasks: 0,
			admittedTasks: 0,
			requestedDependencyEdges: 0,
			admittedDependencyEdges: 0,
			explicitModelTasks: 0,
			explicitThinkingTasks: 0,
			launchedChildren: 0,
			peakConcurrency: 0,
			peakConcurrencyByRole: { explorer: 0, reviewer: 0, worker: 0 },
		},
	};
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

function event(status: RunStatus) {
	return {
		type: "tool_result" as const,
		toolCallId: `call-${status}`,
		toolName: SUBAGENT_TOOL_NAME,
		input: {},
		content: [{ type: "text" as const, text: status }],
		details: runResult(status),
		isError: false,
	};
}

test("Pi host result interception maps subagent domain status to transport errors", async (t) => {
	const runner = await extensionRunner(t);
	assert.equal((await runner.emitToolResult(event("succeeded")))?.isError, false);
	assert.equal((await runner.emitToolResult(event("partial")))?.isError, true);
	assert.equal((await runner.emitToolResult(event("failed")))?.isError, true);
	assert.equal((await runner.emitToolResult(event("aborted")))?.isError, true);
});

test("Pi host result interception ignores other tools and malformed details", async (t) => {
	const runner = await extensionRunner(t);
	assert.equal(await runner.emitToolResult({ ...event("failed"), toolName: "other_tool" }), undefined);
	assert.equal(await runner.emitToolResult({ ...event("failed"), details: { status: "failed" } }), undefined);
});
