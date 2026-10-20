import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContinuationTool, type ContinuationService } from "../../extensions/agents/continuation.ts";
import { ManagedSessionStore } from "../../extensions/agents/managed-sessions.ts";
import { defaultConfig } from "../../extensions/agents/config.ts";
import { emptyUsage } from "../../extensions/agents/contracts.ts";
import { LOOP_FACTS_EVENT, type LoopFacts } from "../../extensions/shared/loop-facts.ts";
import { WORK_TIMING_ENTRY_TYPE } from "../../extensions/work-timing/index.ts";
import { observeExecutionQuiescence, readExecutionQuiescence } from "../../extensions/shared/execution-quiescence.ts";

/** Real host/producers and a deterministic provider; the injected child performs no model I/O. */
export default function timingAsyncFixture(pi: ExtensionAPI): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const gate = join(agentDir, "release-bash");
	const notifications = process.env.TIMING_NOTIFICATIONS !== "0";
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	let context: ExtensionContext | undefined;
	let service: ContinuationService;
	let releaseAgent!: () => void;
	const childGate = new Promise<void>(resolve => { releaseAgent = resolve; });
	let turn = 0;
	let startedAt = 0;
	let settledAt = 0;
	let bashDone = false;
	let agentDone = false;
	let bashSeen = false;
	let agentSeen = false;
	let timingLeaked = false;
	let finishing = false;
	const kinds: string[] = [];
	const counts: number[] = [];
	const trace: unknown[] = [];
	const saveTrace = () => writeFile(join(agentDir, "timing-trace.json"), JSON.stringify({ kinds, counts, bashDone, agentDone, bashSeen, agentSeen, turn, trace }));
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const later = (callback: () => void | Promise<void>, ms: number) => {
		const timer = setTimeout(() => { timers.delete(timer); void callback(); }, ms); timers.add(timer);
	};
	const entries = () => context!.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === WORK_TIMING_ENTRY_TYPE)
		.map(entry => (entry as { data: unknown }).data);
	const finish = () => {
		if (finishing || !context || !bashDone || !agentDone || (notifications && (!bashSeen || !agentSeen))) return;
		if (readExecutionQuiescence(pi, context).state !== "quiescent") return;
		finishing = true;
		later(async () => {
			const proof = { notifications, kinds, counts, entries: entries(), elapsed: settledAt - startedAt, bashSeen, agentSeen, timingLeaked, providerCalls: turn, trace, quiescence: readExecutionQuiescence(pi, context!) };
			await writeFile(join(agentDir, "timing-proof.json"), JSON.stringify(proof));
			for (const view of await service.contextIndex(context!)) await service.execute({ action: "close", handle: view.handle, expectedEpisode: view.episode, disposition: "discard" }, context!);
			await service.shutdown();
			context!.shutdown();
		}, 30);
	};
	service = registerContinuationTool(pi, {
		store: new ManagedSessionStore(agentDir), loadConfig: async () => ({ config: defaultConfig() }),
		runChild: async options => {
			options.onChildStarted?.();
			await new Promise<void>(resolve => {
				const done = () => { options.signal?.removeEventListener("abort", done); resolve(); };
				childGate.then(done); options.signal?.addEventListener("abort", done, { once: true });
				if (options.signal?.aborted) done();
			});
			options.onChildSettled?.();
			return { id: options.task.id, role: options.task.role, status: options.signal?.aborted ? "aborted" : "succeeded", reportComplete: true,
				output: "TIMING_AGENT_DONE", stderr: "", usage: emptyUsage(), durationMs: 1, changedPaths: [], convergence: "not-applicable" };
		},
	});
	const stopObserving = observeExecutionQuiescence(pi, finish);
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("tool_result", async event => {
		const details = event.details as { status?: string; error?: { code?: string } } | undefined;
		trace.push({ tool: event.toolName, error: event.isError, status: details?.status, code: details?.error?.code });
		await saveTrace();
	});
	pi.on("input", (event, ctx) => { trace.push({ input: event.source, mode: ctx.mode }); });
	pi.on("before_agent_start", event => { kinds.push(event.messageType); startedAt ||= performance.now(); });
	pi.events.on(LOOP_FACTS_EVENT, raw => {
		const facts = raw as LoopFacts;
		if (facts.producer === "retained-shell") bashDone ||= facts.executions.some(item => item.phase === "terminal");
		if (facts.producer === "subagents") agentDone ||= facts.executions.some(item => item.phase === "terminal");
		if (!notifications && bashDone && agentDone) { settledAt = performance.now(); finish(); }
	});
	pi.on("agent_settled", async (_event, ctx) => {
		context = ctx; settledAt = performance.now(); counts.push(entries().length);
		await saveTrace();
		if (counts.length === 1) {
			later(() => writeFile(gate, "go"), 350);
			if (!notifications) later(releaseAgent, 650);
		} else if (counts.length === 2 && !agentDone) {
			// The Bash result must reach the model while the sibling is still running.
			later(releaseAgent, 250);
		}
		if (notifications && bashDone && agentDone && bashSeen && agentSeen) finish();
	});
	pi.on("session_shutdown", () => { stopObserving(); for (const timer of timers) clearTimeout(timer); timers.clear(); releaseAgent(); });
	pi.registerProvider("timing-async-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, input) {
			const wire = JSON.stringify(input.messages);
			bashSeen ||= wire.includes("TIMING_BASH_DONE");
			agentSeen ||= wire.includes("Agent task timing-agent");
			timingLeaked ||= input.messages.some(message => (message as { customType?: unknown }).customType === WORK_TIMING_ENTRY_TYPE);
			const call = turn++;
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [],
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				const tool = call === 0 ? { name: "tasklist", args: { operation: "set", title: "Timing fixture", tasks: [{ id: "unfinished", title: "Keep this passive", status: "doing" }] } }
					: call === 1 ? { name: "bash", args: { command: `i=0; while [ ! -f ${quote(gate)} ] && [ "$i" -lt 500 ]; do i=$((i+1)); sleep 0.02; done; [ -f ${quote(gate)} ] || exit 7; printf TIMING_BASH_DONE`, background: true, deadlineSeconds: 15 } }
					: call === 2 ? { name: "agent", args: { action: "create", tasks: [{ id: "timing-agent", role: "explorer", objective: "Controlled offline lifetime", access: [{ permission: "read", scope: context!.cwd }] }] } } : undefined;
				if (tool) {
					const toolCall = { type: "toolCall" as const, id: `timing-call-${call}`, name: tool.name, arguments: tool.args };
					message.content = [toolCall]; message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					message.content = [{ type: "text", text: "TIMING_MAIN_SETTLED" }];
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "TIMING_MAIN_SETTLED", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "TIMING_MAIN_SETTLED", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
				stream.end();
			});
			return stream;
		},
	});
}
