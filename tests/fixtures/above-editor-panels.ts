/** Offline facts for the real-host above-editor interaction test; no model or execution work. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OBSERVER_EVENT, type ObserverSnapshot } from "../../extensions/subagents/observer-events.ts";
import { SESSION_VIEW_REQUEST_EVENT, SESSION_VIEW_EVENT, SESSION_VIEW_CHANGED_EVENT, parseSessionViewRequest, type SessionViewReply } from "../../extensions/subagents/session-view.ts";
import { projectRecordedUsage } from "../../extensions/subagents/observability.ts";
import { TASKS_VIEW_EVENT, TASKS_VIEW_REQUEST_EVENT, TASKS_VIEW_CHANGED_EVENT, type TasksViewReply } from "../../extensions/workflow/tasks-view.ts";
import { JOBS_VIEW_EVENT, JOBS_VIEW_REQUEST_EVENT, JOBS_VIEW_CHANGED_EVENT, type JobsViewReply } from "../../extensions/retained-shell/jobs-view.ts";

export default function panelsFixture(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let revision = 1;
	let snapshot: ObserverSnapshot | undefined;
	let pendingSessionRequest: string | undefined;
	const generation = "PanelsFixture";
	const owner = () => ({ ownerSessionId: ctx!.sessionManager.getSessionId(), anchor: ctx!.sessionManager.getLeafId() });
	pi.events.on(TASKS_VIEW_REQUEST_EVENT, (data: unknown) => {
		if (!ctx) return;
		pi.events.emit(TASKS_VIEW_EVENT, {
			version: 1, requestId: (data as { requestId: string }).requestId, ...owner(), generation, availability: "ready",
			state: { revision, goal: "Panel interaction", paused: false, cancelled: false,
				tasks: [{ id: "task", title: revision > 1 ? "Task inline updated" : "Task inline detail", status: "doing" }] },
		} satisfies TasksViewReply);
	});
	pi.events.on(JOBS_VIEW_REQUEST_EVENT, (data: unknown) => {
		if (!ctx) return;
		pi.events.emit(JOBS_VIEW_EVENT, {
			version: 1, requestId: (data as { requestId: string }).requestId, ...owner(), generation, availability: "ready",
			records: [{ executionId: "exec_panel", label: "Job inline detail", status: "exited", exitCode: 0,
				startedAt: 1_000, terminalAt: 2_000, lastOutputAt: 1_500 }],
		} satisfies JobsViewReply);
	});
	const replySession = (requestId: string) => {
		if (!ctx || !snapshot) return;
		pi.events.emit(SESSION_VIEW_EVENT, {
			version: 4, requestId, ...owner(), generation, revision,
			inventory: { state: "ready", complete: true, unreadableRecords: 0 },
			summary: { agents: 1, acceptedEpisodes: 1, liveAgents: 1, states: { idle: 0, queued: 0, running: 1, interrupted: 0, closed: 0 } },
			live: snapshot.tasks, usage: projectRecordedUsage([]),
			history: { state: "ready", pageSize: 20, page: 0, totalRows: 0, totalPages: 0, rows: [] },
		} satisfies SessionViewReply);
	};
	pi.events.on(SESSION_VIEW_REQUEST_EVENT, data => {
		const request = parseSessionViewRequest(data);
		if (!request) return;
		pendingSessionRequest = request.requestId;
		replySession(request.requestId);
	});
	const publish = () => {
		if (!ctx) return;
		pi.events.emit(TASKS_VIEW_CHANGED_EVENT, { version: 1, generation });
		pi.events.emit(JOBS_VIEW_CHANGED_EVENT, { version: 1, generation });
		snapshot = {
			version: 4, parentSessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(),
			generation, runId: "PanelRun", revision, phase: "running",
			tasks: [{ id: "AgentInline", ordinal: 1, role: "worker", episode: 1, status: "running",
				executionPhase: "child-execution", route: { provider: "fixture", model: "offline", thinking: "off" },
				assistantTurns: 1, elapsedMs: 1_000, replayed: false, headline: "Agent inline detail",
				activeTools: [], calls: [], callsTruncated: false }],
			requestedTasks: 1, admittedTasks: 1, launchedChildren: 1, activeChildren: 1, settledTasks: 0,
			aggregateAssistantTurns: 1, elapsedMs: 1_000,
		};
		pi.events.emit(OBSERVER_EVENT, snapshot);
		if (pendingSessionRequest) replySession(pendingSessionRequest);
		pi.events.emit(SESSION_VIEW_CHANGED_EVENT, {});
	};
	pi.registerCommand("panels-update", { description: "Refresh offline panel facts", handler: async (_args, next) => {
		ctx = next; revision++; publish();
	} });
	pi.on("session_start", async (_event, next) => {
		ctx = next; publish();
		await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "observer-ready"), "ready");
	});
}
