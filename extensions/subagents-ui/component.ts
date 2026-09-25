import { Key, matchesKey, visibleWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";
import {
	OBSERVER_STALE_MS,
	closeMarkerColumns,
	displayElapsed,
	fillPanelRow,
	formatGroupHint,
	formatGroupRow,
	helpText,
	observerFreshness,
	overlayPanelWidth,
	overlayRows,
	panelTextWidth,
	panelTitleRow,
	settledRows,
	settledSummary,
	taskColumns,
	type OverlayRow,
	type RowColor,
	wrapText,
} from "./render.ts";

export interface OverlaySnapshot {
	snapshot: ObserverSnapshot | undefined;
	receivedAt: number;
	batch?: number;
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

function isLiveTask(task: ObserverTask): boolean {
	return task.status === "pending" || task.status === "running";
}

export class SubagentsOverlay {
	focused = true;
	private offset = 0;
	private pageSize = 10;
	private expanded = false;
	private lastOverflow = false;
	private lastRunId: string | undefined = undefined;
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
		this.lastRunId = model.snapshot?.runId;
	}

	update(model: OverlaySnapshot): void {
		const runId = model.snapshot?.runId;
		if (runId !== this.lastRunId) {
			this.lastRunId = runId;
			this.expanded = false;
			this.offset = 0;
		}
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
		const group = this.hasGroup();
		if (isKey(data, "enter")) {
			if (group) {
				this.expanded = !this.expanded;
				this.tui.requestRender();
			}
			return;
		}
		if (isKey(data, "up")) {
			// At the top of an expanded group, up folds it back instead of scrolling.
			if (group && this.expanded && this.offset === 0) this.expanded = false;
			else this.offset = Math.max(0, this.offset - 1);
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "down")) {
			// A folded group at the top opens instead of scrolling into nothing.
			if (group && !this.expanded && this.offset === 0 && !this.lastOverflow) this.expanded = true;
			else this.offset += 1;
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
		return overlayPanelWidth(this.withGroupHint(this.currentRows(true), undefined), terminalColumns);
	}

	private hasGroup(): boolean {
		return this.model.snapshot?.tasks.some(task => !isLiveTask(task)) ?? false;
	}

	private groupHint(): string | undefined {
		if (!this.hasGroup()) return undefined;
		if (!this.expanded) return formatGroupHint(false, this.offset === 0 && !this.lastOverflow ? "down" : undefined);
		return formatGroupHint(true, this.offset === 0 ? "up" : undefined);
	}

	private currentRows(forWidth: boolean): OverlayRow[] {
		const now = this.now();
		const snapshot = this.model.snapshot;
		const freshness = observerFreshness(snapshot?.phase, this.model.receivedAt, now, this.staleMs);
		const headerElapsed = snapshot
			? displayElapsed(snapshot.elapsedMs, this.model.receivedAt, now, freshness)
			: null;
		const rows = overlayRows(snapshot, freshness, headerElapsed, (task) => (
			displayElapsed(task.elapsedMs, this.model.receivedAt, now, taskFreshness(task, freshness))
		), this.model.batch === undefined ? undefined : { batch: this.model.batch });
		if (snapshot && this.expanded) {
			const index = rows.findIndex(row => row.kind === "group");
			const groupRow = index >= 0 ? rows[index] : undefined;
			if (index >= 0 && groupRow) {
				const columns = taskColumns(snapshot.tasks, freshness);
				rows[index] = { ...groupRow, text: formatGroupRow(settledSummary(snapshot.tasks), true) };
				rows.splice(index + 1, 0, ...settledRows(snapshot, (task) => (
					displayElapsed(task.elapsedMs, this.model.receivedAt, now, taskFreshness(task, freshness))
				), columns));
			}
		}
		rows.push({ kind: "help", text: helpText({ overflow: forWidth ? true : this.lastOverflow, hasGroup: this.hasGroup(), expanded: this.expanded }) });
		return rows;
	}

	/** Right-align the group hint inside the text area; fall back to adjacency when narrow. */
	private withGroupHint(rows: OverlayRow[], textWidth: number | undefined): OverlayRow[] {
		const hint = this.groupHint();
		const group = rows.find(row => row.kind === "group");
		if (!hint || !group) return rows;
		const summary = group.text;
		const joined = `${summary} ${hint}`;
		const aligned = textWidth !== undefined && visibleWidth(joined) <= textWidth
			? summary + " ".repeat(textWidth - visibleWidth(summary) - visibleWidth(hint)) + hint
			: joined;
		group.text = aligned;
		group.segments = [{ text: aligned, color: "dim" }];
		return rows;
	}

	private colorRow(row: OverlayRow): string {
		const theme = this.theme;
		if (!theme) return row.text;
		if (row.segments) return row.segments.map(segment => theme.fg(segment.color ?? "text", segment.text)).join("");
		const color: RowColor = row.kind === "title" ? "accent"
			: row.kind === "rule" ? "borderMuted"
			: row.kind === "help" || row.kind === "more" || row.kind === "summary" ? "dim"
			: "text";
		return theme.fg(color, row.text);
	}

	render(width: number, height?: number): string[] {
		if (width <= 0) return [];
		const textWidth = panelTextWidth(width);
		const head: string[] = [];
		const bodySource: OverlayRow[] = [];
		for (const row of this.currentRows(false)) {
			if (row.kind === "title") {
				head.push(panelTitleRow(this.colorRow(row), width));
				continue;
			}
			if (row.kind === "rule") {
				if (head.length === 1) {
					head.push(fillPanelRow(this.colorRow({ kind: "rule", text: "─".repeat(textWidth) }), width));
					continue;
				}
				bodySource.push({ kind: "rule", text: "─".repeat(textWidth) });
				continue;
			}
			bodySource.push(row);
		}
		// Pi calls render(width), not render(width, height). Derive the real viewport.
		const viewport = Math.max(1, height ?? Math.floor((this.tui.terminal?.rows ?? 30) * 0.8));
		const pinned = viewport >= head.length + 2 ? head : [];
		const bodyViewport = Math.max(1, viewport - pinned.length);
		// The help row text depends on overflow, which depends on wrapped body length: settle both.
		let overflow = this.lastOverflow;
		let body: string[] = [];
		for (let pass = 0; pass < 2; pass += 1) {
			const helpIndex = bodySource.findIndex(row => row.kind === "help");
			const rows = bodySource.map(row => (row.kind === "help"
				? { ...row, text: helpText({ overflow, hasGroup: this.hasGroup(), expanded: this.expanded }) }
				: row));
			body = rows.flatMap(row => wrapText(this.colorRow(row), textWidth).map(line => fillPanelRow(line, width)));
			const next = body.length > bodyViewport;
			if (next === overflow) break;
			overflow = next;
			if (helpIndex < 0) break;
		}
		this.lastOverflow = overflow;
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
