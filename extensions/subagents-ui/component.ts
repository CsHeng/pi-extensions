import { Key, matchesKey, wrapTextWithAnsi, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ObserverSnapshot, ObserverTask } from "../subagents/observer-events.ts";
import type { SessionViewReply } from "../subagents/session-view.ts";
import {
	EMPTY_OBSERVER_MESSAGE,
	OBSERVER_STALE_MS,
	closeMarkerColumns,
	displayElapsed,
	fillPanelRow,
	formatHistoryCollapsed,
	formatHistoryNav,
	formatHistoryRow,
	formatLiveDetail,
	formatLiveRow,
	formatSessionCounts,
	formatSessionTitle,
	formatSessionUsage,
	historyColumns,
	observerFreshness,
	overlayPanelWidth,
	panelTextWidth,
	panelTitleRow,
	sessionCounts,
	sessionHelpText,
	shortLabel,
	taskColumns,
	type OverlayRow,
	type RowColor,
	type ObserverFreshness,
	type SessionHelpState,
} from "./render.ts";

export interface SessionViewState {
	kind: "idle" | "loading" | "ready" | "unavailable";
	reason?: string;
	reply?: SessionViewReply;
	/** A same-page refresh keeps the previous rows visible instead of a blank loading state. */
	refreshing?: boolean;
}

export interface OverlaySnapshot {
	snapshot: ObserverSnapshot | undefined;
	receivedAt: number;
	session: SessionViewState;
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

function isLiveTask(task: ObserverTask): boolean {
	return task.status === "pending" || task.status === "running";
}

function moreRow(text: string): OverlayRow {
	return { kind: "more", text, segments: [{ text, color: "dim" }] };
}

/**
 * Session-scoped overlay: a pinned live area driven by fresh observer snapshots and a
 * separately navigable history section driven by the core session-view contract.
 */
export class SubagentsOverlay {
	focused = true;
	private historyOpen = false;
	private liveOffset = 0;
	private historyOffset = 0;
	private lastLiveOverflow = false;
	private lastHistoryOverflow = false;
	private closeRange: { start: number; end: number } | undefined;
	private model: OverlaySnapshot;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly now: () => number;
	private readonly staleMs: number;
	private readonly theme: OverlayTheme | undefined;
	private readonly onPage: ((page: number) => void) | undefined;

	constructor(
		model: OverlaySnapshot,
		tui: TUI,
		done: () => void,
		options: { now?: () => number; staleMs?: number; theme?: OverlayTheme; onPage?: (page: number) => void } = {},
	) {
		this.model = model;
		this.tui = tui;
		this.done = done;
		this.now = options.now ?? (() => Date.now());
		this.staleMs = options.staleMs ?? OBSERVER_STALE_MS;
		this.theme = options.theme;
		this.onPage = options.onPage;
	}

	invalidate(): void {}

	update(model: OverlaySnapshot): void {
		this.model = model;
		const live = this.liveTasks().length;
		if (this.liveOffset > Math.max(0, live - 1)) this.liveOffset = Math.max(0, live - 1);
		this.tui.requestRender();
	}

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
		if (isKey(data, "enter")) {
			this.historyOpen = !this.historyOpen;
			this.historyOffset = 0;
			// Opening history on an idle or failed query retries through the core contract.
			if (this.historyOpen && (this.model.session.kind === "idle" || this.model.session.kind === "unavailable")) {
				this.onPage?.(this.model.session.reply?.history.page ?? 0);
			}
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "pageUp") || isKey(data, "pageDown")) {
			const history = this.model.session.reply?.history;
			if (!this.historyOpen || !history) return;
			const target = Math.max(0, Math.min(Math.max(1, history.totalPages) - 1, history.page + (isKey(data, "pageDown") ? 1 : -1)));
			if (target === history.page) return;
			this.historyOffset = 0;
			this.onPage?.(target);
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "up")) {
			if (this.lastLiveOverflow) this.liveOffset = Math.max(0, this.liveOffset - 1);
			else if (this.historyOpen && this.lastHistoryOverflow) this.historyOffset = Math.max(0, this.historyOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "down")) {
			if (this.lastLiveOverflow) this.liveOffset += 1;
			else if (this.historyOpen && this.lastHistoryOverflow) this.historyOffset += 1;
			this.tui.requestRender();
		}
	}

	/** Panel width that fits the current observation, before the host's own margins. */
	desiredWidth(terminalColumns: number): number {
		return overlayPanelWidth(this.currentRows(true), terminalColumns);
	}

	/** Reply usable for display; a refreshing same-page query keeps the previous rows. */
	private displayReply(): SessionViewReply | undefined {
		return this.model.session.reply;
	}

	private liveTasks(): ObserverTask[] {
		return this.model.snapshot?.tasks.filter(isLiveTask) ?? [];
	}

	private labels(rows: ReadonlyArray<SessionViewReply["history"]["rows"][number]>): Map<string, string> {
		const handles = [...this.liveTasks().map(task => task.id), ...rows.map(row => row.handle)];
		return new Map(handles.map(handle => [handle, shortLabel(handle, handles)]));
	}

	private currentRows(forWidth: boolean): OverlayRow[] {
		const now = this.now();
		const snapshot = this.model.snapshot;
		const freshness: ObserverFreshness = observerFreshness(snapshot?.phase, this.model.receivedAt, now, this.staleMs);
		const reply = this.displayReply();
		const counts = sessionCounts(snapshot, reply, this.model.session.kind, this.model.session.reason, this.model.session.refreshing === true);
		const rows: OverlayRow[] = [
			{ kind: "title", text: formatSessionTitle(reply?.ownerSessionId) },
			{ kind: "rule", text: "" },
			formatSessionCounts(counts),
		];
		const usage = formatSessionUsage(reply?.usage ?? null);
		if (usage) rows.push(usage);
		rows.push({ kind: "rule", text: "" });
		// Pinned live area: primary rows always precede optional detail lines, and only
		// overflow through its own explicit, independently navigable window.
		let liveRows: OverlayRow[] = [];
		const live = this.liveTasks();
		if (live.length === 0 && !reply) {
			const text = EMPTY_OBSERVER_MESSAGE;
			rows.push({ kind: "summary", text, segments: [{ text, color: "dim" }] });
		} else if (live.length === 0) {
			const text = "No live agents; retained work is in history.";
			rows.push({ kind: "summary", text, segments: [{ text, color: "dim" }] });
		} else {
			liveRows = this.liveRows(freshness, true);
			rows.push(...liveRows);
		}
		if (this.historyOpen) {
			rows.push({ kind: "rule", text: "" });
			if (!reply || reply.history.state !== "ready") {
				const label = this.model.session.kind === "loading"
					? (this.model.session.refreshing ? "history refreshing…" : "history loading…")
					: this.model.session.kind === "unavailable"
						? `history unavailable${this.model.session.reason ? ` (${this.model.session.reason})` : ""}`
						: "history not loaded";
				rows.push({ kind: "group", text: label, segments: [{ text: label, color: "dim" }] });
			} else {
				const nav = formatHistoryNav(reply.history);
				rows.push({ kind: "group", text: nav, segments: [{ text: nav, color: "dim" }] });
				const labels = this.labels(reply.history.rows);
				const columns = historyColumns(reply.history.rows, labels);
				rows.push(...reply.history.rows.map(row => formatHistoryRow(row, labels.get(row.handle) ?? row.handle, columns)));
			}
		} else {
			const collapsed = formatHistoryCollapsed(this.model.session);
			rows.push({ kind: "group", text: collapsed, segments: [{ text: collapsed, color: "dim" }] });
		}
		const help: SessionHelpState = { liveOverflow: forWidth ? false : this.lastLiveOverflow, historyOpen: this.historyOpen, historyOverflow: forWidth ? false : this.lastHistoryOverflow };
		rows.push({ kind: "help", text: sessionHelpText(help) });
		return rows;
	}

	private liveRows(freshness: ObserverFreshness, withDetails: boolean): OverlayRow[] {
		const snapshot = this.model.snapshot;
		if (!snapshot) return [];
		const now = this.now();
		const columns = taskColumns(snapshot.tasks, freshness);
		const rows: OverlayRow[] = [];
		for (const task of this.liveTasks()) {
			const elapsed = displayElapsed(task.elapsedMs, this.model.receivedAt, now, freshness);
			rows.push(formatLiveRow({ ...task, elapsedMs: elapsed }, freshness, columns, shortLabel(task.id, this.liveTasks().map(row => row.id))));
			if (withDetails) {
				const detail = formatLiveDetail(task);
				if (detail) rows.push(detail);
			}
		}
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

	private wrapRow(text: string, width: number): string[] {
		if (width <= 0) return [];
		return text.split("\n").flatMap(part => wrapTextWithAnsi(part, width));
	}

	render(width: number, height?: number): string[] {
		if (width <= 0) return [];
		const textWidth = panelTextWidth(width);
		const viewport = Math.max(1, height ?? this.tui.terminal?.rows ?? 30);
		const rows = this.currentRows(false);
		const physical = (row: OverlayRow) => this.wrapRow(this.colorRow(row), textWidth).map(line => fillPanelRow(line, width));
		const compact = (row: OverlayRow) => fillPanelRow(this.colorRow(row), width);
		const groupIndex = rows.findIndex(row => row.kind === "group");
		const firstLive = rows.findIndex(row => row.kind === "live");
		const headerEnd = firstLive < 0 ? groupIndex : firstLive;
		let header = rows.slice(0, Math.max(0, headerEnd)).filter(row => row.kind !== "liveDetail").flatMap(row =>
			row.kind === "title" ? [panelTitleRow(this.colorRow(row), width)]
				: row.kind === "rule" ? [compact({ ...row, text: "─".repeat(textWidth) })] : physical(row));
		const primary = rows.filter(row => row.kind === "live");
		this.lastLiveOverflow = false;
		this.lastHistoryOverflow = false;
		const lines: string[] = [];
		// Primary live rows take precedence over history and optional detail. Count physical,
		// wrapped header/history lines before budgeting, never rely on host clipping.
		if (primary.length && header.length + primary.length + 2 > viewport) {
			this.lastLiveOverflow = true;
			header = header.slice(0, Math.max(0, Math.min(header.length, viewport - 3)));
			const window = Math.max(1, viewport - header.length - 1);
			this.liveOffset = Math.min(this.liveOffset, Math.max(0, primary.length - window));
			lines.push(...header, ...primary.slice(this.liveOffset, this.liveOffset + window).map(compact));
			if (lines.length < viewport) lines.push(compact(moreRow(`live ${this.liveOffset + 1}–${Math.min(primary.length, this.liveOffset + window)}/${primary.length} · ↑↓ live · ctrl+alt+f close`)));
		} else {
			header = header.slice(0, Math.max(0, viewport - primary.length - 2));
			lines.push(...header, ...primary.map(compact));
			const detail = rows.filter(row => row.kind === "liveDetail").flatMap(physical);
			const detailBudget = Math.max(0, viewport - lines.length - (this.historyOpen ? 4 : 2));
			if (detail.length <= detailBudget) lines.push(...detail);
			const group = rows[groupIndex];
			if (group && lines.length < viewport - 1) lines.push(compact(group));
			const history = rows.filter(row => row.kind === "settled").flatMap(physical);
			const budget = Math.max(0, viewport - lines.length - 1);
			this.lastHistoryOverflow = this.historyOpen && history.length > budget;
			this.historyOffset = Math.min(this.historyOffset, Math.max(0, history.length - budget));
			if (this.historyOpen) lines.push(...history.slice(this.historyOffset, this.historyOffset + budget));
			if (lines.length < viewport) lines.push(compact({ kind: "help", text: sessionHelpText({ liveOverflow: false, historyOpen: this.historyOpen, historyOverflow: this.lastHistoryOverflow }) }));
		}
		this.closeRange = header.length > 0 ? closeMarkerColumns(width) : undefined;
		return this.theme ? lines.map(line => this.theme!.bg("selectedBg", line)) : lines;
	}
}
