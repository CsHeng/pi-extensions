import { writeFile } from "node:fs/promises";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ManagedSessionStore } from "../../extensions/subagents/managed-sessions.ts";
import { registerContinuationTool } from "../../extensions/subagents/continuation.ts";
import { validateGraph } from "../../extensions/subagents/graph.ts";

/** Native host-only fixture: metadata seeds and public compaction, never a child dispatch. */
export default function nativeContextFixture(pi: ExtensionAPI): void {
	const mode = process.env.CSHENG_NATIVE_CONTEXT_MODE;
	const store = new ManagedSessionStore(getAgentDir());
	registerContinuationTool(pi, { store });
	pi.registerCommand("fixture-managed-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
	pi.registerCommand("fixture-managed-tree", { handler: async (_args, ctx) => {
		const target = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!target) throw new Error("fixture");
		await ctx.navigateTree(target.id, { summarize: false });
		pi.appendEntry("fixture-tree-selection", {});
	} });
	pi.registerCommand("fixture-managed-fork", { handler: async (_args, ctx) => {
		const target = ctx.sessionManager.getLeafId();
		const output = process.env.CSHENG_NATIVE_FORK_RESULT;
		if (!target || !output) throw new Error("fixture");
		await ctx.fork(target, { position: "at", withSession: async (fresh) => {
			await writeFile(output, JSON.stringify({ id: fresh.sessionManager.getSessionId(), native: fresh.sessionManager.getSessionFile() }), { mode: 0o600 });
		} });
	} });
	if (mode === "disabled") pi.on("session_start", () => { pi.setActiveTools([]); });
	if (mode === "seed") pi.on("agent_settled", async (_event, ctx) => {
		const graph = validateGraph({ tasks: [{ id: "fixture", role: "explorer", objective: "PRIVATE_INDEX_PROSE", scope: ["."] }] });
		if (!graph.ok) throw new Error("fixture");
		await store.allocate({ repo: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map((entry) => entry.id) }, "fixture-index", graph.tasks);
	});
	if (mode === "late-remove") pi.on("before_provider_request", (event) => {
		const payload = event.payload as { tools: Array<{ name: string }>; messages: unknown[] };
		return { ...payload, tools: payload.tools.filter((tool) => tool.name !== "csheng_subagent_sessions"), messages: payload.messages.filter((message) => !JSON.stringify(message).includes("Stored local-task index")) };
	});
	if (mode === "manual") {
		let compacted = false;
		pi.on("agent_settled", async (_event, ctx) => {
			if (compacted) return;
			compacted = true;
			await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
		});
	}
}
