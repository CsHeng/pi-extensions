import { readFile, writeFile } from "node:fs/promises";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Synthetic provider for retained-shell host checks. It records real model requests.
 * No network or live model call.
 */
export default function retainedShellProvider(pi: ExtensionAPI): void {
	let calls = 0;
	let executionId = "";
	let firstToolCallId = "";
	let terminalRequests = 0;
	let reminderRequests = 0;
	let reminderInRequest = false;
	const trackedGoal = "Track the shell";
	const trackedTitle = "Wait for the shell";
	const mode = process.env.RETAINED_SHELL_EXPECT ?? "idle";
	const startedAt = Date.now();
	const silent = "printf 'start\\n' >> \"$RETAINED_SHELL_MARKER\"; echo $$ > \"$RETAINED_SHELL_PID\"; while [ ! -f \"$RETAINED_SHELL_RELEASE\" ]; do sleep 0.1; done; printf 'finished\\n' >> \"$RETAINED_SHELL_MARKER\"";

	const proofPath = (): string => {
		const dir = process.env.PI_CODING_AGENT_DIR;
		if (!dir) throw new Error("PI_CODING_AGENT_DIR is required");
		return `${dir}/retained-shell-proof.json`;
	};
	const contextText = (context: unknown): string => JSON.stringify((context as { messages?: unknown[] }).messages ?? []);
	const toolTexts = (context: unknown): Array<{ toolCallId?: string; text: string }> => {
		const messages = (context as { messages?: Array<{ role?: string; toolCallId?: string; toolName?: string; content?: Array<{ type?: string; text?: string }> }> }).messages ?? [];
		return messages.filter((message) => message.role === "toolResult" && message.toolName === "bash").map((message) => ({
			...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
			text: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
		}));
	};
	const emit = (stream: ReturnType<typeof createAssistantMessageEventStream>, message: AssistantMessage, content: AssistantMessage["content"], reason: "toolUse" | "stop") => {
		message.content = content;
		message.stopReason = reason;
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason, message });
		stream.end();
	};
	const messageFor = (model: { api: AssistantMessage["api"]; provider: string; id: string }): AssistantMessage => ({
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});

	// Observe native user messages before custom task projections are converted for the provider.
	// Identify this fixture's task data, not the product's reminder wording.
	pi.on("context", event => {
		reminderInRequest = event.messages.some(message => {
			if (message.role !== "user") return false;
			const content = typeof message.content === "string" ? message.content
				: message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			return content.includes(trackedGoal) && content.includes(trackedTitle);
		});
	});

	pi.registerProvider("retained-shell-fixture", {
		baseUrl: "http://invalid.invalid",
		apiKey: "synthetic-not-a-credential",
		api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const call = calls++;
			const message = messageFor(model);
			void (async () => {
				const text = contextText(context);
				const results = toolTexts(context);
				if (mode === "reject") {
					if (call === 0) {
						emit(stream, message, [{ type: "toolCall", id: "unsupported-call", name: "bash", arguments: { command: "printf started > \"$PI_CODING_AGENT_DIR/unsupported-effect\"", background: true } }], "toolUse");
						return;
					}
					await writeFile(proofPath(), JSON.stringify({ mode, calls, toolResultPresent: results.length === 1, started: await fileExists(`${process.env.PI_CODING_AGENT_DIR}/unsupported-effect`) }));
					emit(stream, message, [{ type: "text", text: "unsupported request rejected" }], "stop");
					return;
				}
				if (mode === "drain") {
					if (call === 0) {
						emit(stream, message, [{ type: "toolCall", id: "drain-call", name: "bash", arguments: { command: "sleep 3; printf drained\\n" } }], "toolUse");
						return;
					}
					const joined = results.map((item) => item.text).join("\n");
					await writeFile(proofPath(), JSON.stringify({ mode, calls, elapsedMs: Date.now() - startedAt, text: joined, running: joined.includes("status: running") }));
					emit(stream, message, [{ type: "text", text: "drain complete" }], "stop");
					return;
				}
				if (mode === "before-return") {
					if (call === 0) {
						emit(stream, message, [{ type: "toolCall", id: "start-call", name: "bash", arguments: { command: "printf 'done\\n'", foregroundSeconds: 2 } }], "toolUse");
						return;
					}
					const current = results.at(-1);
					await writeFile(proofPath(), JSON.stringify({
						mode, calls, elapsedMs: Date.now() - startedAt,
						returned: current?.text.includes("status: exited") === true,
						running: current?.text.includes("status: running") === true,
						wake: text.includes("Shell execution"),
						toolCallIds: results.map((item) => item.toolCallId),
					}));
					emit(stream, message, [{ type: "text", text: "returned terminal" }], "stop");
					return;
				}
				if (mode === "busy") {
					if (call === 0) {
						emit(stream, message, [{ type: "toolCall", id: "start-call", name: "bash", arguments: { command: "sleep 0.4; printf 'finished\\n'", background: true, deadlineSeconds: 30 } }], "toolUse");
						return;
					}
					if (call === 1) {
						await new Promise((resolve) => setTimeout(resolve, 700));
						await writeFile(proofPath(), JSON.stringify({ mode, phase: "busy", calls, projected: text.includes("Shell execution") }));
						emit(stream, message, [{ type: "toolCall", id: "continue-call", name: "bash", arguments: { command: "printf 'next\\n'", foregroundSeconds: 2 } }], "toolUse");
						return;
					}
					await writeFile(proofPath(), JSON.stringify({
						mode, phase: "next", calls, projected: text.includes("Shell execution"),
						sameExecution: text.includes("finished") || text.includes("status exited") || text.includes("status: exited"),
						roles: [...text.matchAll(/"role":"([^"]+)"/g)].map((match) => match[1]).slice(0, 12),
						excerpt: text.slice(0, 500),
					}));
					emit(stream, message, [{ type: "text", text: "busy projected" }], "stop");
					return;
				}
				if (mode === "coload") {
					if (call === 0) {
						emit(stream, message, [{ type: "toolCall", id: "track-call", name: "tasklist", arguments: { operation: "set", title: trackedGoal, tasks: [{ id: "shell", title: trackedTitle, status: "todo" }] } }], "toolUse");
						return;
					}
					if (call === 1) {
						emit(stream, message, [{ type: "toolCall", id: "start-call", name: "bash", arguments: { command: "sleep 0.3; printf 'finished\\n'", background: true, deadlineSeconds: 30 } }], "toolUse");
						return;
					}
					if (call === 2) {
						await new Promise((resolve) => setTimeout(resolve, 600));
						emit(stream, message, [{ type: "text", text: "independent answer" }], "stop");
						return;
					}
					const reminder = reminderInRequest;
					const shellTerminal = text.includes("Shell execution");
					if (shellTerminal) terminalRequests += 1;
					if (reminder) reminderRequests += 1;
					await writeFile(proofPath(), JSON.stringify({ mode, calls, reminder, delivered: terminalRequests > 0, terminalRequests, reminderRequests }));
					emit(stream, message, [{ type: "text", text: "shared turn" }], "stop");
					return;
				}
				if (call === (mode === "coload" ? 1 : 0)) {
					emit(stream, message, [{ type: "toolCall", id: "start-call", name: "bash", arguments: { command: silent, background: true, deadlineSeconds: 30 } }], "toolUse");
					return;
				}
				if (results.length > 0 && !executionId) {
					const current = results.at(-1);
					executionId = current?.text.match(/^execution_id: (\S+)$/m)?.[1] ?? "";
					firstToolCallId = current?.toolCallId ?? "";
					const marker = process.env.RETAINED_SHELL_MARKER;
					const release = process.env.RETAINED_SHELL_RELEASE;
					await writeFile(proofPath(), JSON.stringify({
						mode,
						whileAlive: {
							calls, executionId, toolCallId: firstToolCallId,
							toolResultPresent: Boolean(current?.text.includes("status: running") && executionId),
							marker: marker ? await waitForMarker(marker) : "",
							releaseExists: release ? await fileExists(release) : true,
							elapsedMs: Date.now() - startedAt,
						},
					}));
					emit(stream, message, [{ type: "text", text: "independent answer" }], "stop");
					return;
				}
				const ids = results.map((item) => item.toolCallId).filter((id): id is string => id !== undefined);
				await writeFile(proofPath(), JSON.stringify({
					mode, calls, executionId,
					delivered: text.includes(executionId) && text.includes("Shell execution"),
					reminder: reminderInRequest,
					firstIdCount: ids.filter((id) => id === firstToolCallId).length,
					toolCallIds: ids,
				}));
				emit(stream, message, [{ type: "text", text: "delivered terminal" }], "stop");
			})().catch((error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				message.stopReason = "error";
				message.errorMessage = text;
				stream.push({ type: "error", reason: "error", error: message });
				stream.end();
			});
			return stream;
		},
	});
}

/** The native operation spawns asynchronously; wait for the command's first effect instead of racing it. */
async function waitForMarker(path: string): Promise<string> {
	const started = Date.now();
	for (;;) {
		const text = await readFile(path, "utf8").catch(() => "");
		if (text.length > 0 || Date.now() - started > 2_000) return text;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}
