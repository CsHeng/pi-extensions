import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LOOP_FACTS_EVENT, LOOP_NOTICE_ACK, LOOP_NOTICE_TYPE, LOOP_SNAPSHOT_REQUEST, type LoopFacts } from "../../../extensions/shared/loop-facts.ts";

/** Installed CLI, local synthetic provider, native transcript/queues; no network or user state. */
export default function notificationContinuity(pi: ExtensionAPI): void {
	const resume = process.env.NOTIFICATION_FIXTURE_PHASE === "resume";
	const facts: LoopFacts = { version: 1, producer: "retained-shell", availability: "ready", sessionId: null, branchAnchor: null, generation: "1", executions: [] };
	let calls = 0;
	let settled = 0;
	let prefixes = 0;
	let previous: TranscriptContext | undefined;
	const noticeCounts: number[] = [];
	const acknowledgments: string[] = [];
	const finish = (id: string) => {
		facts.executions.push({ id, phase: "terminal", status: "exited", exitCode: 0, disposition: "pending", summary: `Completed fixture execution ${id}.` });
		pi.events.emit(LOOP_FACTS_EVENT, facts);
	};
	pi.on("session_start", (_event, ctx) => {
		facts.sessionId = ctx.sessionManager.getSessionId();
		if (resume) for (const id of ["first", "second"]) facts.executions.push({ id, phase: "terminal", status: "exited", exitCode: 0, disposition: "pending", summary: `Completed fixture execution ${id}.` });
	});
	pi.events.on(LOOP_SNAPSHOT_REQUEST, (raw: any) => raw.accept(facts));
	pi.events.on(LOOP_NOTICE_ACK, (raw: any) => acknowledgments.push(...raw.ids));
	pi.registerTool({ name: "bash", label: "Fixture", description: "Synthetic work or completion", parameters: Type.Object({ finish: Type.Optional(Type.Boolean()) }),
		async execute(_id, args) {
			if (args.finish) finish("first");
			return { content: [{ type: "text", text: "Fixture tool completed." }], details: undefined };
		} });
	pi.on("agent_settled", async (_event, ctx) => {
		settled++;
		if (!resume && settled === 1) finish("second");
		const nativeNotices = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === LOOP_NOTICE_TYPE).length;
		await writeFile(join(process.env.PI_CODING_AGENT_DIR!, `notification-${resume ? "resume" : "initial"}.json`), JSON.stringify({ calls, settled, prefixes, noticeCounts, nativeNotices, acknowledgments }));
	});
	pi.registerProvider("notification-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			if (previous && JSON.stringify(context.messages.slice(0, previous.messages.length)) === JSON.stringify(previous.messages)) prefixes++;
			previous = structuredClone(context);
			noticeCounts.push(context.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Completed fixture execution")).length);
			const call = calls++;
			const tool = resume ? call === 0 : [0, 1, 2, 4].includes(call);
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop", content: [],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			if (tool) {
				const args = { finish: !resume && call === 0 };
				const toolCall = { type: "toolCall" as const, id: `${resume ? "resume" : "initial"}-${call}`, name: "bash", arguments: args };
				message.content = [toolCall];
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				message.content = [{ type: "text", text: "Finished fixture turn." }];
				stream.push({ type: "done", reason: "stop", message });
			}
			stream.end();
			return stream;
		},
	});
}
