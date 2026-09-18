import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { WorksetState } from "../../../extensions/workflow/contracts.ts";

/** Synthetic provider and public-UI render trace; actual Pi still owns tools, rendering and session replacement. */
export default function workflowUiFixture(pi: ExtensionAPI): void {
	const directory = process.env.PI_CODING_AGENT_DIR!;
	const path = (name: string) => join(directory, `workflow-ui-${name}.json`);
	let context: ExtensionContext;
	let calls = 0;
	let stage = 0;
	let widget: string[] = [];
	let overlay: string[] = [];
	let widgetWidth = 0;
	let overlayWidth = 0;
	let settled = 0;
	let revision = 0;
	const state = (): WorksetState | undefined => {
		const entry = context?.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "csheng-workflow-state");
		return entry?.type === "custom" ? (entry.data as { state: WorksetState }).state : undefined;
	};
	const save = () => {
		const current = state();
		writeFileSync(path("proof"), JSON.stringify({ calls, stage, settled, widget, overlay, widgetWidth, overlayWidth,
			rows: process.stdout.rows, columns: process.stdout.columns, revision: current?.revision ?? 0,
			generation: current?.workset.inputGeneration, review: current?.workset.review.used,
			goal: current?.workset.goal, disposition: current?.workset.disposition }));
	};
	pi.on("session_start", (event, ctx) => {
		context = ctx;
		// Test-only taps retain the real public factory and every host render; no runtime UI method is replaced in production.
		const originalWidget = ctx.ui.setWidget.bind(ctx.ui);
		ctx.ui.setWidget = (key, content, options) => {
			if (key !== "csheng.workflow.tasks") {
				if (typeof content === "function") originalWidget(key, content, options);
				else originalWidget(key, content, options);
				return;
			}
			if (typeof content !== "function") { widget = content ?? []; save(); originalWidget(key, content, options); return; }
			originalWidget(key, (tui, theme) => {
				const component = content(tui, theme);
				const render = component.render.bind(component);
				component.render = width => { const lines = render(width); widget = lines.map(stripAnsi); widgetWidth = width; save(); return lines; };
				return component;
			}, options);
		};
		const originalCustom = ctx.ui.custom.bind(ctx.ui);
		ctx.ui.custom = async (factory, options) => {
			try {
				return await originalCustom(async (...args) => {
					const component = await factory(...args);
					const render = component.render.bind(component);
					component.render = width => { const lines = render(width); overlay = lines.map(stripAnsi); overlayWidth = width; save(); return lines; };
					return component;
				}, options);
			} finally { overlay = []; save(); }
		};
		writeFileSync(path(`session-${event.reason}`), JSON.stringify({ reason: event.reason }));
		save();
	});
	pi.on("session_tree", (_event, ctx) => { context = ctx; save(); writeFileSync(path("tree"), "true"); });
	pi.on("agent_settled", () => { settled++; save(); });
	pi.on("tool_result", event => {
		if (event.toolName !== "csheng_workflow") return;
		const result = event.details as { ok: boolean; revision?: number; code?: string };
		if (result.ok) revision = result.revision!;
		writeFileSync(path(`result-${stage}`), JSON.stringify(result));
		save();
	});
	pi.registerCommand("workflow-fixture-resize", { description: "Resize this disposable test terminal", handler: async (args) => {
		const [columns, rows] = args.split(" ").map(Number);
		if (![80, 160].includes(columns!) || ![20, 40].includes(rows!)) throw new Error("Unsupported fixture dimensions");
		const result = spawnSync("stty", ["cols", String(columns), "rows", String(rows)], { stdio: ["inherit", "pipe", "pipe"] });
		if (result.status !== 0) throw new Error("Fixture terminal resize failed");
	} });
	pi.registerCommand("workflow-fixture-proof", { description: "Capture synthetic read-only proof", handler: async () => { save(); } });
	pi.registerCommand("workflow-fixture-branch", { description: "Navigate to the pre-workflow branch", handler: async (_args, ctx) => {
		writeFileSync(path("branch-command"), "true");
		const first = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
		if (!first) throw new Error("Missing initial fixture input");
		await ctx.navigateTree(first.id, { summarize: false });
		ctx.ui.setEditorText("");
		writeFileSync(path("branch-ready"), "true");
	} });
	pi.registerCommand("workflow-fixture-new", { description: "Replace the fixture session", handler: async (_args, ctx) => { await ctx.newSession(); } });
	const operations: Array<Record<string, unknown>> = [
		{ operation: "open", expectedRevision: 0, goal: "WORKFLOW_UI_GOAL", deliveryEndpoint: "synthetic source",
			criteria: [{ key: "c", outcome: "Synthetic UI criterion", verification: "PTY" }],
			tasks: Array.from({ length: 25 }, (_, index) => ({ key: `task${index + 1}`, outcome: `UI_TASK_${String(index + 1).padStart(2, "0")}`, covers: ["c"] })),
			reviewPolicy: { maxAutomaticReviewsPerInputEpoch: 0 } },
		{ operation: "start", taskId: "T-1", basis: { scope: ["basis"] } },
		{ operation: "record", attemptId: "AT-1", attempt: { state: "reported", outcome: "Synthetic task reported" },
			evidence: { provenance: "agent_declared", subject: { kind: "task", id: "T-1" }, attemptId: "AT-1", scope: ["basis"], checkIdentity: "Synthetic UI stimulus", result: "pass" } },
		{ operation: "assess", subject: { kind: "task", id: "T-1" }, verdict: "accepted", evidenceIds: ["EV-1"], rationale: "Synthetic evidence accepted" },
		{ operation: "start", taskId: "T-2", basis: { scope: ["basis"] } },
		{ operation: "record", attemptId: "AT-2", attempt: { state: "failed", outcome: "Synthetic blocked task" },
			taskDisposition: { disposition: "blocked", reason: "UI_BLOCK_REASON", blockClass: "missing_capability", nextUnblockCondition: "Synthetic capability" } },
		{ operation: "amend", reason: "Synthetic amended outcome", intentReference: "fixture", changes: [{ kind: "update_task", id: "T-3", outcome: "UI_AMENDED_TASK" }] },
		{ operation: "close", outcome: "cancelled", reason: "Synthetic UI scenario concluded" },
	];
	pi.registerProvider("workflow-ui-fixture", {
		baseUrl: "http://invalid.invalid", apiKey: "synthetic-not-a-credential", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, _messages, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				calls++; save();
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), stopReason: "stop", content: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				const deadline = Date.now() + 45_000;
				while (stage < operations.length && (!existsSync(path("release")) || Number(readFileSync(path("release"), "utf8")) < stage + 1)) {
					if (options?.signal?.aborted || Date.now() > deadline) { stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }); stream.end(); return; }
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				const operation = operations[stage++];
				if (operation) {
					const args = { expectedRevision: revision, ...operation };
					const toolCall = { type: "toolCall" as const, id: `workflow-ui-${stage}`, name: "csheng_workflow", arguments: args };
					message.content = [toolCall]; message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					message.content = [{ type: "text", text: "WORKFLOW_UI_DONE" }];
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "WORKFLOW_UI_DONE", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "WORKFLOW_UI_DONE", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
				stream.end();
			})();
			return stream;
		},
	});
}
