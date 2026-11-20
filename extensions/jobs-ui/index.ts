/** TUI-only read-only Jobs view. It does not start, cancel, renew, or wake. */
import { randomUUID } from "node:crypto";
import { openJobsInspection, type JobsInspectionHandle } from "./inspection.ts";
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
} from "../async-bash/jobs-view.ts";
import { jobFrame, jobItems, jobRows, jobsRenderBudget, type JobsUiTheme, type JobsUiView } from "./render.ts";

export const JOBS_UI_COMMAND = "jobs-ui";
export { JOBS_LIST_PAGE_SIZE } from "./inspection.ts";
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
	| { kind: "ready"; anchor: string | null; records: JobsViewRecord[] };

interface PendingQuery { detailExecutionId?: string; requestId: string; sessionId: string; anchor: string | null }

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
		let ownerSession: string | undefined;
		let display: Display = { kind: "idle" };
		let pending: PendingQuery | undefined;
		let timer: unknown;
		let tick: unknown;
		let detailDirty = false;
		let stops: Array<() => void> = [];
		const inspections = new Set<JobsInspectionHandle>();
		const closeInspections = () => { for (const inspection of inspections) inspection.close(); inspections.clear(); };
		const inspect = (context: ExtensionContext, initial?: string): Promise<void> => {
			let mounted: JobsInspectionHandle | undefined;
			return openJobsInspection(context, inspectionItems(), initial, handle => {
				if (mounted) inspections.delete(mounted);
				mounted = handle;
				if (handle) inspections.add(handle);
				armTick();
			}, query);
		};
		const tui = () => ctx?.mode === "tui" && ctx.hasUI === true;
		const clearTimer = () => { if (timer !== undefined) { cancelTimer(timer); timer = undefined; } };
		const clearTick = () => { if (tick !== undefined) { cancelTimer(tick); tick = undefined; } };
		// New messages advance the leaf within a branch. A validated ancestor snapshot still belongs to it.
		const currentScope = () => {
			if (!ctx?.isProjectTrusted() || ctx.sessionManager.getSessionId() !== ownerSession) return false;
			const anchor = display.kind === "ready" ? display.anchor : null;
			return anchor === null || anchor === leafId(ctx) || ctx.sessionManager.getBranch().some(entry => entry.id === anchor);
		};
		const currentView = (): JobsUiView => {
			if (!currentScope()) return { unavailable: "stale" };
			if (display.kind === "ready") return { records: display.records };
			if (display.kind === "unavailable" || display.kind === "waiting") return { unavailable: display.kind === "waiting" ? "unreachable" : display.reason };
			return {};
		};
		const needsTick = () => (visible || inspections.size > 0) && tui() && display.kind === "ready" && display.records.some((record) => record.status === "running");
		const armTick = () => {
			if (!needsTick() && !detailDirty) { clearTick(); return; }
			if (tick !== undefined) return;
			tick = schedule(() => { tick = undefined; if (detailDirty) query(); else publish(); }, TICK_MS);
		};
		const publish = () => {
			if (!currentScope()) closeInspections();
			for (const inspection of inspections) inspection.refresh();
			if (!tui() || !ctx || failed) { clearTick(); composer.set("jobs", undefined); return; }
			composer.attach(ctx);
			const view = currentView();
			if (!visible || !view.records?.length) { composer.set("jobs", undefined); armTick(); return; }
			const ok = composer.set("jobs", {
				render(width, terminalRows, theme, selected) {
					try {
						const view = currentView();
						return folded ? jobRows(view, width, 1, now(), themeOf(theme), { folded }) : jobFrame(view, width, jobsRenderBudget(terminalRows), now(), themeOf(theme), selected);
					} catch { failed = true; return []; }
				},
				openItem(key) { if (ctx && jobItems(currentView(), now()).some(item => item.key === key)) return inspect(ctx, key); },
				activate() { folded = !folded; publish(); },
			});
			if (!ok) { failed = true; clearTick(); composer.set("jobs", undefined); return; }
			armTick();
		};
		const query = () => {
			detailDirty = false;
			if (!tui() || !ctx) return;
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) { display = { kind: "unavailable", reason: "unreachable" }; publish(); return; }
			if (!ctx.isProjectTrusted()) { closeInspections(); display = { kind: "unavailable", reason: "untrusted" }; pending = undefined; clearTimer(); publish(); return; }
			const requestId = randomUUID();
			const detailExecutionId = [...inspections].at(-1)?.detailKey();
			const detail = detailExecutionId === undefined ? {} : { detailExecutionId };
			pending = { requestId, sessionId, anchor: leafId(ctx), ...detail };
			if (display.kind !== "ready") display = { kind: "waiting" };
			pi.events.emit(JOBS_VIEW_REQUEST_EVENT, { version: JOBS_VIEW_VERSION, requestId, ...detail });
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
			closeInspections();
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
				const { detailExecutionId } = pending;
				if (reply.records?.some(record => record.output && record.executionId !== detailExecutionId)) { rejectPending("stale"); return; }
				pending = undefined;
				clearTimer();
				pinned = reply.generation;
				display = reply.availability === "ready"
					? { kind: "ready", anchor: reply.anchor, records: reply.records ?? [] }
					: { kind: "unavailable", reason: reply.reason ?? "unavailable" };
				publish();
			} catch { /* Display-only consumer. */ }
		};
		const onChanged = (data: unknown) => {
			try {
				if (!tui()) return;
				const changed = parseJobsViewChanged(data);
				if (!changed || (pinned !== undefined && changed.generation !== pinned)) return;
				// A noisy job may emit many chunks per frame. Read its full tail at most once per live tick.
				if (tick !== undefined && currentScope() && [...inspections].at(-1)?.detailKey()) detailDirty = true;
				else query();
			} catch { /* Display-only consumer. */ }
		};
		const onReset = (data: unknown) => {
			try {
				if (!tui() || !ctx) return;
				const reset = parseJobsViewReset(data);
				if (!reset) return;
				const sessionId = ctx.sessionManager.getSessionId();
				if (reset.ownerSessionId && reset.ownerSessionId !== sessionId) return;
				closeInspections();
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
			detailDirty = false;
			closeInspections();
			ctx = next;
			failed = false;
			listen();
			if (!tui()) { clearTick(); composer.set("jobs", undefined); return; }
			pinned = undefined;
			ownerSession = next.sessionManager.getSessionId();
			pending = undefined;
			clearTimer();
			display = { kind: "idle" };
			composer.attach(next);
			query();
		};
		const shutdown = () => {
			detailDirty = false;
			closeInspections();
			clearTimer();
			clearTick();
			pending = undefined;
			display = { kind: "idle" };
			ctx = undefined;
			for (const stop of stops) stop();
			stops = [];
			composer.set("jobs", undefined);
		};
		const inspectionItems = () => {
			const session = ownerSession, generation = pinned;
			return () => {
				const view = session === ownerSession && (generation === undefined || generation === pinned) ? currentView() : { unavailable: "stale" };
				return { items: jobItems(view, now()), ...(view.unavailable !== undefined ? { unavailable: view.unavailable } : !view.records ? { unavailable: "unreachable" } : {}) };
			};
		};
		const openList = async () => {
			if (!tui() || !ctx) return;
			await inspect(ctx);
		};
		const handle = async (args: string, commandCtx: ExtensionContext) => {
			ctx = commandCtx;
			if (!tui()) return;
			const arg = args.trim();
			if (arg === "list") { await openList(); return; }
			if (arg === "focus") { visible = true; folded = false; failed = false; publish(); composer.focus("jobs"); return; }
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
		pi.registerCommand(JOBS_UI_COMMAND, { description: "Show, hide, fold, or list background Bash jobs", handler: handle });
		pi.on("session_start", (_event, sessionCtx) => bind(sessionCtx));
		pi.on("session_tree", (_event, sessionCtx) => bind(sessionCtx));
		pi.on("session_shutdown", shutdown);
	};
}

export default function jobsUi(pi: ExtensionAPI): void {
	createJobsUi()(pi);
}
