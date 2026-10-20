import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Deterministic installed-host fixture: records each provider request and answers synthetically.
 * No network, no credentials, no renderer patch. Used only by the multi-skill mention host test.
 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: string };
			return block.type === "text" ? block.text ?? "" : `<${block.type ?? "unknown"}>`;
		})
		.join("");
}

export default function multiSkillHostFixture(pi: ExtensionAPI): void {
	const agentDirectory = process.env.PI_CODING_AGENT_DIR;
	if (!agentDirectory) throw new Error("fixture requires PI_CODING_AGENT_DIR");
	let call = 0;

	pi.on("session_start", () => {
		writeFileSync(join(agentDirectory, "multi-skill-ready"), "ready");
	});

	pi.registerProvider("multi-skill-fixture", {
		baseUrl: "http://invalid.invalid",
		apiKey: "synthetic-not-a-credential",
		api: "openai-completions",
		models: [{
			id: "fixture",
			name: "Fixture",
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
		streamSimple(model, context) {
			const index = call++;
			mkdirSync(agentDirectory, { recursive: true });
			writeFileSync(join(agentDirectory, `multi-skill-capture-${index}.json`), JSON.stringify({
				call: index,
				messages: context.messages.map((message) => ({ role: message.role, text: textOf(message.content) })),
			}));
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: "stop",
				content: [],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const text = `fixture reply ${index}`;
			message.content = [{ type: "text", text }];
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	});
}
