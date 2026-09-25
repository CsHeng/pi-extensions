import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import {
	OBSERVER_EVENT,
	parseObserverSnapshot,
	type ObserverSnapshot,
} from "../subagents/observer-events.ts";
import { SubagentsOverlay, type OverlaySnapshot, type OverlayTheme } from "./component.ts";
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
	const now = options.now ?? (() => Date.now());
	const schedule = options.setInterval ?? defaultSetInterval;
	const cancelTimer = options.clearInterval ?? defaultClearInterval;

	return (pi: ExtensionAPI): void => {
		let ctx: ExtensionContext | undefined;
		let current: CachedObservation | undefined;
		let latestTerminal: CachedObservation | undefined;
		// Display-only observation order: the observer is per-run, so the panel labels which run it shows.
		let runOrder: string[] = [];
		let overlay: SubagentsOverlay | undefined;
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

		const batchOf = (snapshot: ObserverSnapshot | undefined): number | undefined => {
			if (!snapshot) return undefined;
			const index = runOrder.indexOf(snapshot.runId);
			return index < 0 ? undefined : index + 1;
		};

		const displayed = (): OverlaySnapshot => {
			const snapshot = current?.snapshot ?? latestTerminal?.snapshot;
			const receivedAt = current?.receivedAt ?? latestTerminal?.receivedAt ?? 0;
			const batch = batchOf(snapshot);
			return batch === undefined ? { snapshot, receivedAt } : { snapshot, receivedAt, batch };
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
			const cache = current ?? latestTerminal;
			if (!cache || isSettled(cache.snapshot)) return false;
			return !isStaleCache(cache, now());
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
			runOrder = [];
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
			current = { snapshot: incoming, receivedAt };
			if (!runOrder.includes(incoming.runId)) runOrder.push(incoming.runId);
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
					overlay = new SubagentsOverlay(model, tuiInstance, dismissOverlay, { now, theme });
					overlayTui = tuiInstance;
					overlayLayout = layout;
					syncOverlayWidth();
					startRepaint();
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
				overlayLayout = undefined;
				overlayTui = undefined;
				dismissOverlay = undefined;
				stopRepaint();
			});
		};

		pi.events.on(OBSERVER_EVENT, (data) => {
			try {
				if (!tui()) return;
				const parsed = parseObserverSnapshot(data);
				if (!parsed.ok) return;
				revalidate();
				accept(parsed.value, now());
				renderWidget();
				publishOverlay();
			} catch {
				/* Display-only observer. */
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
			dismissOverlay = undefined; overlay = undefined;
			stopRepaint(); dismiss?.();
		};

		pi.on("session_start", (_event, sessionCtx) => {
			ctx = sessionCtx;
			resetCache();
			closeOverlay();
			clearWidget();
		});

		pi.on("session_tree", (_event, sessionCtx) => {
			ctx = sessionCtx;
			resetCache();
			closeOverlay();
			clearWidget();
		});

		pi.on("session_shutdown", () => {
			closeOverlay();
			resetCache();
			clearWidget();
			ctx = undefined;
		});
	};
}

export default createSubagentsUiExtension();
