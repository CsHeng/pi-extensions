import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Key, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import {
	OBSERVER_EVENT,
	parseObserverSnapshot,
	type ObserverSnapshot,
} from "../subagents/observer-events.ts";
import {
	SESSION_VIEW_CHANGED_EVENT,
	SESSION_VIEW_EVENT,
	SESSION_VIEW_REQUEST_EVENT,
	SESSION_VIEW_QUERY_EVENT,
	SESSION_VIEW_VERSION,
	parseSessionViewReply,
} from "../subagents/session-view.ts";
import { SubagentsOverlay, type OverlaySnapshot, type OverlayTheme, type SessionViewState } from "./component.ts";
import {
	OBSERVER_STALE_MS,
	OVERLAY_HORIZONTAL_MARGIN,
	SUBAGENTS_UI_COMMAND,
	SUBAGENTS_UI_PANEL_KEY,
	SUBAGENTS_UI_STATUS_KEY,
	formatPanel,
	formatStatus,
} from "./render.ts";

export {
	OBSERVER_STALE_MS,
	SUBAGENTS_UI_COMMAND,
	SUBAGENTS_UI_PANEL_KEY,
	SUBAGENTS_UI_STATUS_KEY,
};

export interface SubagentsUiOptions {
	enableWidget?: boolean;
	now?: () => number;
	setInterval?: (callback: () => void, intervalMs: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

interface CachedObservation {
	snapshot: ObserverSnapshot;
	receivedAt: number;
}

interface OwnerState {
	sessionId: string;
	leafId: string | null;
	branch: readonly string[];
}

const REPAINT_MS = 250;
const FALLBACK_TERMINAL_COLUMNS = 80;
/** Bounded wait for the core session-view reply before the panel says unavailable. */
export const CORE_VIEW_TIMEOUT_MS = 4_000;
const CORE_VIEW_WATCH_MS = 250;

interface PendingViewRequest {
	requestId: string;
	page: number;
	epoch: number;
	sentAt: number;
	sessionId: string;
	generation?: string;
	/** A bounded unavailable display still accepts this correlated late reply. */
	timedOut?: true;
}

function defaultSetInterval(callback: () => void, intervalMs: number): unknown {
	const handle = globalThis.setInterval(callback, intervalMs);
	handle.unref();
	return handle;
}

function defaultClearInterval(handle: unknown): void {
	globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
}

function readOwner(ctx: ExtensionContext | undefined): OwnerState | undefined {
	if (!ctx) return undefined;
	const manager = ctx.sessionManager as {
		getSessionId?: () => string;
		getLeafId?: () => string | null;
		getBranch?: () => Array<{ id?: string }>;
	};
	const sessionId = manager.getSessionId?.();
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	const leafRaw = manager.getLeafId?.();
	const leafId = typeof leafRaw === "string" ? leafRaw : null;
	const branch = (manager.getBranch?.() ?? [])
		.map((entry) => entry?.id)
		.filter((id): id is string => typeof id === "string");
	return { sessionId, leafId, branch };
}

function ownedBy(snapshot: ObserverSnapshot, owner: OwnerState): boolean {
	if (snapshot.parentSessionId !== owner.sessionId) return false;
	if (snapshot.anchor === null) return true;
	return owner.branch.includes(snapshot.anchor) || snapshot.anchor === owner.leafId;
}

function isSettled(snapshot: ObserverSnapshot): boolean {
	return snapshot.phase === "settled";
}

function isStaleCache(cache: CachedObservation, at: number): boolean {
	return !isSettled(cache.snapshot) && at - cache.receivedAt > OBSERVER_STALE_MS;
}

export function createSubagentsUiExtension(
	options: SubagentsUiOptions = {},
): (pi: ExtensionAPI) => void {
	const enableWidget = options.enableWidget === true;
	const now = options.now ?? (() => performance.now());
	const schedule = options.setInterval ?? defaultSetInterval;
	const cancelTimer = options.clearInterval ?? defaultClearInterval;

	return (pi: ExtensionAPI): void => {
		let ctx: ExtensionContext | undefined;
		let current: CachedObservation | undefined;
		let latestTerminal: CachedObservation | undefined;
		let sessionView: SessionViewState = { kind: "idle" };
		let pending: PendingViewRequest | undefined;
		const requestNamespace = randomUUID();
		let requestSeq = 0;
		let ownerEpoch = 0;
		let coreWatch: unknown;
		let requeryArmed = false;
		let viewObservedAt = 0;
		let overlay: SubagentsOverlay | undefined;
		let overlayOpen = false;
		let overlayLayout: OverlayOptions | undefined;
		let overlayTui: TUI | undefined;
		let intervalHandle: unknown;
		let dismissOverlay: (() => void) | undefined;
		let overlayVersion = 0;
		let retiredGeneration: string | undefined;

		const tui = () => ctx?.mode === "tui";

		const stopRepaint = (): void => {
			if (intervalHandle === undefined) return;
			cancelTimer(intervalHandle);
			intervalHandle = undefined;
		};

		const displayed = (): OverlaySnapshot => {
			if (ctx && !ctx.isProjectTrusted()) return { snapshot: undefined, receivedAt: 0, session: { kind: "unavailable", reason: "project_trust_required" } };
			let snapshot = current?.snapshot ?? latestTerminal?.snapshot;
			let receivedAt = current?.receivedAt ?? latestTerminal?.receivedAt ?? 0;
			const reply = sessionView.reply;
			if (reply && (!snapshot || viewObservedAt > receivedAt)) {
				const tasks = reply.live;
				snapshot = { version: 3, parentSessionId: reply.ownerSessionId, anchor: reply.anchor, generation: reply.generation,
					runId: reply.generation, revision: reply.revision, phase: tasks.length ? "running" : "settled", tasks,
					requestedTasks: tasks.length, admittedTasks: tasks.length, launchedChildren: tasks.filter(t => t.elapsedMs !== null).length,
					activeChildren: tasks.filter(t => t.status === "running").length, settledTasks: 0,
					aggregateAssistantTurns: tasks.reduce((sum, t) => sum + t.assistantTurns, 0), elapsedMs: null };
				receivedAt = viewObservedAt;
			}
			if (sessionView.reason === "project_trust_required") snapshot = undefined;
			return { snapshot, receivedAt, session: sessionView };
		};

		const clearWidget = (): void => {
			if (!enableWidget || !tui() || !ctx) return;
			ctx.ui.setStatus(SUBAGENTS_UI_STATUS_KEY, undefined);
			ctx.ui.setWidget(SUBAGENTS_UI_PANEL_KEY, undefined);
		};

		const renderWidget = (): void => {
			if (!enableWidget || !tui() || !ctx) return;
			const snapshot = current?.snapshot;
			if (!snapshot || isSettled(snapshot)) {
				clearWidget();
				return;
			}
			ctx.ui.setStatus(SUBAGENTS_UI_STATUS_KEY, formatStatus(snapshot));
			ctx.ui.setWidget(SUBAGENTS_UI_PANEL_KEY, formatPanel(snapshot), { placement: "belowEditor" });
		};

		const overlayNeedsClock = (): boolean => {
			const model = displayed();
			if (!model.snapshot || isSettled(model.snapshot)) return false;
			return now() - model.receivedAt <= OBSERVER_STALE_MS;
		};

		const startRepaint = (): void => {
			if (!tui() || !overlay || intervalHandle !== undefined || !overlayNeedsClock()) return;
			intervalHandle = schedule(() => {
				if (!overlay) {
					stopRepaint();
					return;
				}
				if (!overlayNeedsClock()) stopRepaint();
				overlay.update(displayed());
			}, REPAINT_MS);
		};

		const resetCache = (): void => {
			retiredGeneration = current?.snapshot.generation ?? retiredGeneration;
			current = undefined;
			latestTerminal = undefined;
		};

		const stopCoreWatch = (): void => {
			if (coreWatch === undefined) return;
			cancelTimer(coreWatch);
			coreWatch = undefined;
		};

		const forgetPendingView = (): void => {
			pending = undefined;
			requeryArmed = false;
			stopCoreWatch();
		};

		const scheduleCoreWatch = (): void => {
			if (coreWatch !== undefined) return;
			coreWatch = schedule(() => {
				const request = pending;
				if (!request) { stopCoreWatch(); return; }
				if (now() - request.sentAt < CORE_VIEW_TIMEOUT_MS) return;
				stopCoreWatch();
				// End visible waiting, not correlation: a valid late reply may still recover.
				request.timedOut = true;
				if (ctx?.sessionManager.getSessionId() === request.sessionId && ctx.isProjectTrusted()) {
					try { pi.appendEntry(SESSION_VIEW_QUERY_EVENT, { version: 1, source: "ui", requestId: request.requestId, durationMs: now() - request.sentAt, state: "timeout", cached: sessionView.reply?.history.state === "ready" }); }
					catch { /* Optional bounded audit never changes timeout/recovery behavior. */ }
				}
				sessionView = { kind: "unavailable", reason: "core_timeout", ...(sessionView.reply ? { reply: sessionView.reply } : {}) };
				publishOverlay();
			}, CORE_VIEW_WATCH_MS);
		}

		const requestSessionView = (page: number): void => {
			if (!tui() || !ctx || !overlay) return;
			if (!ctx.isProjectTrusted()) { forgetPendingView(); sessionView = { kind: "unavailable", reason: "project_trust_required" }; publishOverlay(); return; }
			const owner = readOwner(ctx);
			if (!owner) {
				sessionView = { kind: "unavailable", reason: "owner_unavailable" };
				publishOverlay();
				return;
			}
			const refreshing = sessionView.reply?.history.page === page;
			const requestId = `ui-${requestNamespace}-${++requestSeq}`;
			pending = { requestId, page, epoch: ownerEpoch, sentAt: now(), sessionId: owner.sessionId,
				...(current ? { generation: current.snapshot.generation } : {}) };
			sessionView = { kind: "loading", ...(refreshing ? { reply: sessionView.reply, refreshing: true } : {}) };
			publishOverlay();
			scheduleCoreWatch();
			pi.events.emit(SESSION_VIEW_REQUEST_EVENT, { version: SESSION_VIEW_VERSION, requestId, page });
		};

		const revalidate = (): void => {
			const owner = readOwner(ctx);
			if (!owner) {
				resetCache();
				return;
			}
			if (current && !ownedBy(current.snapshot, owner)) current = undefined;
			if (latestTerminal && !ownedBy(latestTerminal.snapshot, owner)) latestTerminal = undefined;
		};

		// The host resolves this object before every render, so growing content widens the panel
		// instead of wrapping, and short content keeps it near the previous default width.
		const syncOverlayWidth = (): void => {
			if (!overlay || !overlayLayout || !overlayTui) return;
			overlayLayout.width = overlay.desiredWidth(overlayTui.terminal?.columns ?? FALLBACK_TERMINAL_COLUMNS);
		};

		const publishOverlay = (): void => {
			if (!overlay) return;
			overlay.update(displayed());
			syncOverlayWidth();
			startRepaint();
		};

		const accept = (incoming: ObserverSnapshot, receivedAt: number): void => {
			const owner = readOwner(ctx);
			if (!owner || !ownedBy(incoming, owner) || incoming.generation === retiredGeneration) return;
			if (current) {
				if (incoming.generation === current.snapshot.generation) {
					if (incoming.revision <= current.snapshot.revision) return;
				} else if (!isSettled(current.snapshot) && !isStaleCache(current, receivedAt)) {
					return;
				} else if (isSettled(current.snapshot)) {
					latestTerminal = current;
				}
			}
			if (current && current.snapshot.generation !== incoming.generation) retiredGeneration = current.snapshot.generation;
			current = { snapshot: incoming, receivedAt };
			if (isSettled(incoming)) latestTerminal = current;
		};

		const openOverlay = async (): Promise<void> => {
			if (!tui() || !ctx || overlay) return;
			revalidate();
			const version = ++overlayVersion;
			const model = displayed();
			const layout: OverlayOptions = {
				anchor: "center",
				width: FALLBACK_TERMINAL_COLUMNS,
				margin: { left: OVERLAY_HORIZONTAL_MARGIN, right: OVERLAY_HORIZONTAL_MARGIN },
			};
			await Promise.resolve(ctx.ui.custom<null>(
				(tuiInstance, theme, _kb, done) => {
					dismissOverlay = () => done(null);
					overlayOpen = true;
					overlay = new SubagentsOverlay(model, tuiInstance, dismissOverlay, { now, theme, onPage: requestSessionView });
					overlayTui = tuiInstance;
					overlayLayout = layout;
					syncOverlayWidth();
					startRepaint();
					// Opening (or reopening) the overlay queries retained history again.
					requestSessionView(0);
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: layout,
					onHandle: (handle) => { handle.focus(); },
				},
			)).finally(() => {
				if (version !== overlayVersion) return;
				overlay = undefined;
				overlayOpen = false;
				overlayLayout = undefined;
				overlayTui = undefined;
				dismissOverlay = undefined;
				stopRepaint();
				forgetPendingView();
			});
		};

		pi.events.on(OBSERVER_EVENT, (data) => {
			try {
				if (!tui()) return;
				const parsed = parseObserverSnapshot(data);
				if (!parsed.ok) return;
				revalidate();
				const liveKey = () => current?.snapshot.tasks.filter(t => t.status === "running" || t.status === "pending")
					.map(t => `${t.id}:${t.episode}:${t.status}`).sort().join("|") ?? "";
				const before = liveKey();
				const previousGeneration = current?.snapshot.generation ?? sessionView.reply?.generation;
				accept(parsed.value, now());
				const generationChanged = previousGeneration !== undefined && current !== undefined && current.snapshot.generation !== previousGeneration;
				if (generationChanged) { forgetPendingView(); sessionView = { kind: "idle" }; }
				renderWidget();
				publishOverlay();
				if (overlayOpen && (before !== liveKey() || generationChanged)) {
					if (pending && !pending.timedOut) requeryArmed = true;
					else requestSessionView(sessionView.reply?.history.page ?? 0);
				}
			} catch {
				/* Display-only observer. */
			}
		});

		pi.events.on(SESSION_VIEW_EVENT, (data) => {
			try {
				if (!tui() || !overlayOpen) return;
				const parsed = parseSessionViewReply(data);
				if (!parsed.ok) return;
				const reply = parsed.value;
				const request = pending;
				// Only the newest correlated request can be answered, including its valid late reply.
				if (!request || reply.requestId !== request.requestId) return;
				if (request.epoch !== ownerEpoch) {
					pending = undefined; stopCoreWatch();
					sessionView = { kind: "unavailable", reason: "owner_changed" };
					publishOverlay();
					return;
				}
				if (!ctx?.isProjectTrusted()) { forgetPendingView(); sessionView = { kind: "unavailable", reason: "project_trust_required" }; publishOverlay(); return; }
				const owner = readOwner(ctx);
				if (!owner || reply.ownerSessionId !== owner.sessionId || reply.ownerSessionId !== request.sessionId
					|| (reply.anchor !== null && reply.anchor !== owner.leafId && !owner.branch.includes(reply.anchor))
					|| (request.generation !== undefined && reply.generation !== request.generation)
					|| (current !== undefined && reply.generation !== current.snapshot.generation)) {
					pending = undefined; stopCoreWatch();
					sessionView = { kind: "unavailable", reason: "owner_changed" };
					publishOverlay();
					return;
				}
				pending = undefined;
				stopCoreWatch();
				const cached = sessionView.reply;
				const transient = ["history_query_failed", "core_query_failed", "core_reply_invalid"].includes(reply.history.reason ?? "");
				const preserve = transient && cached?.history.state === "ready" && ctx?.isProjectTrusted() === true;
				if (!preserve) viewObservedAt = request.sentAt;
				sessionView = { kind: reply.history.state === "ready" ? "ready" : "unavailable", reply: preserve ? cached : reply,
					...(reply.history.reason === undefined ? {} : { reason: reply.history.reason }) };
				publishOverlay();
				if (requeryArmed) {
					requeryArmed = false;
					requestSessionView(sessionView.reply?.history.page ?? 0);
				}
			} catch {
				/* Display-only consumer. */
			}
		});

		pi.events.on(SESSION_VIEW_CHANGED_EVENT, () => {
			try {
				if (!tui() || !overlayOpen) return;
				// Coalesce lifecycle invalidations into one requery of the current scope.
				if (pending && !pending.timedOut) requeryArmed = true;
				else requestSessionView(sessionView.reply?.history.page ?? 0);
			} catch {
				/* Display-only consumer. */
			}
		});

		pi.registerCommand(SUBAGENTS_UI_COMMAND, {
			description: "Inspect observed subagent work",
			handler: async (_args, commandCtx) => {
				ctx = commandCtx;
				await openOverlay();
			},
		});

		pi.registerShortcut(Key.ctrlAlt("f"), {
			description: "Inspect observed subagent work",
			handler: async (shortcutCtx) => {
				ctx = shortcutCtx;
				await openOverlay();
			},
		});

		const closeOverlay = () => {
			++overlayVersion;
			const dismiss = dismissOverlay;
			dismissOverlay = undefined; overlay = undefined; overlayOpen = false;
			forgetPendingView();
			stopRepaint(); dismiss?.();
		};

		pi.on("session_start", (_event, sessionCtx) => {
			ctx = sessionCtx;
			ownerEpoch++;
			forgetPendingView();
			sessionView = { kind: "idle" };
			resetCache();
			closeOverlay();
			clearWidget();
		});

		pi.on("session_tree", (_event, sessionCtx) => {
			ctx = sessionCtx;
			ownerEpoch++;
			forgetPendingView();
			sessionView = { kind: "idle" };
			resetCache();
			closeOverlay();
			clearWidget();
		});

		pi.on("session_shutdown", () => {
			ownerEpoch++;
			forgetPendingView();
			sessionView = { kind: "idle" };
			closeOverlay();
			resetCache();
			clearWidget();
			ctx = undefined;
		});
	};
}

export default createSubagentsUiExtension();
