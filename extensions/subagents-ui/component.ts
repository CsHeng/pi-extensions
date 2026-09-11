import { Key, matchesKey, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";
import {
	OBSERVER_STALE_MS,
	closeMarkerColumns,
	displayElapsed,
	fillPanelRow,
	observerFreshness,
	overlayPanelWidth,
	overlayRows,
	panelTextWidth,
	panelTitleRow,
	type OverlayRow,
	wrapText,
} from "./render.ts";

export interface OverlaySnapshot {
	snapshot: ObserverSnapshot | undefined;
	receivedAt: number;
}

/** Theme subset used to paint the panel; callers may omit it for plain text. */
export interface OverlayTheme {
	fg(color: "accent" | "borderMuted" | "dim" | "text", text: string): string;
	bg(color: "selectedBg", text: string): string;
}

/** Subset of the fullscreen mouse event consumed by the close marker. */
interface OverlayPointerEvent {
	type: string;
	button?: string;
	x: number;
	y: number;
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
	private closeRange: { start: number; end: number } | undefined = undefined;
	private model: OverlaySnapshot;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly now: () => number;
	private readonly staleMs: number;
	private readonly theme: OverlayTheme | undefined;

	constructor(
		model: OverlaySnapshot,
		tui: TUI,
		done: () => void,
		options: { now?: () => number; staleMs?: number; theme?: OverlayTheme } = {},
	) {
		this.model = model;
		this.tui = tui;
		this.done = done;
		this.now = options.now ?? (() => Date.now());
		this.staleMs = options.staleMs ?? OBSERVER_STALE_MS;
		this.theme = options.theme;
	}

	update(model: OverlaySnapshot): void {
		this.model = model;
		this.tui.requestRender();
	}

	invalidate(): void {}

	/** Fullscreen-only close affordance; regular mode never captures pointer input. */
	handleMouse(event: OverlayPointerEvent): { handled: true } | undefined {
		const range = this.closeRange;
		if (!range || event.y !== 0 || event.x < range.start || event.x >= range.end) return undefined;
		if (event.button !== "left") return undefined;
		// Arm the press gesture so the host synthesizes the matching click.
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		this.done();
		return { handled: true };
	}

	handleInput(data: string): void {
		if (isKey(data, Key.ctrlAlt("f"))) {
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

	/** Panel width that fits the current observation, before the host's own margins. */
	desiredWidth(terminalColumns: number): number {
		return overlayPanelWidth(this.currentRows(), terminalColumns);
	}

	private currentRows(): OverlayRow[] {
		const now = this.now();
		const snapshot = this.model.snapshot;
		const freshness = observerFreshness(snapshot?.phase, this.model.receivedAt, now, this.staleMs);
		const headerElapsed = snapshot
			? displayElapsed(snapshot.elapsedMs, this.model.receivedAt, now, freshness)
			: null;
		return overlayRows(snapshot, freshness, headerElapsed, (task) => (
			displayElapsed(task.elapsedMs, this.model.receivedAt, now, taskFreshness(task, freshness))
		));
	}

	private colorRow(row: OverlayRow): string {
		if (!this.theme) return row.text;
		switch (row.kind) {
			case "title": return this.theme.fg("accent", row.text);
			case "rule": return this.theme.fg("borderMuted", row.text);
			case "help":
			case "more": return this.theme.fg("dim", row.text);
			default: return row.text;
		}
	}

	render(width: number, height?: number): string[] {
		if (width <= 0) return [];
		const textWidth = panelTextWidth(width);
		const head: string[] = [];
		const body: string[] = [];
		for (const row of this.currentRows()) {
			if (row.kind === "title") {
				head.push(panelTitleRow(this.colorRow(row), width));
				continue;
			}
			if (row.kind === "rule") {
				head.push(fillPanelRow(this.colorRow({ kind: "rule", text: "─".repeat(textWidth) }), width));
				continue;
			}
			for (const line of wrapText(this.colorRow(row), textWidth)) body.push(fillPanelRow(line, width));
		}
		// Pi calls render(width), not render(width, height). Derive the real viewport.
		const viewport = Math.max(1, height ?? Math.floor((this.tui.terminal?.rows ?? 30) * 0.8));
		const pinned = viewport >= head.length + 2 ? head : [];
		const bodyViewport = Math.max(1, viewport - pinned.length);
		const overflow = body.length > bodyViewport;
		this.pageSize = Math.max(1, bodyViewport - (overflow && bodyViewport >= 3 ? 2 : 0));
		this.offset = Math.min(this.offset, Math.max(0, body.length - this.pageSize));
		const inner = body.slice(this.offset, this.offset + this.pageSize);
		const lines: string[] = [...pinned];
		if (!overflow || bodyViewport < 3) lines.push(...inner);
		else {
			if (this.offset > 0) lines.push(fillPanelRow(this.colorRow({ kind: "more", text: `↑ ${this.offset} hidden` }), width));
			lines.push(...inner);
			const hiddenBelow = body.length - this.offset - inner.length;
			if (hiddenBelow > 0) lines.push(fillPanelRow(this.colorRow({ kind: "more", text: `↓ +${hiddenBelow} more` }), width));
		}
		if (lines.length === 0) return lines;
		this.closeRange = pinned.length > 0 ? closeMarkerColumns(width) : undefined;
		const theme = this.theme;
		return theme ? lines.map(line => theme.bg("selectedBg", line)) : lines;
	}
}
