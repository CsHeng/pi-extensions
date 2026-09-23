import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function explorerReadPath(input: string): string {
	return /External read roots:\\n- (?!none(?:\\n|"|$))([^\\"]+)/.exec(input)?.[1] ?? "external.txt";
}

function workerCommand(input: string, count: number): string {
	if (process.env.CSHENG_ASYNC_GATES) return `node -e 'const fs=require("node:fs"), root=process.env.CSHENG_ASYNC_GATES, id=process.env.CSHENG_ASYNC_TASK; if(!["fast","slow"].includes(id))process.exit(8); fs.writeFileSync(root+"/started-"+id,"ready"); const timer=setInterval(()=>{if(!fs.existsSync(root+"/release-"+id))return;clearInterval(timer);if(${count}===1&&fs.existsSync("parent-progress"))process.exit(9);fs.writeFileSync(id+".txt","candidate-${count}");},10);setTimeout(()=>process.exit(10),20000).unref();'`;
	if (input.includes("host-inputs-fixture")) return `node -e 'require("node:fs").writeFileSync("candidate.txt", require("pkg"))' && git add -- candidate.txt && git diff --cached --name-only -- candidate.txt`;
	if (input.includes("after-child-compaction-fixture")) return `node -e 'const fs=require("node:fs"); if(fs.readFileSync("candidate.txt","utf8")!=="candidate-1" || fs.readFileSync("node_modules/fixture-state","utf8")!=="retained-local")process.exit(3); fs.appendFileSync("candidate.txt","|continued")'`;
	if (input.includes("private-continuity-fixture")) return "mkdir -p node_modules && printf retained-local > node_modules/fixture-state && printf candidate-1 > candidate.txt";
	if (input.includes("cancel-fixture")) return '(sleep 30; printf orphan > orphan.txt) & descendant=$!; printf \'%s\' "$descendant" > "$TMPDIR/descendant.pid"; wait';
	return `printf 'candidate-${count}' > candidate.txt`;
}

/** In-process synthetic provider: no sockets, credentials, or external requests. */
export default function nativeSessionFixture(pi: ExtensionAPI): void {
	let compactionTriggered = false;
	pi.registerProvider("subagent-fixture", {
		baseUrl: "http://invalid.invalid",
		apiKey: "synthetic-not-a-credential",
		api: "openai-completions",
		models: [{
			id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: process.env.CSHENG_NATIVE_COMPACTION_MODE ? 4096 : 128000, maxTokens: 1024,
		}],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				// The real managed context hook appends an ephemeral index after the
				// request. It is context, not another scripted user/tool transition.
				const last = context.messages.filter((item) => !(item.role === "user" && JSON.stringify(item.content).includes("Stored local-task index"))).at(-1);
				let text = `users=${context.messages.filter((message) => message.role === "user").length}${last?.role === "toolResult" ? `;tool=${JSON.stringify(last.content)}` : ""}`;
				if (process.env.CSHENG_NATIVE_CONTEXT_MODE) {
					const initial = {
						systemPrompt: getCurrentSystemPrompt(context.messages),
						messages: context.messages,
						tools: getCurrentTools(context.messages).map((tool) => ({ name: tool.name })),
					};
					const payload = (await options?.onPayload?.(initial, model) ?? initial) as typeof initial;
					const serialized = JSON.stringify(payload.messages);
					text = serialized.includes("<conversation>") ? "SYNTHETIC_SUMMARY" : `index=${serialized.split("Stored local-task index").length - 1};managedTool=${payload.tools.some((tool) => tool.name === "csheng_subagent_sessions") ? 1 : 0};private=${serialized.includes("PRIVATE_INDEX_PROSE") ? 1 : 0}`;
				}
				if (JSON.stringify(context.messages).includes("<conversation>")) text = "SYNTHETIC_SUMMARY";
				const message: AssistantMessage = {
					role: "assistant", content: [{ type: "text", text }], api: model.api,
					provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const compaction = process.env.CSHENG_NATIVE_COMPACTION_MODE;
				if (compaction && !compactionTriggered && text !== "SYNTHETIC_SUMMARY" && (!JSON.stringify(context.messages).includes("host-worker-fixture") || last?.role === "toolResult")) {
					compactionTriggered = true;
					if (compaction === "threshold") { message.usage.input = 3800; message.usage.totalTokens = 3801; }
					else if (compaction === "overflow") {
						message.content = []; message.stopReason = "error"; message.errorMessage = "exceeds the context window";
						stream.push({ type: "error", reason: "error", error: message }); stream.end(); return;
					}
				}
				const input = last?.role === "user" ? JSON.stringify(last.content) : "";
				if (JSON.stringify(context.messages).includes("guidance-worker-fixture") || JSON.stringify(context.messages).includes("guidance-fixture")) {
					const worker = JSON.stringify(context.messages).includes("guidance-worker-fixture");
					const system = getCurrentSystemPrompt(context.messages);
					const guide = process.env.CSHENG_GUIDANCE_EXPECT_PATH ?? "";
					const results = context.messages.filter(item => item.role === "toolResult");
					if (guide && system.includes(guide) && results.length < 2) {
						message.content = [{ type: "toolCall", id: `guidance-${results.length}`, name: "read", arguments: { path: results.length === 0 ? guide : guide.replace(/SKILL\.md$/, "references/rule.md") } }];
						message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return;
					}
					if (worker && results.length === 2 && JSON.stringify(results).includes("export const answer = 42;")) {
						message.content = [{ type: "toolCall", id: "guidance-candidate", name: "bash", arguments: { command: "printf 'export const answer = 42;\\n' > candidate.ts" } }];
						message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return;
					}
					message.content = [{ type: "text", text: `catalog=${guide && system.includes(guide) ? 1 : 0};ancestor=${system.includes("ancestor context") ? 1 : 0};snapshot=${system.includes("snapshot override") ? 1 : 0};managed=${system.includes("unrelated managed context") ? 1 : 0};reads=${results.length};reference=${JSON.stringify(results).includes("reference marker") ? 1 : 0};forbidden=${system.includes(process.env.CSHENG_GUIDANCE_FORBIDDEN_PATH ?? "<no-forbidden-path>") ? 1 : 0}` }];
				}
				else if (text !== "SYNTHETIC_SUMMARY" && input.includes("parent-observation-fixture")) {
					const prior = context.messages.filter((item) => item.role === "toolResult" && item.toolName === "csheng_subagent_sessions").at(-1);
					const priorText = prior?.role === "toolResult" ? prior.content.find((part) => part.type === "text") : undefined;
					const view = priorText?.type === "text" ? JSON.parse(priorText.text).sessions[0] : undefined;
					const arguments_ = input.includes("continue-parent-observation-fixture")
						? { action: "continue", episodes: [{ handle: view.handle, requestId: "continue", expectedEpisode: view.episode, message: "host-worker-fixture" }] }
						: { action: "create", requestId: "create", tasks: [{ id: "worker", role: "worker", objective: "host-worker-fixture", scope: ["."], writePaths: ["candidate.txt"] }] };
					message.content = [{ type: "toolCall", id: `parent-${context.messages.filter((item) => item.role === "user").length}`, name: "csheng_subagent_sessions", arguments: arguments_ }];
					message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return;
				}
				if (input.includes("after-child-compaction-fixture") && !JSON.stringify(context.messages).includes("SYNTHETIC_SUMMARY")) {
					message.stopReason = "error"; message.errorMessage = "fixture_requires_retained_summary";
					stream.push({ type: "error", reason: "error", error: message }); stream.end(); return;
				}
				if (text !== "SYNTHETIC_SUMMARY" && (input.includes("host-worker-fixture") || input.includes("host-reviewer-fixture") || input.includes("host-explorer-fixture"))) {
					const count = context.messages.filter((item) => item.role === "user").length;
					message.content = [input.includes("host-reviewer-fixture")
						? { type: "toolCall", id: `fixture-${count}`, name: "read", arguments: { path: "candidate.txt" } }
						: input.includes("host-explorer-fixture") ? { type: "toolCall", id: `fixture-${count}`, name: "read", arguments: { path: explorerReadPath(input) } }
						: input.includes("host-search-fixture") ? { type: "toolCall", id: `fixture-${count}`, name: "find", arguments: { pattern: "*.txt", path: "." } }
						: { type: "toolCall", id: `fixture-${count}|provider:command`, name: "bash", arguments: { command: workerCommand(input, count) } }];
					message.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message });
					stream.end();
					return;
				}
				const thinking = text !== "SYNTHETIC_SUMMARY" && JSON.stringify(context.messages).includes("thinking-fixture");
				if (thinking) message.content.unshift({ type: "thinking", thinking: "fixture-private-thinking" });
				stream.push({ type: "start", partial: message });
				if (thinking && !JSON.stringify(context.messages).includes("done-only-thinking-fixture")) {
					stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: "fixture-private-thinking", partial: message });
					stream.push({ type: "thinking_end", contentIndex: 0, content: "fixture-private-thinking", partial: message });
				}
				stream.push({ type: "text_delta", contentIndex: thinking ? 1 : 0, delta: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
