import { before as ensureScopeBefore } from "node:test";
import { mkdir as ensureScopeMkdir } from "node:fs/promises";
ensureScopeBefore(async () => { await ensureScopeMkdir("/tmp/scope", { recursive: true }); });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContinuationService, registerContinuationTool } from "../extensions/agents/continuation.ts";
import { ManagedSessionStore } from "../extensions/agents/managed-sessions.ts";
import { defaultConfig } from "../extensions/agents/config.ts";
import { emptyUsage, type TaskResult } from "../extensions/agents/contracts.ts";
import { PEER_TOOLS, PEER_TOOL_NAMES } from "../extensions/agents/peer-protocol.ts";

const git = promisify(execFile);

function captureRegistration() {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
	const entries: Array<{ customType?: string }> = [];
	const tools = new Map<string, any>();
	const pi = {
		on(name: string, handler: (event: any, ctx?: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(value: any) { tools.set(value.name, value); },
		registerCommand() {},
		appendEntry(customType: string) { entries.push({ customType }); },
		getActiveTools: () => [...tools.keys()],
		events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	return { pi, handlers, entries, tools };
}

async function fixture(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "agent-discovery-")); const repo = join(base, "repo");
	await ensureScopeMkdir(repo); await git("git", ["init", "-q", repo]);
	const model = { provider: "fixture", id: "fixture", reasoning: false };
	const ctx = { mode: "tui", cwd: repo, isProjectTrusted: () => true, model, thinkingLevel: "off", scopedModels: [], modelRegistry: { getAll: () => [model], getAvailable: () => [model] }, sessionManager: { getSessionId: () => "parent", getLeafId: () => "anchor", getBranch: () => [{ id: "anchor" }] } } as unknown as ExtensionContext;
	const store = new ManagedSessionStore(base);
	const config = defaultConfig();
	let launches = 0;
	const dependencies = {
		store, loadConfig: async () => ({ config }),
		runChild: async (options: { task: { id: string; role: TaskResult["role"] } }) => {
			launches += 1;
			return { id: options.task.id, role: options.task.role, status: "succeeded", output: "report", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applied", reportComplete: true, workerToolsSettled: true } satisfies TaskResult;
		},
	};
	t.after(async () => rm(base, { recursive: true, force: true }));
	return { base, repo, ctx, store, dependencies, launches: () => launches };
}

const task = (label: string) => ({ id: label, role: "explorer" as const, objective: "scan", access: [{ permission: "read" as const, scope: "/tmp/scope" }] });

test("the registered peer tools inject no managed session index and keep guidance natively assembled", async (t) => {
	const f = await fixture(t);
	const captured = captureRegistration();
	const service = registerContinuationTool(captured.pi, f.dependencies);
	t.after(() => service.shutdown());
	assert.equal(captured.handlers.has("context"), false);
	assert.equal(captured.handlers.has("context_with_system"), true, "live-activity cleanup stays registered");

	const surface = () => JSON.stringify([...captured.tools.values()].map(tool => [tool.parameters, tool.description, tool.promptSnippet, tool.promptGuidelines]));
	const before = surface();
	assert.deepEqual([...captured.tools.keys()], PEER_TOOLS);
	const invoke = captured.tools.get(PEER_TOOL_NAMES.invoke);
	assert.ok(invoke.description.length > 0);
	assert.match(invoke.promptSnippet, /list_agents/, "static capability guidance names the explicit discovery operation");
	assert.ok(Array.isArray(invoke.promptGuidelines) && invoke.promptGuidelines.length > 0);
	assert.doesNotMatch(before, /requestId|expectedEpisode|replay token|managed session index|notices extension|notices\.[a-z]|notices-wait/i);

	const settle = async (name: string, event: unknown = {}) => {
		for (const handler of captured.handlers.get(name) ?? []) await handler(event, f.ctx);
	};
	await settle("session_start", {});
	await settle("input", { source: "interactive", text: "work" });
	await settle("input", { source: "extension", text: "EXTENSION-ORIGIN" });
	await settle("agent_settled", {});
	await settle("session_compact", { reason: "manual" });
	await settle("session_tree", {});
	assert.deepEqual(captured.entries, [], "no custom managed-index entry is appended");
	assert.equal(surface(), before, "the complete registered peer surface stays stable across lifecycle events");
});

test("a bare inspect recovers this session's Agents after resume and compaction without an index", async (t) => {
	const f = await fixture(t);
	const service = new ContinuationService(f.dependencies);
	t.after(async () => { await service.shutdown(); });

	const created = await service.execute({ action: "create", mode: "foreground", tasks: [task("fix-parser-tests"), task("review-evidence")] }, f.ctx, undefined, undefined, "call-one");
	assert.equal(created.status, "succeeded");
	const [first, second] = created.sessions;
	assert.equal(f.launches(), 2);
	assert.deepEqual([first!.label, second!.label].sort(), ["fix-parser-tests", "review-evidence"]);
	assert.match(first!.handle, /^[a-f0-9]{32}$/, "the persistent handle is generated, not the label");

	const resumed = new ContinuationService(f.dependencies);
	t.after(async () => { await resumed.shutdown(); });
	const discovered = await resumed.execute({ action: "inspect" }, f.ctx);
	assert.equal(discovered.status, "succeeded");
	assert.deepEqual(discovered.sessions.map(view => view.label).sort(), ["fix-parser-tests", "review-evidence"]);
	for (const view of discovered.sessions) {
		assert.equal(typeof view.handle, "string");
		assert.equal(view.episode, 1);
		assert.equal(view.result?.status, "succeeded");
		assert.equal(view.reportComplete, true);
	}
	const single = await resumed.execute({ action: "inspect", handle: first!.handle }, f.ctx);
	assert.equal(single.sessions.length, 1);
	assert.equal(single.sessions[0]!.label, first!.label);
	assert.equal((await resumed.execute({ action: "close", handle: first!.handle, expectedEpisode: single.sessions[0]!.episode, disposition: "discard" }, f.ctx)).status, "succeeded");
	const after = await resumed.execute({ action: "inspect" }, f.ctx);
	assert.deepEqual(after.sessions.map(view => view.label), [second!.label]);
});

test("discovery stays inert for untrusted projects and never returns another session's Agents", async (t) => {
	const f = await fixture(t);
	const service = new ContinuationService(f.dependencies);
	t.after(async () => { await service.shutdown(); });
	await service.execute({ action: "create", tasks: [task("owned")] }, f.ctx, undefined, undefined, "call-owned");
	const untrusted = await service.execute({ action: "inspect" }, { ...f.ctx, isProjectTrusted: () => false });
	assert.equal(untrusted.status, "failed");
	assert.equal(untrusted.error?.code, "project_trust_required");
	const foreign = await service.execute({ action: "inspect" }, { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "another-session" } });
	assert.equal(foreign.status, "succeeded");
	assert.deepEqual(foreign.sessions, []);
});
