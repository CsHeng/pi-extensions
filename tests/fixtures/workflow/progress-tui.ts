import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Synthetic provider drives the real tasklist tool and real installed TUI; no provider I/O. */
export default function progressFixture(pi: ExtensionAPI): void {
 const dir = process.env.PI_CODING_AGENT_DIR!;
 const actions = [
  { operation: "set", title: "PROGRESS_FIXTURE", tasks: [{ id: "a", title: "STRIKE_DONE_A" }, { id: "b", title: "STRIKE_DONE_B" }] },
  { operation: "update", tasks: [{ id: "a", status: "doing" }] },
  { operation: "update", tasks: [{ id: "a", status: "done" }] },
  { operation: "update", tasks: [{ id: "b", status: "blocked", note: "TRACKING_BLOCKED_FIXTURE" }] },
  { operation: "update", tasks: [{ id: "b", status: "doing", note: null }] },
  { operation: "update", tasks: [{ id: "b", status: "done" }] },
 ];
 let turn = 0;
 pi.on("session_start", async () => { await appendFile(join(dir, "starts"), "start\n"); });
 pi.on("agent_settled", async () => { await writeFile(join(dir, "ready"), "ready"); });
 pi.registerProvider("progress-fixture", {
  baseUrl: "http://invalid.invalid", apiKey: "synthetic", api: "openai-completions",
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model) {
   const stream = createAssistantMessageEventStream();
   void (async () => {
    const action = actions[turn++];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: action ? "toolUse" : "stop", content: [], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    await new Promise(resolve => setTimeout(resolve, 200));
    if (action) {
     const toolCall = { type: "toolCall" as const, id: `progress-${turn}`, name: "tasklist", arguments: action as never };
     message.content = [toolCall];
     stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
     stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(action), partial: message });
     stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
     stream.push({ type: "done", reason: "toolUse", message });
    } else {
     message.content = [{ type: "text", text: "PROGRESS_FIXTURE_FINISHED" }];
     stream.push({ type: "text_start", contentIndex: 0, partial: message });
     stream.push({ type: "text_delta", contentIndex: 0, delta: "PROGRESS_FIXTURE_FINISHED", partial: message });
     stream.push({ type: "text_end", contentIndex: 0, content: "PROGRESS_FIXTURE_FINISHED", partial: message });
     stream.push({ type: "done", reason: "stop", message });
    }
    stream.end();
   })();
   return stream;
  },
 });
}
