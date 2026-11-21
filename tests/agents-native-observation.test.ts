import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { isLocalTiming } from "../extensions/agents/telemetry.ts";
import { isNativeObservation, mergeOwnedUsage, type NativeObservation } from "../extensions/agents/observability.ts";
import { AGENT_EXECUTION_EVENT, type AgentExecutionEvent } from "../extensions/shared/agent-execution.ts";
import { PEER_TOOLS } from "../extensions/agents/peer-protocol.ts";
import type { ParentObservation } from "../extensions/agents/observation-hooks.ts";

for (const installed of [false, true]) test(`native ${installed ? "installed" : "development"} parent and child observations keep separate accounting across named turns`, { timeout: 75_000 }, async (t) => {
	const base = await mkdtemp(join(tmpdir(), "native-observation-")); t.after(() => rm(base, { recursive: true, force: true }));
	const repo = join(base, "repo"); const agent = join(base, "agent"); await mkdir(repo); await mkdir(agent);
	await promisify(execFile)("git", ["init", "-q", repo]); await writeFile(join(repo, "candidate.txt"), "parent");
	await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	const native = join(base, "parent.jsonl");
	const execution = promisify(execFile)(installed ? "pi" : process.execPath, [
		...(installed ? [] : [new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname]),
		"--mode", "json", "-p", "--session", native, "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--approve",
		"-e", new URL("fixtures/agents-native-session.ts", import.meta.url).pathname,
		"-e", new URL("fixtures/agents-native-parent.ts", import.meta.url).pathname,
		"--model", "agent-fixture/fixture", "--thinking", "off", "--",
		"parent-observation-fixture thinking-fixture", "continue-parent-observation-fixture thinking-fixture",
	], { cwd: repo, env: { PATH: process.env.PATH, HOME: base, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_EXTENSIONS_NATIVE_INSTALLED: installed ? "1" : "0" }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
	execution.child.stdin?.end(); await execution;
	const entries = (await readFile(native, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	const toolMessages = entries.filter(entry => entry.message?.role === "toolResult" && PEER_TOOLS.includes(entry.message.toolName)).map(entry => entry.message);
	assert.deepEqual(toolMessages.map(message => message.toolName), ["invoke_agent", "wait_agents", "message_agent", "wait_agents"]);
	assert.ok(toolMessages.every(message => !message.isError && message.usage === undefined), "peer tools never forward child usage into native parent billing");
	const events: AgentExecutionEvent[] = entries.filter(entry => entry.customType === AGENT_EXECUTION_EVENT).map(entry => entry.data);
	assert.ok(events.length > 0);
	for (const event of events) {
		assert.equal(event.version, 5);
		for (const id of [event.eventId, event.runId, event.generation, ...event.sessions.map(view => view.handle)]) assert.match(id, /^[A-Za-z0-9]+$/);
	}
	const terminal = events.filter(event => event.kind === "task-terminal");
	const views = terminal.flatMap(event => event.sessions);
	assert.deepEqual(views.map(view => view.episode), [1, 2]);
	assert.ok(views.every(view => view.handle === views[0]!.handle && view.reportComplete && view.result?.status === "succeeded"));
	const children = views.map(view => view.result?.observation as NativeObservation);
	assert.ok(children.every(child => isNativeObservation(child) && child.available && child.usage.input === 2));
	assert.equal(children[0]!.ownerSessionId, children[1]!.ownerSessionId);
	assert.ok(children.every(child => child.timing && child.timing.complete));
	const parents: ParentObservation[] = entries.filter(entry => entry.customType === "agents.parent-observation").map(entry => entry.data);
	assert.equal(parents.length, 2);
	for (const [index, parent] of parents.entries()) {
		assert.ok(isNativeObservation(parent.native) && parent.native.available);
		assert.equal(parent.native.ownerSessionId, entries[0].id);
		assert.equal(parent.native.usage.input, 3);
		assert.ok(isLocalTiming(parent.timing) && parent.timing.complete);
		assert.equal(parent.timing.spans.reasoning.length, 1);
		assert.ok(parent.timing.spans.delegationWait.length >= 1);
		assert.ok(parent.range); assert.notEqual(parent.range!.startLeaf, parent.range!.endLeaf);
		assert.equal(parent.runs.length, 1);
		const run = parent.runs[0]!;
		assert.equal(run.telemetry.runId, terminal[index]!.runId, "native parent evidence and terminal events identify the same run");
		assert.equal(run.clockKey, parent.timing.clockKey);
		assert.equal(run.telemetry.timing!.children[0]!.taskId, children[index]!.ownerSessionId);
		assert.doesNotMatch(JSON.stringify(parent), /fixture-private-thinking|candidate\.txt|agent-fixture/);
	}
	assert.equal(mergeOwnedUsage([...parents.map(parent => parent.native), ...children, children[0]!]).usage.input, 10, "duplicate evidence does not rebill an episode");
	assert.equal(await readFile(join(repo, "candidate.txt"), "utf8"), "parent", "observation or report completion never auto-applies");
});
