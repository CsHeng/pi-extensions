import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ManagedObserver } from "../../extensions/subagents/managed-observer.ts";
import { OBSERVER_EVENT } from "../../extensions/subagents/observer-events.ts";
import { emptyUsage, type EffectiveRoute } from "../../extensions/subagents/contracts.ts";

/** Synthetic UI stimulus: real host/tool/observer/CC, no native child or provider I/O. */
export default function observerTuiFixture(pi: ExtensionAPI): void {
	pi.registerProvider("observer-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const tool = context.messages.at(-1)?.role === "user";
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
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
			const observer = new ManagedObserver("fixture-run", { repo: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(entry => entry.id) }, "fixture-generation",
				[{ id: "fixture-task", role: "reviewer", episode: 1, replayed: false, objective: "review fixture", route: { provider: "fixture-provider", model: "OBSERVER_MODEL", thinking: "high" } as EffectiveRoute }],
				() => performance.now() - start, snapshot => pi.events.emit(OBSERVER_EVENT, snapshot));
			observer.begin(); observer.childStarted("fixture-task");
			await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "observer-ready"), "ready");
			try {
				for (let turn = 1; turn <= 8 && !signal?.aborted; turn++) {
					observer.update([{ id: "fixture-task", role: "reviewer", status: "running", output: "", stderr: "", changedPaths: [], convergence: "not-applicable", durationMs: 0, usage: { ...emptyUsage(), turns: turn } }]);
					update?.({ content: [{ type: "text", text: "CC_HIDDEN_LIVE_MARKER" }], details: undefined });
					await new Promise(resolve => setTimeout(resolve, 500));
				}
				observer.childStopped("fixture-task");
				observer.update([{ id: "fixture-task", role: "reviewer", status: "succeeded", output: "", stderr: "", changedPaths: [], convergence: "not-applicable", durationMs: 0, usage: { ...emptyUsage(), turns: 8 } }]);
			} finally { observer.finish(signal?.aborted === true, signal?.aborted === true); }
			return { content: [{ type: "text", text: "FIXTURE_WORK_DONE" }], details: undefined };
		},
	});
}
