import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Real CLI stimulus, synthetic provider only; no network, private API or UI patch. */
export default function installedContinuation(pi: ExtensionAPI): void {
	let calls = 0;
	let settled = 0;
	const starts: number[] = [];
	const sources: string[] = [];
	const facts: unknown[] = [];
	pi.on("agent_start", (_event, ctx) => { facts.push({ mode: ctx.mode, trusted: ctx.isProjectTrusted(), signal: !!ctx.signal, idle: ctx.isIdle() }); });
	pi.on("input", (event) => { sources.push(event.source); });
	pi.on("before_agent_start", () => { starts.push(settled); });
	pi.on("agent_settled", async (_event, ctx) => {
		// This consumer is loaded AFTER workflow. An early timer/idle re-entry would record 0 twice.
		await new Promise((resolve) => setTimeout(resolve, 40));
		settled += 1;
		const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state") as { data: { state: { workset: { disposition: string; review: { used: number } } } } };
		await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "continuation-proof.json"), JSON.stringify({ calls, settled, starts, sources, disposition: last.data.state.workset.disposition, used: last.data.state.workset.review.used, facts }));
		if (settled === 2) ctx.shutdown();
	});
	pi.registerProvider("workflow-installed-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			const call = calls++;
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "start", partial: message });
			if (call === 0 || call === 2) {
				const args = call === 0
					? { operation: "open", expectedRevision: 0, goal: "Installed continuation", deliveryEndpoint: "fixture", criteria: [{ key: "c", outcome: "criterion", verification: "check" }], tasks: [{ key: "t", outcome: "task", covers: ["c"] }] }
					: { operation: "pause", expectedRevision: 2, reason: "fixture records a real waiting disposition" };
				const toolCall = { type: "toolCall" as const, id: `fixture-${call}`, name: "csheng_workflow", arguments: args };
				message.content = [toolCall]; message.stopReason = "toolUse";
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				const text = call === 1 ? "premature stop" : "explicitly paused";
				message.content = [{ type: "text", text }];
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			}
			stream.end();
			return stream;
		},
	});
}
