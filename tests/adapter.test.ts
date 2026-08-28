import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import workflowHarness, { HARNESS_TOOLS, WORKFLOW_REVIEW_COMMAND } from "../extensions/workflow-harness/index.ts";
import { snapshotSkills } from "../extensions/workflow-harness/skill-discovery.ts";

interface FakeTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakeCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

class FakePi {
	readonly handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	readonly tools = new Map<string, FakeTool>();
	readonly commands = new Map<string, FakeCommand>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly messages: string[] = [];
	branch: unknown[] = [];
	skills = [
		{ name: "synthetic-maker", description: "Use when a user wants a bounded proposal", source: "skill", sourceInfo: { path: "/synthetic/maker/SKILL.md" } },
		{ name: "synthetic-inspector", description: "Use when a user wants to review a bounded target", source: "skill", sourceInfo: { path: "/synthetic/inspector/SKILL.md" } },
	];

	on(name: string, handler: (...args: unknown[]) => Promise<unknown>): void { this.handlers.set(name, handler); }
	registerTool(tool: FakeTool): void { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: FakeCommand): void { this.commands.set(name, command); }
	appendEntry(customType: string, data: unknown): void { this.entries.push({ customType, data }); }
	getCommands(): typeof this.skills { return this.skills; }
	sendUserMessage(message: string): void { this.messages.push(message); }
}

function context(cwd: string, pi: FakePi): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "rpc",
		sessionManager: { getBranch: () => pi.branch },
		ui: { notify() {}, setStatus() {}, theme: { fg: (_tone: string, value: string) => value } },
	} as unknown as ExtensionContext;
}

async function invoke(pi: FakePi, event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
	const handler = pi.handlers.get(event);
	if (!handler) throw new Error(`missing handler ${event}`);
	return handler(payload, ctx);
}

test("adapter stays dormant until a root activates and exposes one typed surface", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-adapter-"));
	t.after(async () => rm(cwd, { recursive: true, force: true }));
	const pi = new FakePi();
	workflowHarness(pi as unknown as ExtensionAPI);
	assert.deepEqual([...pi.tools.keys()].sort(), [...HARNESS_TOOLS].sort());
	assert.equal(pi.commands.size, 5);
	const ctx = context(cwd, pi);
	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(await invoke(pi, "tool_call", { toolCallId: "t1", toolName: "write", input: { path: "free.txt" } }, ctx), undefined);
	await invoke(pi, "input", { type: "input", source: "extension", text: "/skill:synthetic-maker" }, ctx);
	assert.equal(pi.entries.length, 0);
	await invoke(pi, "input", { type: "input", source: "interactive", text: "/skill:synthetic-maker create a bounded proposal" }, ctx);
	await pi.tools.get("workflow_activate")?.execute("activate", { formalRole: "design", selectedName: "synthetic-maker", snapshotSha256: snapshotSkills(pi.skills).sha256, artifactPaths: [] });
	assert.equal(pi.entries.length, 1);
	const state = pi.entries.at(-1)?.data as { stageInstanceId: string | null; workers: Array<{ name: string }> };
	assert.ok(state.stageInstanceId);
	assert.equal(state.workers[0]?.name, "synthetic-maker");
});

test("formal review dispatches once, non-formal work skips it, and standalone review has no upstream stage", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-review-"));
	t.after(async () => rm(cwd, { recursive: true, force: true }));

	const formal = new FakePi();
	workflowHarness(formal as unknown as ExtensionAPI);
	const formalCtx = context(cwd, formal);
	await invoke(formal, "session_start", { type: "session_start", reason: "startup" }, formalCtx);
	await invoke(formal, "input", { type: "input", source: "interactive", text: "formal synthetic request" }, formalCtx);
	await formal.commands.get("workflow-run")?.handler("planning", formalCtx);
	await writeFile(join(cwd, "formal-target.txt"), "formal target");
	await formal.tools.get("workflow_complete_stage")?.execute("complete", { artifactPaths: ["formal-target.txt"], acceptanceKey: "acceptance-1" });
	await invoke(formal, "agent_end", { type: "agent_end", messages: [] }, formalCtx);
	await invoke(formal, "agent_end", { type: "agent_end", messages: [] }, formalCtx);
	assert.equal(formal.messages.length, 1);
	assert.match(formal.messages[0] ?? "", /^\/skill:synthetic-inspector/);
	const reviewState = formal.entries.at(-1)?.data as { pendingChild: { dispatchId: string }; reviewReasons: Array<{ targetSha256: string; acceptanceKey: string }> };
	const blocked = await invoke(formal, "tool_call", { toolCallId: "wrong-actor", toolName: "workflow_adjudicate_review", input: { dispatchId: reviewState.pendingChild.dispatchId, acceptedFindingIds: [] } }, formalCtx) as { block?: boolean };
	assert.equal(blocked.block, true);
	await formal.tools.get("workflow_submit_review")?.execute("review", { dispatchId: reviewState.pendingChild.dispatchId, targetSha256: reviewState.reviewReasons[0]!.targetSha256, acceptanceKey: reviewState.reviewReasons[0]!.acceptanceKey, outcome: "pass", findings: [] });
	await invoke(formal, "agent_end", { type: "agent_end", messages: [] }, formalCtx);
	await formal.tools.get("workflow_adjudicate_review")?.execute("judge", { dispatchId: reviewState.pendingChild.dispatchId, acceptedFindingIds: [] });
	await formal.tools.get("workflow_settle")?.execute("settle", {});
	assert.equal((formal.entries.at(-1)?.data as { settled: boolean }).settled, true);

	const ordinary = new FakePi();
	workflowHarness(ordinary as unknown as ExtensionAPI);
	const ordinaryCtx = context(cwd, ordinary);
	await invoke(ordinary, "session_start", { type: "session_start", reason: "startup" }, ordinaryCtx);
	await invoke(ordinary, "input", { type: "input", source: "interactive", text: "ordinary small task" }, ordinaryCtx);
	await ordinary.commands.get("workflow-run")?.handler("none", ordinaryCtx);
	await ordinary.tools.get("workflow_complete_stage")?.execute("complete", { artifactPaths: [], acceptanceKey: "acceptance-2" });
	await invoke(ordinary, "agent_end", { type: "agent_end", messages: [] }, ordinaryCtx);
	assert.equal(ordinary.messages.length, 0);

	const standalone = new FakePi();
	workflowHarness(standalone as unknown as ExtensionAPI);
	const standaloneCtx = context(cwd, standalone);
	await invoke(standalone, "session_start", { type: "session_start", reason: "startup" }, standaloneCtx);
	await standalone.commands.get(WORKFLOW_REVIEW_COMMAND)?.handler("formal-target.txt standalone", standaloneCtx);
	const standaloneState = standalone.entries.at(-1)?.data as { stageInstanceId: string | null; formalRole: string };
	assert.equal(standaloneState.stageInstanceId, null);
	assert.equal(standaloneState.formalRole, "none");
});

test("graph approval is a direct transition and task children have exact result authority", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-graph-"));
	t.after(async () => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "stage-target.txt"), "stage target");
	const pi = new FakePi();
	workflowHarness(pi as unknown as ExtensionAPI);
	const ctx = context(cwd, pi);
	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await pi.commands.get("workflow-run")?.handler("implementation synthetic-maker", ctx);
	let active = pi.entries.at(-1)?.data as { requestId: string; proposal: { sha256: string } };
	const graph = {
		schemaVersion: 1, graphId: "graph-1", requestId: active.requestId, approved: false, rootFormalRole: "implementation", terminalTaskIds: ["A"],
		tasks: [{ taskId: "A", description: "synthetic task", dependsOn: [], readPaths: [], writePaths: ["stage-target.txt"], resourceLocks: [], isolation: "controller-checkout", verification: ["verify-A"], doneWhen: ["done-A"], review: { required: false, reasons: [] }, attemptLimit: 1, recovery: "fix-forward" }],
	};
	await assert.rejects(() => pi.tools.get("workflow_submit_graph")!.execute("graph", { proposalSha256: active.proposal.sha256, graph: { ...graph, approved: true }, semanticCheck: { omittedWork: [], inventedWork: [], unauthorizedReordering: [] } }), /separate direct/);
	await pi.tools.get("workflow_submit_graph")?.execute("graph", { proposalSha256: active.proposal.sha256, graph, semanticCheck: { omittedWork: [], inventedWork: [], unauthorizedReordering: [] } });
	await assert.rejects(() => pi.tools.get("workflow_update_task")!.execute("task", { action: "start", taskId: "A" }), /separately approved/);
	await pi.commands.get("workflow-approve")?.handler("graph-1", ctx);
	const started = await pi.tools.get("workflow_update_task")?.execute("task", { action: "start", taskId: "A" }) as { details: { attemptId: string } };
	await invoke(pi, "agent_end", { type: "agent_end", messages: [] }, ctx);
	const wrongTool = await invoke(pi, "tool_call", { toolCallId: "wrong", toolName: "workflow_settle", input: {} }, ctx) as { block?: boolean };
	assert.equal(wrongTool.block, true);
	await pi.tools.get("workflow_update_task")?.execute("result", { action: "worker-result", taskId: "A", attemptId: started.details.attemptId, outcome: "pass", evidence: ["done"], observedOperationIds: [] });
	await pi.tools.get("workflow_update_task")?.execute("verify", { action: "verify", taskId: "A", oracle: "verify-A", passed: true });
	await pi.tools.get("workflow_update_task")?.execute("complete", { action: "complete", taskId: "A" });
	await pi.tools.get("workflow_complete_stage")?.execute("stage", { artifactPaths: ["stage-target.txt"], acceptanceKey: "implementation-acceptance" });
	await assert.rejects(() => pi.tools.get("workflow_settle")!.execute("settle", {}), /pending/);
});

test("review dispatch falls back to a generic child when discovery is ambiguous", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-fallback-"));
	t.after(async () => rm(cwd, { recursive: true, force: true }));
	const pi = new FakePi();
	pi.skills = pi.skills.filter((skill) => skill.name === "synthetic-maker");
	workflowHarness(pi as unknown as ExtensionAPI);
	const ctx = context(cwd, pi);
	await invoke(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await writeFile(join(cwd, "fallback-target.txt"), "fallback target");
	await pi.commands.get(WORKFLOW_REVIEW_COMMAND)?.handler("fallback-target.txt standalone", ctx);
	await invoke(pi, "agent_end", { type: "agent_end", messages: [] }, ctx);
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.messages[0]?.startsWith("/skill:"), false);
});
