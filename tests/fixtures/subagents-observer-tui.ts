import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ManagedObserver } from "../../extensions/subagents/managed-observer.ts";
import { OBSERVER_EVENT, type ObserverSnapshot } from "../../extensions/subagents/observer-events.ts";
import { emptyUsage, type EffectiveRoute } from "../../extensions/subagents/contracts.ts";
import { SESSION_VIEW_CHANGED_EVENT, SESSION_VIEW_EVENT, SESSION_VIEW_REQUEST_EVENT, parseSessionViewRequest, type SessionViewReply } from "../../extensions/subagents/session-view.ts";
import { projectRecordedUsage, type RecordedUsageHandleInput } from "../../extensions/subagents/observability.ts";

/** Synthetic stimulus only: real host/keyboard/rendering, no native child or provider I/O. */
export default async function observerTuiFixture(pi: ExtensionAPI): Promise<void> {
	const agent = process.env.PI_CODING_AGENT_DIR!;
	const historyFixture = process.env.CSHENG_UI_HISTORY_FIXTURE === "1";
	const records = Array.from({ length: historyFixture ? 37 : 1 }, (_, index) => ({ handle: `ui${String(index).padStart(6, "0")}`, episode: historyFixture && index < 12 ? 2 : 1 }));
	let latest: ObserverSnapshot | undefined;
	pi.events.on(SESSION_VIEW_REQUEST_EVENT, data => {
		const request = parseSessionViewRequest(data);
		if (!request || !latest) return;
		const live = latest.tasks.filter(task => task.status === "running" || task.status === "pending");
		const liveIds = new Set(live.map(task => task.id));
		const input = (record: typeof records[number]): RecordedUsageHandleInput => ({ handle: record.handle, expectedEpisodes: record.episode,
			episodes: Array.from({ length: record.episode }, (_, index) => index + 1).filter(episode => !liveIds.has(record.handle) || episode < record.episode).map(episode => {
				const entries = Array.from({ length: historyFixture ? 1 : latest?.tasks[0]?.assistantTurns ?? 0 }, (_, index) => ({ ownerSessionId: record.handle, entryId: `e${episode}-${index}`, kind: "assistant" as const, modelKey: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 } }));
				return { episode, observation: { available: true, ownerSessionId: record.handle, entries, commands: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, contextWindow: null, toolNames: null, capabilityKey: null } };
			}) });
		const history = records.filter(record => !liveIds.has(record.handle));
		const pages = Math.ceil(history.length / 20);
		const page = Math.min(request.page, Math.max(0, pages - 1));
		const reply: SessionViewReply = { version: 4, requestId: request.requestId, ownerSessionId: latest.parentSessionId, anchor: latest.anchor,
			generation: latest.generation, revision: latest.revision, inventory: { state: "ready", complete: true, unreadableRecords: 0 },
			summary: { agents: records.length, acceptedEpisodes: records.reduce((sum, record) => sum + record.episode, 0), liveAgents: live.length, states: { idle: 0, queued: 0, running: live.length, interrupted: 0, closed: history.length } },
			live, usage: projectRecordedUsage(records.map(input)), history: { state: "ready", pageSize: 20, page, totalRows: history.length, totalPages: pages,
				rows: history.slice(page * 20, page * 20 + 20).map(record => ({ handle: record.handle, role: "reviewer", state: "closed", episode: record.episode, acceptedEpisodes: record.episode,
					latestOutcome: "succeeded", onCurrentBranch: true, legacy: false, reportComplete: true, retained: false, recordedUsage: projectRecordedUsage([input(record)]), route: { provider: "fixture-provider", model: "OBSERVER_MODEL", thinking: "high" } })) } };
		pi.events.emit(SESSION_VIEW_EVENT, reply);
	});
	pi.registerProvider("observer-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const tool = context.messages.at(-1)?.role === "user";
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
					content: tool ? [{ type: "toolCall", id: "observer-fixture-call", name: "observer_fixture_work", arguments: {} }] : [{ type: "text", text: "FIXTURE_FINISHED" }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end();
			});
			return stream;
		},
	});
	pi.registerTool({ name: "observer_fixture_work", label: "Observer fixture", description: "Offline observer fixture", parameters: Type.Object({}),
		async execute(_id, _args, signal, update, ctx) {
			const start = performance.now();
			const active = records.slice(0, historyFixture ? 10 : 1);
			const observer = new ManagedObserver("FixtureRun", { repo: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) }, "FixtureGeneration",
				active.map(record => ({ id: record.handle, role: "reviewer", episode: record.episode, replayed: false, objective: "review fixture", route: { provider: "fixture-provider", model: "OBSERVER_MODEL", thinking: "high" } as EffectiveRoute })),
				() => performance.now() - start, snapshot => { latest = snapshot; pi.events.emit(OBSERVER_EVENT, snapshot); });
			observer.begin();
			for (const record of active) observer.childStarted(record.handle);
			await writeFile(join(agent, "observer-ready"), "ready");
			try {
				for (let turn = 1; turn <= (historyFixture ? 600 : 8) && !signal?.aborted; turn++) {
					observer.update(active.map(record => ({ id: record.handle, role: "reviewer", status: "running", output: "", stderr: "", changedPaths: [], convergence: "not-applicable", durationMs: 0, usage: { ...emptyUsage(), turns: Math.min(turn, 8) } })));
					update?.({ content: [{ type: "text", text: "CC_HIDDEN_LIVE_MARKER" }], details: undefined });
					if (historyFixture) { try { await access(join(agent, "observer-release")); break; } catch { /* owned synthetic gate */ } }
					await new Promise(resolve => setTimeout(resolve, historyFixture ? 50 : 500));
				}
				for (const record of active) observer.childStopped(record.handle);
				observer.update(active.map(record => ({ id: record.handle, role: "reviewer", status: "succeeded", output: "", stderr: "", changedPaths: [], convergence: "not-applicable", durationMs: 0, usage: { ...emptyUsage(), turns: 8 } })));
			} finally { observer.finish(signal?.aborted === true, signal?.aborted === true); pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {}); }
			return { content: [{ type: "text", text: "FIXTURE_WORK_DONE" }], details: undefined };
		},
	});
}
