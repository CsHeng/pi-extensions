import { matchesKey, truncateToWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";
import {
	OBSERVER_STALE_MS,
	displayElapsed,
	observerFreshness,
	overlayLines,
	wrapText,
} from "./render.ts";

export interface OverlaySnapshot {
	snapshot: ObserverSnapshot | undefined;
	receivedAt: number;
}

function isKey(data: string, name: KeyId): boolean {
	return data === name || matchesKey(data, name);
}

function taskFreshness(
	task: ObserverTask,
	freshness: ReturnType<typeof observerFreshness>,
): ReturnType<typeof observerFreshness> {
	const terminalTask = task.status !== "pending" && task.status !== "running";
	return terminalTask && freshness === "live" ? "terminal" : freshness;
}

export class SubagentsOverlay {
	focused = true;
	private offset = 0;
	private pageSize = 10;
	private model: OverlaySnapshot;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly now: () => number;
	private readonly staleMs: number;

	constructor(
		model: OverlaySnapshot,
		tui: TUI,
		done: () => void,
		options: { now?: () => number; staleMs?: number } = {},
	) {
		this.model = model;
		this.tui = tui;
		this.done = done;
		this.now = options.now ?? (() => Date.now());
		this.staleMs = options.staleMs ?? OBSERVER_STALE_MS;
	}

	update(model: OverlaySnapshot): void {
		this.model = model;
		this.tui.requestRender();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (isKey(data, "escape")) {
			this.done();
			return;
		}
		if (isKey(data, "up")) {
			this.offset = Math.max(0, this.offset - 1);
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "down")) {
			this.offset += 1;
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "pageUp")) {
			this.offset = Math.max(0, this.offset - this.pageSize);
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "pageDown")) {
			this.offset += this.pageSize;
			this.tui.requestRender();
		}
	}

	render(width: number, height?: number): string[] {
		if (width <= 0) return [];
		const now = this.now();
		const snapshot = this.model.snapshot;
		const freshness = observerFreshness(snapshot?.phase, this.model.receivedAt, now, this.staleMs);
		const headerElapsed = snapshot
			? displayElapsed(snapshot.elapsedMs, this.model.receivedAt, now, freshness)
			: null;
		const raw = overlayLines(snapshot, freshness, headerElapsed, (task) => (
			displayElapsed(task.elapsedMs, this.model.receivedAt, now, taskFreshness(task, freshness))
		));
		const wrapped = raw.flatMap((line) => wrapText(line, Math.max(1, width)));
		// Pi calls render(width), not render(width, height). Derive the real viewport.
		const viewport = Math.max(1, height ?? Math.floor((this.tui.terminal?.rows ?? 30) * 0.8));
		const overflow = wrapped.length > viewport;
		this.pageSize = Math.max(1, viewport - (overflow && viewport >= 3 ? 2 : 0));
		this.offset = Math.min(this.offset, Math.max(0, wrapped.length - this.pageSize));
		const inner = wrapped.slice(this.offset, this.offset + this.pageSize);
		if (!overflow || viewport < 3) return inner;
		const lines: string[] = [];
		if (this.offset > 0) lines.push(truncateToWidth(`↑ ${this.offset} hidden`, width));
		lines.push(...inner);
		const hiddenBelow = wrapped.length - this.offset - inner.length;
		if (hiddenBelow > 0) lines.push(truncateToWidth(`↓ +${hiddenBelow} more`, width));
		return lines;
	}
}
