import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionView } from "../extensions/agents/session-contracts.ts";
import { registerRecoveryDiscovery } from "../extensions/agents/recovery-discovery.ts";

function fixture() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let trusted = true, active = true, leaf = "a", calls = 0;
	let views: SessionView[] = [];
	let live: any[] = [];
	let branch: any[] = [];
	const pi = { on: (name: string, fn: any) => handlers.set(name, fn), getActiveTools: () => active ? ["list_agents"] : [] } as unknown as ExtensionAPI;
	const ctx = { isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "s", getLeafId: () => leaf, getBranch: () => branch } } as unknown as ExtensionContext;
	const source = { resolveRecoveryHandles: async (_ctx: unknown, handles: readonly string[]) => { calls++; return views.filter(v => handles.includes(v.handle)); }, liveObserverTasks: () => live };
	registerRecoveryDiscovery(pi, source);
	return { fire: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx), setViews: (v: SessionView[]) => { views = v; branch = [{ type: "message", message: { role: "toolResult", toolName: "list_agents", toolCallId: "call", details: { schemaVersion: 5, sessions: v } } }]; }, setBranch: (v: any[]) => { branch = v; }, setLive: (v: any[]) => { live = v; }, trust: (v: boolean) => { trusted = v; }, active: (v: boolean) => { active = v; }, calls: () => calls };
}
const view = (handle: string, state: SessionView["state"]): SessionView => ({ handle, label: `named-${handle}`, state, role: "worker", episode: 2, reportComplete: false });
const user = { messageType: "user", prompt: "continue" };

test("only one genuine user turn after a boundary receives actionable recovery", async () => {
	const h = fixture();
	h.setViews([view("live", "running"), view("unknown", "queued"), { ...view("aborted", "interrupted"), candidate: { id: "candidate", episode: 2, status: "not-applied", roots: [], changedPaths: [], appliedPaths: [] } }, view("closed", "closed")]);
	h.setLive([{ id: "live", episode: 2, status: "running" }]);
	h.fire("session_start");
	assert.equal(await h.fire("before_agent_start", { messageType: "custom" }), undefined);
	h.fire("input", { source: "extension" });
	assert.equal(await h.fire("before_agent_start", user), undefined);
	h.fire("input", { source: "interactive" });
	const result = await h.fire("before_agent_start", user);
	assert.match(result.message.content, /named-live \(worker\): live running/);
	assert.match(result.message.content, /named-unknown.*activity unconfirmed/);
	assert.match(result.message.content, /named-aborted.*interrupted or aborted.*stop_agent.*isolated candidate not-applied/);
	assert.doesNotMatch(result.message.content, /named-closed|expectedEpisode|handle |candidateId/);
	assert.match(result.message.content, /Do not implicitly discard/);
	h.fire("input", { source: "rpc" });
	assert.equal(await h.fire("before_agent_start", user), undefined);
	assert.equal(h.calls(), 1);
	h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	h.fire("input", { source: "rpc" });
	assert.ok(await h.fire("before_agent_start", user));
});

test("queued, ambiguous and unknown input provenance leave recovery for the next genuine turn", async () => {
	const h = fixture(); h.setViews([view("one", "idle")]); h.fire("session_tree");
	h.fire("input", { source: "rpc", streamingBehavior: "steer" });
	assert.equal(await h.fire("before_agent_start", user), undefined);
	h.fire("input", { source: "rpc" }); h.fire("input", { source: "extension" });
	assert.equal(await h.fire("before_agent_start", user), undefined);
	h.fire("input", {});
	assert.equal(await h.fire("before_agent_start", user), undefined);
	h.fire("input", { source: "rpc" }); assert.ok(await h.fire("before_agent_start", user));
});

test("trust and tool visibility fence discovery without consuming the boundary", async () => {
	const h = fixture(); h.setViews([view("one", "idle")]); h.fire("session_tree");
	h.trust(false); h.fire("input", { source: "interactive" }); assert.equal(await h.fire("before_agent_start", user), undefined);
	h.trust(true); h.active(false); h.fire("input", { source: "interactive" }); assert.equal(await h.fire("before_agent_start", user), undefined);
	assert.equal(h.calls(), 0);
	h.active(true); h.fire("input", { source: "interactive" }); assert.ok(await h.fire("before_agent_start", user));
});

test("empty discoveries do not rewrite ordinary turns; later abort re-arms", async () => {
	const h = fixture(); h.fire("session_start"); h.fire("input", { source: "interactive" });
	assert.equal(await h.fire("before_agent_start", user), undefined);
	h.setViews([view("later", "idle")]); h.fire("input", { source: "interactive" });
	assert.equal(await h.fire("before_agent_start", user), undefined);
	h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }); h.fire("input", { source: "interactive" });
	assert.ok(await h.fire("before_agent_start", user));
});


test("missing receipts and malformed or excessive evidence recommend listing agents", async () => {
	const h = fixture();
	h.setBranch([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "list_agents", id: "missing" }] } }]);
	h.fire("session_tree"); h.fire("input", { source: "rpc" });
	assert.match((await h.fire("before_agent_start", user)).message.content, /incomplete; list_agents/);
	assert.equal(h.calls(), 0);
	h.setBranch([{ type: "message", message: { role: "toolResult", toolName: "list_agents", toolCallId: "x", details: { schemaVersion: 5, sessions: Array.from({ length: 21 }, (_, i) => view(`h${i}`, "idle")) } } }]);
	h.fire("session_tree"); h.fire("input", { source: "rpc" });
	assert.match((await h.fire("before_agent_start", user)).message.content, /incomplete; list_agents/);
});

test("terminal records supply hints without injecting their prose", async () => {
	const h = fixture(); h.setViews([view("one", "idle")]);
	h.setBranch([{ type: "custom", customType: "agents.execution.v5", data: { version: 5, sessions: [{ ...view("one", "idle"), report: "UNTRUSTED" }] } }]);
	h.fire("session_tree"); h.fire("input", { source: "interactive" });
	const content = (await h.fire("before_agent_start", user)).message.content;
	assert.match(content, /named-one/); assert.doesNotMatch(content, /UNTRUSTED/);
});
