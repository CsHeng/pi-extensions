import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	OBSERVER_EVENT,
	parseObserverSnapshot,
	type ObserverSnapshot,
} from "../subagents/observer-events.ts";
import { SubagentsOverlay, type OverlaySnapshot } from "./component.ts";
import {
	OBSERVER_STALE_MS,
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
		let overlay: SubagentsOverlay | undefined;
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

		const displayed = (): OverlaySnapshot => ({
			snapshot: current?.snapshot ?? latestTerminal?.snapshot,
			receivedAt: current?.receivedAt ?? latestTerminal?.receivedAt ?? 0,
		});

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

		const publishOverlay = (): void => {
			if (!overlay) return;
			overlay.update(displayed());
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
			if (isSettled(incoming)) latestTerminal = current;
		};

		const openOverlay = async (): Promise<void> => {
			if (!tui() || !ctx || overlay) return;
			revalidate();
			const version = ++overlayVersion;
			const model = displayed();
			await Promise.resolve(ctx.ui.custom<null>(
				(tuiInstance, _theme, _kb, done) => {
					dismissOverlay = () => done(null);
					overlay = new SubagentsOverlay(model, tuiInstance, dismissOverlay, { now });
					startRepaint();
					return overlay;
				},
				{ overlay: true, onHandle: (handle) => { handle.focus(); } },
			)).finally(() => {
				if (version !== overlayVersion) return;
				overlay = undefined;
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
