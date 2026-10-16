/** TUI-only read-only Tasks view. It does not validate, mutate, or remind. */
import { randomUUID } from "node:crypto";
import { openListOverlay } from "../shared/list-overlay.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedAboveEditor, type AboveEditorComposer } from "../shared/above-editor.ts";
import type { GoalState, GoalView } from "../workflow/goal-contracts.ts";
import {
	parseTasksViewChanged,
	parseTasksViewReply,
	parseTasksViewReset,
	TASKS_VIEW_CHANGED_EVENT,
	TASKS_VIEW_EVENT,
	TASKS_VIEW_REQUEST_EVENT,
	TASKS_VIEW_RESET_EVENT,
	TASKS_VIEW_VERSION,
	type TasksViewReply,
} from "../workflow/tasks-view.ts";
import { goalRows, tasksRenderBudget, type GoalUiTheme } from "./render.ts";

export const TASKS_UI_COMMAND = "tasks-ui";
export const TASKS_UI_ALIAS = "workflow-ui";
export const TASKS_VIEW_TIMEOUT_MS = 4_000;

export interface TasksUiOptions {
	composer?: AboveEditorComposer;
	timeoutMs?: number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

type Display =
	| { kind: "idle" }
	| { kind: "waiting" }
	| { kind: "unavailable"; reason: string }
	| { kind: "ready"; reply: TasksViewReply };

interface PendingQuery { requestId: string; sessionId: string; anchor: string | null }

function defaultSetTimer(callback: () => void, ms: number): unknown {
	const handle = setTimeout(callback, ms);
	handle.unref?.();
	return handle;
}
function defaultClearTimer(handle: unknown): void {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
}
function themeOf(value: unknown): GoalUiTheme | undefined {
	if (!value || typeof value !== "object") return undefined;
	const theme = value as GoalUiTheme;
	return typeof theme.fg === "function" && typeof theme.strikethrough === "function" ? theme : undefined;
}
function leafId(ctx: ExtensionContext | undefined): string | null {
	const leaf = ctx?.sessionManager.getLeafId();
	return typeof leaf === "string" && leaf.length > 0 ? leaf : null;
}
function toView(reply: TasksViewReply): GoalView {
	if (reply.availability === "unavailable") return { unavailable: reply.reason ?? "unavailable" };
	if (!reply.state) return {};
	const state: GoalState = {
		version: 5, revision: reply.state.revision, goal: reply.state.goal, paused: reply.state.paused, cancelled: reply.state.cancelled,
		tasks: reply.state.tasks.map(task => ({ id: task.id, title: task.title, status: task.status, ...(task.note ? { note: task.note } : {}) })),
		...(reply.state.reason ? { reason: reply.state.reason } : {}),
	};
	return { state };
}

export function createTasksUi(options: TasksUiOptions = {}): (pi: ExtensionAPI) => void {
	const timeoutMs = options.timeoutMs ?? TASKS_VIEW_TIMEOUT_MS;
	const schedule = options.setTimer ?? defaultSetTimer;
	const cancelTimer = options.clearTimer ?? defaultClearTimer;
	return (pi: ExtensionAPI): void => {
		const composer = options.composer ?? sharedAboveEditor(pi);
		let ctx: ExtensionContext | undefined;
		let visible = true;
		let folded = true;
		let failed = false;
		let pinned: string | undefined;
		let display: Display = { kind: "idle" };
		let pending: PendingQuery | undefined;
		let timer: unknown;
		let stops: Array<() => void> = [];
		const tui = () => ctx?.mode === "tui" && ctx.hasUI === true;
		const clearTimer = () => { if (timer !== undefined) { cancelTimer(timer); timer = undefined; } };
		const currentView = (): GoalView => {
			if (display.kind === "ready") return toView(display.reply);
			if (display.kind === "unavailable" || display.kind === "waiting") return { unavailable: display.kind === "waiting" ? "unreachable" : display.reason };
			return {};
		};
		const publish = () => {
			if (!tui() || !ctx || failed) { composer.set("tasks", undefined); return; }
			composer.attach(ctx);
			const view = currentView();
			if (!visible || view.state === undefined) { composer.set("tasks", undefined); return; }
			const ok = composer.set("tasks", {
				render(width, terminalRows, theme) {
					try { return goalRows(currentView(), Math.min(width, 120), folded ? 1 : tasksRenderBudget(terminalRows), themeOf(theme), { folded }); }
					catch { failed = true; return []; }
				},
				activate() { folded = !folded; publish(); },
			});
			if (!ok) { failed = true; composer.set("tasks", undefined); }
		};
		const query = () => {
			if (!tui() || !ctx) return;
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) { display = { kind: "unavailable", reason: "unreachable" }; publish(); return; }
			if (!ctx.isProjectTrusted()) { display = { kind: "unavailable", reason: "untrusted" }; pending = undefined; clearTimer(); publish(); return; }
			const requestId = randomUUID();
			pending = { requestId, sessionId, anchor: leafId(ctx) };
			if (display.kind !== "ready") display = { kind: "waiting" };
			pi.events.emit(TASKS_VIEW_REQUEST_EVENT, { version: TASKS_VIEW_VERSION, requestId });
			if (pending?.requestId === requestId) {
				clearTimer();
				timer = schedule(() => {
					if (pending?.requestId !== requestId) return;
					pending = undefined;
					display = { kind: "unavailable", reason: "unreachable" };
					publish();
				}, timeoutMs);
			}
			publish();
		};
		const onReply = (data: unknown) => {
			try {
				if (!tui()) return;
				const parsed = parseTasksViewReply(data);
				if (!parsed.ok) return;
				const reply = parsed.value;
				if (!pending || reply.requestId !== pending.requestId) return;
				const sessionId = ctx?.sessionManager.getSessionId();
				if (!ctx?.isProjectTrusted() || !sessionId || reply.ownerSessionId !== sessionId || reply.ownerSessionId !== pending.sessionId || reply.anchor !== leafId(ctx) || (pinned !== undefined && reply.generation !== pinned)) {
					pending = undefined; clearTimer();
					display = { kind: "unavailable", reason: reply.ownerSessionId !== sessionId ? "foreign" : "stale" };
					publish();
					return;
				}
				pending = undefined; clearTimer();
				pinned = reply.generation;
				display = reply.availability === "ready" ? { kind: "ready", reply } : { kind: "unavailable", reason: reply.reason ?? "unavailable" };
				publish();
			} catch { /* Display-only consumer. */ }
		};
		const onChanged = (data: unknown) => {
			try {
				if (!tui()) return;
				const changed = parseTasksViewChanged(data);
				if (!changed || (pinned !== undefined && changed.generation !== pinned)) return;
				query();
			} catch { /* Display-only consumer. */ }
		};
		const onReset = (data: unknown) => {
			try {
				if (!tui() || !ctx) return;
				const reset = parseTasksViewReset(data);
				if (!reset) return;
				const sessionId = ctx.sessionManager.getSessionId();
				if (reset.ownerSessionId && reset.ownerSessionId !== sessionId) return;
				pinned = reset.generation;
				pending = undefined; clearTimer();
				display = { kind: "waiting" };
				if (!reset.ownerSessionId) { display = { kind: "unavailable", reason: "unreachable" }; publish(); return; }
				query();
			} catch { /* Display-only consumer. */ }
		};
		const listen = () => {
			for (const stop of stops) stop();
			stops = [
				pi.events.on(TASKS_VIEW_EVENT, onReply),
				pi.events.on(TASKS_VIEW_CHANGED_EVENT, onChanged),
				pi.events.on(TASKS_VIEW_RESET_EVENT, onReset),
			];
		};
		const bind = (next: ExtensionContext) => {
			ctx = next; failed = false; listen();
			if (!tui()) { composer.set("tasks", undefined); return; }
			pinned = undefined; pending = undefined; clearTimer(); display = { kind: "idle" };
			composer.attach(next);
			query();
		};
		const shutdown = () => {
			clearTimer(); pending = undefined; display = { kind: "idle" }; ctx = undefined;
			for (const stop of stops) stop();
			stops = [];
			composer.set("tasks", undefined);
		};
		const openList = async () => {
			if (!tui() || !ctx) return;
			await openListOverlay(ctx, "Tasks · workflow", (width, theme) => goalRows(currentView(), width, 1000, themeOf(theme)));
		};
		const handle = async (args: string, commandCtx: ExtensionContext) => {
			ctx = commandCtx;
			if (!tui()) return;
			const arg = args.trim();
			if (arg === "list") { await openList(); return; }
			if (arg === "show") visible = true;
			else if (arg === "hide") visible = false;
			else if (arg === "expand") { visible = true; folded = false; }
			else if (arg === "collapse") { visible = true; folded = true; }
			else if (arg === "") visible = !visible;
			else return;
			if (arg === "" || arg === "show" || arg === "hide") ctx.ui.notify("Tasks UI " + (visible ? "on." : "off."), "info");
			failed = false; publish();
		};
		listen();
		pi.registerCommand(TASKS_UI_COMMAND, { description: "Show, hide, fold, or list the read-only task view", handler: handle });
		pi.registerCommand(TASKS_UI_ALIAS, {
			description: "Toggle the read-only task list view (show/hide/list)",
			handler: async (args, commandCtx) => {
				const arg = args.trim();
				await handle(arg === "show" || arg === "hide" || arg === "list" ? arg : "", commandCtx);
			},
		});
		pi.on("session_start", (_event, sessionCtx) => bind(sessionCtx));
		pi.on("session_tree", (_event, sessionCtx) => bind(sessionCtx));
		pi.on("session_shutdown", shutdown);
	};
}

export default function tasksUi(pi: ExtensionAPI): void {
	createTasksUi()(pi);
}
