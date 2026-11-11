import { readFile } from "node:fs/promises";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline native-child transport stimulus; no semantic review or provider I/O. */
export default async function gitReadFixture(pi: ExtensionAPI): Promise<void> {
 const actions = JSON.parse(await readFile(process.env.GIT_READ_FIXTURE_INPUTS!, "utf8")) as ToolCall["arguments"][];
 let turn = 0;
 pi.registerProvider("git-read-fixture", {
  baseUrl: "http://invalid.invalid", apiKey: "synthetic", api: "openai-completions",
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model) {
   const stream = createAssistantMessageEventStream();
   void (async () => {
    const action = actions[turn++];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: action ? "toolUse" : "stop", content: [], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    if (action) {
     const toolCall = { type: "toolCall" as const, id: `git-read-${turn}`, name: "git_read", arguments: action };
     message.content = [toolCall];
     stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
     stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(action), partial: message });
     stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
     stream.push({ type: "done", reason: "toolUse", message });
    } else {
     const text = JSON.stringify({ fixture: "GIT_READ_NATIVE_DONE", tools: pi.getActiveTools() });
     message.content = [{ type: "text", text }]; stream.push({ type: "text_start", contentIndex: 0, partial: message });
     stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
     stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
     stream.push({ type: "done", reason: "stop", message });
    }
    stream.end();
   })();
   return stream;
  },
 });
}
