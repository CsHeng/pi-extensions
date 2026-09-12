import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline stimulus and writer trace for the real host; never uses provider I/O. */
export default function workTimingTuiFixture(pi: ExtensionAPI): void {
	const writes: Array<{ at: number; text: string | undefined }> = [];
	pi.on("session_start", (_event, ctx) => {
		// Test-only interception: record every writer, while still rendering in the real TUI.
		const original = ctx.ui.setWorkingMessage.bind(ctx.ui);
		ctx.ui.setWorkingMessage = (text) => {
			writes.push({ at: performance.now(), text });
			original(text);
		};
	});
	pi.on("agent_settled", async (_event, ctx) => {
		await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "working-writes.json"), JSON.stringify(writes));
		ctx.shutdown();
	});
	pi.registerProvider("working-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), stopReason: "stop", content: [{ type: "thinking", thinking: "" }],
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
				for (let index = 0; index < 24; index++) {
					await new Promise(resolve => setTimeout(resolve, 125));
					const thinking = message.content[0];
					if (thinking?.type === "thinking") thinking.thinking += "tick ";
					message.usage.output += 2;
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: "tick ", partial: message });
				}
				stream.push({ type: "thinking_end", contentIndex: 0, content: "tick ".repeat(24), partial: message });
				message.content.push({ type: "text", text: "WORKING_FIXTURE_DONE" });
				stream.push({ type: "text_start", contentIndex: 1, partial: message });
				stream.push({ type: "text_delta", contentIndex: 1, delta: "WORKING_FIXTURE_DONE", partial: message });
				stream.push({ type: "text_end", contentIndex: 1, content: "WORKING_FIXTURE_DONE", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			})();
			return stream;
		},
	});
}
