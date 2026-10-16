import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import loopNotifications from "../extensions/loop-notifications/index.ts";
import workflow from "../extensions/workflow/index.ts";
import { bindRetainedShell, SHELL_EXECUTION_EVENT } from "../extensions/retained-shell/index.ts";
import { createShellExecutionOwner, type ShellExecutionOwner } from "../extensions/retained-shell/execution.ts";
import { LOOP_NOTICE_TYPE } from "../extensions/shared/loop-facts.ts";
import { defaultConfig } from "../extensions/subagents/config.ts";
import { emptyUsage } from "../extensions/subagents/contracts.ts";
import { registerContinuationTool, type ContinuationService } from "../extensions/subagents/continuation.ts";
import { ManagedSessionStore } from "../extensions/subagents/managed-sessions.ts";
import { createHostHarness, createTrace, waitForTrace } from "./fixtures/workflow/host-fixture.ts";

for (const consumerFirst of [false, true]) test(`actual three-producer co-load (consumer first: ${consumerFirst})`, { timeout: 20_000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "loop-coload-"));
	const scope = join(base, "scope");
	await mkdir(scope);
	await mkdir(join(base, "children"));
	let releaseChild!: () => void;
	const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
	let shell!: ShellExecutionOwner;
	let children!: ContinuationService;
	let ctx!: ExtensionContext;
	const projections: string[] = [];
	const results: unknown[] = [];
	const trace = createTrace();
	const producers = (pi: ExtensionAPI) => {
		shell = createShellExecutionOwner({ spawnSpec: () => ({ shell: "/bin/sh", args: ["-c"] }), onEvent: event => pi.events.emit(SHELL_EXECUTION_EVENT, event) });
		bindRetainedShell(pi, shell);
		children = registerContinuationTool(pi, {
			store: new ManagedSessionStore(join(base, "children")),
			loadConfig: async () => ({ config: defaultConfig() }),
			runChild: async options => {
				options.onChildStarted?.();
				await childGate;
				options.onChildSettled?.();
				return { id: options.task.id, role: options.task.role, status: "succeeded", reportComplete: true, output: "child complete", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
			},
		});
		pi.on("session_start", (_event, context) => { ctx = context; });
	};
	const recorder = (pi: ExtensionAPI) => {
		pi.on("tool_result", event => { results.push({ tool: event.toolName, details: event.details, content: event.content }); });
		pi.on("context_with_system", event => {
			for (const message of event.messages) if (message.role === "custom" && message.customType === LOOP_NOTICE_TYPE) projections.push(String(message.content));
		});
	};
	const extensions = consumerFirst ? [loopNotifications, workflow, producers, recorder] : [workflow, producers, loopNotifications, recorder];
	const h = await createHostHarness({ trace, extensions });
	execFileSync("git", ["init", "-q", h.workDir]);
	t.after(async () => {
		releaseChild();
		await shell.shutdown();
		await children.shutdown();
		await h.dispose();
		await rm(base, { recursive: true, force: true });
	});
	const tool = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never));
	h.faux.setResponses([
		tool("csheng_workflow", { operation: "set", goal: "Co-load", tasks: [{ id: "task", title: "Work", status: "doing" }] }),
		tool("bash", { command: "sleep 30", background: true }),
		tool("csheng_subagent_sessions", { action: "create", requestId: "coload", tasks: [{ id: "child", role: "explorer", objective: "Read", access: [{ permission: "read", scope }] }] }),
		tool("csheng_workflow", { operation: "update", tasks: [{ id: "task", note: "Waiting for actual results" }] }),
		fauxAssistantMessage("yield"),
		fauxAssistantMessage("shell completion observed while child remains"),
		fauxAssistantMessage("child completion observed"),
		fauxAssistantMessage("one task-only renewal"),
		fauxAssistantMessage("must not run"),
	]);
	await h.session.prompt("exercise the three tools");
	await waitForTrace(trace, () => trace.entries.filter(entry => entry.event === "native:agent_settled").length >= 1);
	assert.equal(h.faux.state.callCount, 5, "no task wake after note changes while both executions are unfinished");
	assert.equal(children.busy, true, JSON.stringify(results));
	const shellScope = { sessionId: ctx.sessionManager.getSessionId(), branchAnchor: ctx.sessionManager.getLeafId(), branchIds: ctx.sessionManager.getBranch().map(entry => entry.id) };
	const running = shell.list(shellScope).find(view => view.status === "running");
	assert.ok(running, "the real controlled process is still running");
	await shell.cancel(running.executionId, shellScope);
	await waitForTrace(trace, () => h.faux.state.callCount >= 6 && trace.entries.filter(entry => entry.event === "native:agent_settled").length >= 2);
	assert.equal(h.faux.state.callCount, 6);
	assert.equal(children.busy, true, "shell evidence is not withheld for the child");
	assert.equal(projections.length, 1);
	assert.ok(projections[0]!.includes(running.executionId));
	releaseChild();
	await waitForTrace(trace, () => h.faux.state.callCount >= 8 && trace.entries.filter(entry => entry.event === "native:agent_settled").length >= 4);
	assert.equal(h.faux.state.callCount, 8, "one child completion followed by one bounded renewal");
	assert.equal(projections.length, 2);
	assert.match(projections[1]!, /Subagent task child/);
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(h.faux.state.callCount, 8);
	assert.deepEqual(h.errors, []);
});
