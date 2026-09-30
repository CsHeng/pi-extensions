import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function fixture(pi: ExtensionAPI): void {
	let calls = 0;
	pi.registerTool({ name: "bulk", label: "Synthetic bulk", description: "Offline protocol fixture", parameters: Type.Object({}), async execute() {
		return { content: [{ type: "text", text: "x".repeat(350_000) }], details: {} };
	} });
	pi.registerProvider("stream-fixture", {
		baseUrl: "https://unused.invalid", api: "stream-fixture", apiKey: "synthetic",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000_000, maxTokens: 4096 }],
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const retry = process.env.STREAM_FIXTURE_MODE === "retry";
				const failed = retry && calls === 0;
				const tool = !retry && calls < 4;
				calls++;
				const message: AssistantMessage = {
					role: "assistant", content: failed || tool ? [{ type: "toolCall", id: `call-${calls}`, name: "bulk", arguments: {} }] : [{ type: "text", text: "complete synthetic report" }],
					api: "stream-fixture", provider: "stream-fixture", model: "fixture", timestamp: Date.now(),
					stopReason: failed ? "error" : tool ? "toolUse" : "stop",
					...(failed ? { errorMessage: "429 too many requests" } : {}),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				if (failed) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
