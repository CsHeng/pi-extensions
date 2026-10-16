/** TUI-only read-only Jobs view. It does not start, cancel, renew, or wake. */
import { randomUUID } from "node:crypto";
import { openListOverlay } from "../shared/list-overlay.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedAboveEditor, type AboveEditorComposer } from "../shared/above-editor.ts";
import {
	parseJobsViewChanged,
	parseJobsViewReply,
	parseJobsViewReset,
	JOBS_VIEW_CHANGED_EVENT,
	JOBS_VIEW_EVENT,
	JOBS_VIEW_REQUEST_EVENT,
	JOBS_VIEW_RESET_EVENT,
	JOBS_VIEW_VERSION,
	type JobsViewRecord,
	type JobsViewReply,
} from "../retained-shell/jobs-view.ts";
import { jobRows, jobsRenderBudget, type JobsUiTheme, type JobsUiView } from "./render.ts";

export const JOBS_UI_COMMAND = "jobs-ui";
export const JOBS_VIEW_TIMEOUT_MS = 4_000;
const TICK_MS = 1_000;

export interface JobsUiOptions {
	composer?: AboveEditorComposer;
	timeoutMs?: number;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

type Display =
	| { kind: "idle" }
	| { kind: "waiting" }
	| { kind: "unavailable"; reason: string }
	| { kind: "ready"; records: JobsViewRecord[]; retained?: JobsViewRecord[] };

interface PendingQuery { requestId: string; sessionId: string; anchor: string | null }

function defaultSetTimer(callback: () => void, ms: number): unknown {
	const handle = setTimeout(callback, ms);
	handle.unref?.();
	return handle;
}
function defaultClearTimer(handle: unknown): void {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
}
function themeOf(value: unknown): JobsUiTheme | undefined {
	if (!value || typeof value !== "object") return undefined;
	const theme = value as JobsUiTheme;
	return typeof theme.fg === "function" ? theme : undefined;
}
function leafId(ctx: ExtensionContext | undefined): string | null {
	const leaf = ctx?.sessionManager.getLeafId();
	return typeof leaf === "string" && leaf.length > 0 ? leaf : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createJobsUi(options: JobsUiOptions = {}): (pi: ExtensionAPI) => void {
	const timeoutMs = options.timeoutMs ?? JOBS_VIEW_TIMEOUT_MS;
	const now = options.now ?? Date.now;
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
		let tick: unknown;
		let stops: Array<() => void> = [];
		const tui = () => ctx?.mode === "tui" && ctx.hasUI === true;
		const clearTimer = () => { if (timer !== undefined) { cancelTimer(timer); timer = undefined; } };
		const clearTick = () => { if (tick !== undefined) { cancelTimer(tick); tick = undefined; } };
		const currentView = (): JobsUiView => {
			if (display.kind === "ready") return { records: display.records };
			if (display.kind === "unavailable" || display.kind === "waiting") return { unavailable: display.kind === "waiting" ? "unreachable" : display.reason };
			return {};
		};
		const listView = (): JobsUiView => {
			if (display.kind === "ready") return { records: display.retained ?? display.records };
			return currentView();
		};
		const needsTick = () => visible && tui() && display.kind === "ready" && display.records.some((record) => record.status === "running");
		const armTick = () => {
			if (!needsTick()) { clearTick(); return; }
			if (tick !== undefined) return;
			tick = schedule(() => { tick = undefined; publish(); }, TICK_MS);
		};
		const publish = () => {
			if (!tui() || !ctx || failed) { clearTick(); composer.set("jobs", undefined); return; }
			composer.attach(ctx);
			const view = currentView();
			if (!visible || !view.records?.length) { clearTick(); composer.set("jobs", undefined); return; }
			const ok = composer.set("jobs", {
				render(width, terminalRows, theme) {
					try { return jobRows(currentView(), Math.min(width, 120), folded ? 1 : jobsRenderBudget(terminalRows), now(), themeOf(theme), { folded }); }
					catch { failed = true; return []; }
				},
				activate() { folded = !folded; publish(); },
			});
			if (!ok) { failed = true; clearTick(); composer.set("jobs", undefined); return; }
			armTick();
		};
		const query = () => {
			if (!tui() || !ctx) return;
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) { display = { kind: "unavailable", reason: "unreachable" }; publish(); return; }
			if (!ctx.isProjectTrusted()) { display = { kind: "unavailable", reason: "untrusted" }; pending = undefined; clearTimer(); publish(); return; }
			const requestId = randomUUID();
			pending = { requestId, sessionId, anchor: leafId(ctx) };
			if (display.kind !== "ready") display = { kind: "waiting" };
			pi.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId });
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
		const rejectPending = (reason: string) => {
			pending = undefined;
			clearTimer();
			display = { kind: "unavailable", reason };
			publish();
		};
		const onReply = (data: unknown) => {
			try {
				if (!tui()) return;
				const parsed = parseJobsViewReply(data);
				if (!parsed.ok) {
					if (pending && isRecord(data) && data.requestId === pending.requestId) rejectPending("stale");
					return;
				}
				const reply: JobsViewReply = parsed.value;
				if (!pending || reply.requestId !== pending.requestId) return;
				const sessionId = ctx?.sessionManager.getSessionId();
				if (!ctx?.isProjectTrusted() || !sessionId || reply.ownerSessionId !== sessionId || reply.ownerSessionId !== pending.sessionId || reply.anchor !== leafId(ctx) || (pinned !== undefined && reply.generation !== pinned)) {
					rejectPending(reply.ownerSessionId !== sessionId ? "foreign" : "stale");
					return;
				}
				pending = undefined;
				clearTimer();
				pinned = reply.generation;
				display = reply.availability === "ready"
					? { kind: "ready", records: reply.records ?? [], ...(reply.retained !== undefined ? { retained: reply.retained } : {}) }
					: { kind: "unavailable", reason: reply.reason ?? "unavailable" };
				publish();
			} catch { /* Display-only consumer. */ }
		};
		const onChanged = (data: unknown) => {
			try {
				if (!tui()) return;
				const changed = parseJobsViewChanged(data);
				if (!changed || (pinned !== undefined && changed.generation !== pinned)) return;
				query();
			} catch { /* Display-only consumer. */ }
		};
		const onReset = (data: unknown) => {
			try {
				if (!tui() || !ctx) return;
				const reset = parseJobsViewReset(data);
				if (!reset) return;
				const sessionId = ctx.sessionManager.getSessionId();
				if (reset.ownerSessionId && reset.ownerSessionId !== sessionId) return;
				pinned = reset.generation;
				pending = undefined;
				clearTimer();
				display = { kind: "waiting" };
				if (!reset.ownerSessionId) { display = { kind: "unavailable", reason: "unreachable" }; publish(); return; }
				query();
			} catch { /* Display-only consumer. */ }
		};
		const listen = () => {
			for (const stop of stops) stop();
			stops = [
				pi.events.on(JOBS_VIEW_EVENT, onReply),
				pi.events.on(JOBS_VIEW_CHANGED_EVENT, onChanged),
				pi.events.on(JOBS_VIEW_RESET_EVENT, onReset),
			];
		};
		const bind = (next: ExtensionContext) => {
			ctx = next;
			failed = false;
			listen();
			if (!tui()) { clearTick(); composer.set("jobs", undefined); return; }
			pinned = undefined;
			pending = undefined;
			clearTimer();
			display = { kind: "idle" };
			composer.attach(next);
			query();
		};
		const shutdown = () => {
			clearTimer();
			clearTick();
			pending = undefined;
			display = { kind: "idle" };
			ctx = undefined;
			for (const stop of stops) stop();
			stops = [];
			composer.set("jobs", undefined);
		};
		const openList = async () => {
			if (!tui() || !ctx) return;
			await openListOverlay(ctx, "Jobs · retained shell", (width, theme) => {
				const view = listView();
				return jobRows(view, width, (view.records?.length ?? 0) + 1, now(), themeOf(theme));
			});
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
			if (arg === "" || arg === "show" || arg === "hide") ctx.ui.notify("Jobs UI " + (visible ? "on." : "off."), "info");
			failed = false;
			publish();
		};
		listen();
		pi.registerCommand(JOBS_UI_COMMAND, { description: "Show, hide, fold, or list retained shell jobs", handler: handle });
		pi.on("session_start", (_event, sessionCtx) => bind(sessionCtx));
		pi.on("session_tree", (_event, sessionCtx) => bind(sessionCtx));
		pi.on("session_shutdown", shutdown);
	};
}

export default function jobsUi(pi: ExtensionAPI): void {
	createJobsUi()(pi);
}
