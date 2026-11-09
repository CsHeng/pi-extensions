import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/**
 * Loaded before status-footer and work-timing: captures the real footer component and drives a
 * deterministic offline provider. `metric-lanes-observer.ts`, loaded last, samples renders inside
 * the window between work-timing's request-entry append and Pi's assistant persistence.
 */
export interface MetricLanesProbe {
	footer: Component | undefined;
	samples: Array<{ at: string; footer: string; working?: string | undefined; tail: string[] }>;
	working: string | undefined;
	contexts: unknown[];
	payloadLeak: boolean;
}

export function probe(): MetricLanesProbe {
	const holder = globalThis as { __metricLanesProbe?: MetricLanesProbe };
	holder.__metricLanesProbe ??= { footer: undefined, samples: [], working: undefined, contexts: [], payloadLeak: false };
	return holder.__metricLanesProbe;
}

export function renderFooter(): string {
	const component = probe().footer;
	return component ? component.render(400).join("\n").replace(/\x1b\[[0-9;]*m/g, "") : "";
}

export default function metricLanesFixture(pi: ExtensionAPI): void {
	const state = probe();
	let turn = 0;
	pi.on("session_start", (_event, ctx) => {
		const setFooter = ctx.ui.setFooter.bind(ctx.ui);
		ctx.ui.setFooter = ((factory: Parameters<typeof setFooter>[0]) => {
			if (!factory) return setFooter(factory);
			return setFooter((tui, theme, data) => {
				const component = factory(tui, theme, data);
				state.footer = component;
				return component;
			});
		}) as typeof ctx.ui.setFooter;
		const setWorkingMessage = ctx.ui.setWorkingMessage.bind(ctx.ui);
		ctx.ui.setWorkingMessage = (text) => {
			state.working = text;
			setWorkingMessage(text);
		};
	});
	pi.on("context", (event) => {
		state.contexts.push((event.messages as Array<{ role?: string }>).map((message) => message.role));
	});
	pi.on("before_provider_request", (event) => {
		if (JSON.stringify(event.payload ?? null).includes("work-timing")) state.payloadLeak = true;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		// The interaction summary is appended by work-timing's own agent_settled handler; read it next tick.
		setTimeout(async () => {
			await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "metric-lanes.json"), JSON.stringify({
				samples: state.samples,
				contexts: state.contexts,
				payloadLeak: state.payloadLeak,
				finalFooter: renderFooter(),
				entries: ctx.sessionManager.getEntries(),
			}));
			ctx.shutdown();
		}, 50);
	});
	pi.registerProvider("lanes-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const first = turn++ === 0;
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), stopReason: "stop", content: [],
					usage: { input: first ? 1_000 : 200, output: 0, cacheRead: first ? 0 : 1_000, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				// Time to first output.
				await new Promise((resolve) => setTimeout(resolve, 300));
				if (first) {
					message.content.push({ type: "thinking", thinking: "" });
					stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
					for (let index = 0; index < 6; index++) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						const thinking = message.content[0];
						if (thinking?.type === "thinking") thinking.thinking += "tick ";
						message.usage.output += 5;
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: "tick ", partial: message });
					}
					stream.push({ type: "thinking_end", contentIndex: 0, content: "tick ".repeat(6), partial: message });
					const toolCall = { type: "toolCall" as const, id: "lanes-fixture-bash", name: "bash", arguments: { command: "sleep 1" } };
					message.content.push(toolCall);
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(toolCall.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					message.content.push({ type: "text", text: "LANES_DONE" });
					message.usage.output = 10;
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "LANES_DONE", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "LANES_DONE", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
				stream.end();
			})();
			return stream;
		},
	});
}
