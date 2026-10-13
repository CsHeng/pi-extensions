import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Real installed Pi with a synthetic provider only (no network or private API). The first
 * run is an RPC user prompt. Once that run settles and Pi is idle, the fixture starts an
 * internal run exactly the way the subagent extension wakes the parent:
 * `pi.sendMessage(..., { triggerTurn: true })`. The Bark adapter must notify only for the
 * user run. The fixture records the observed run kinds so the test can prove both runs ran.
 */
export default function agentBarkCustomWake(pi: ExtensionAPI): void {
	let calls = 0;
	let settled = 0;
	const starts: string[] = [];

	const emit = (stream: ReturnType<typeof createAssistantMessageEventStream>, message: AssistantMessage, text: string) => {
		message.content = [{ type: "text", text }];
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	};

	pi.on("before_agent_start", (event) => { starts.push(event.messageType); });
	pi.on("agent_settled", async (_event, ctx) => {
		settled += 1;
		if (settled === 1) {
			// Pi is idle after the user run settles; this is the only point at which a
			// custom message with triggerTurn starts a fresh run. Wait for idleness so the
			// fixture does not depend on settlement-handler ordering.
			let attempts = 0;
			const wake = () => {
				if (attempts++ < 40 && !ctx.isIdle()) { setTimeout(wake, 25); return; }
				pi.sendMessage({
					customType: "agent-bark-fixture-wake",
					content: "Subagent execution evidence is ready (fixture).",
					display: false,
				}, { triggerTurn: true });
			};
			setTimeout(wake, 60);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "agent-bark-proof.json"), JSON.stringify({ calls, settled, starts }));
		ctx.shutdown();
	});

	pi.registerProvider("agent-bark-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			const call = calls++;
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: message });
			emit(stream, message, call === 0 ? "user run reply" : "internal wake reply");
			stream.end();
			return stream;
		},
	});
}
