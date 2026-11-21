import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Scripted synthetic provider for managed peer children. The assignment carries
 * `SCRIPT=<json>` with steps `{ id, when?, tool?, text? }`. Each request performs the first
 * step whose `when` text is present in the context and whose marker is absent; a text step
 * ends the turn. `{seen:X}` in a text step becomes 1 when X appears in the context.
 */
interface Step { id: string; when?: string; tool?: { name: string; arguments: JsonObject }; text?: string }

export default function peerChildFixture(pi: ExtensionAPI): void {
	pi.registerProvider("peer-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: ["m", "m2"].map(id => ({ id, name: id, reasoning: false, input: ["text"] as Array<"text">, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 })),
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const raw = JSON.stringify(context.messages);
				const match = /SCRIPT=(\[.*?\])ENDSCRIPT/.exec(raw.replaceAll("\\\"", "\""));
				const steps: Step[] = match ? JSON.parse(match[1]!) : [];
				// Conditions and markers read the conversation, not the script itself.
				const wire = raw.replace(/SCRIPT=.*?ENDSCRIPT/g, "");
				const step = steps.find(item => !wire.includes(`step-${item.id}`) && (!item.when || wire.includes(item.when)));
				const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "step-none: no step" }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				if (step?.tool) {
					message.content = [{ type: "toolCall", id: `step-${step.id}`, name: step.tool.name, arguments: step.tool.arguments }];
					message.stopReason = "toolUse";
				} else if (step) {
					const text = (step.text ?? "").replace(/\{seen:([^}]+)\}/g, (_all, needle: string) => wire.includes(needle) ? "1" : "0");
					message.content = [{ type: "text", text: `step-${step.id}: ${text}` }];
				}
				stream.push({ type: "done", reason: message.stopReason as "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
