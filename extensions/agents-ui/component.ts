import { Key, matchesKey, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ObserverSnapshot } from "../agents/observer-events.ts";
import type { SessionViewReply } from "../agents/session-view.ts";
import { inspectionRow, ItemDetailPage, type InspectionItem } from "../shared/inspection-rows.ts";
import type { PanelTone } from "../shared/panel-heading.ts";
import {
	agentItemKey, agentListSections, closeMarkerColumns, EMPTY_OBSERVER_MESSAGE, fillPanelRow, formatAgentUsage, formatHistoryCollapsed,
	formatHistoryNav, formatSessionTitle, observationAt, OBSERVER_STALE_MS, overlayPanelWidth,
	panelTextWidth, panelTitleRow, PANEL_FRAME, sessionHelpText,
} from "./render.ts";

export interface SessionViewState {
	kind: "idle" | "loading" | "ready" | "unavailable";
	reason?: string;
	reply?: SessionViewReply;
	refreshing?: boolean;
}
export interface OverlaySnapshot { snapshot: ObserverSnapshot | undefined; receivedAt: number; session: SessionViewState }
export interface OverlayTheme { fg(color: PanelTone | "border" | "borderMuted", text: string): string }

function isKey(data: string, name: KeyId): boolean { return data === name || matchesKey(data, name); }

/** Session-scoped, read-only inspector. Selection belongs to an episode key, not its mutable title or position. */
export class AgentsOverlay {
	focused = true;
	private historyOpen = false;
	private selectedKey: string | undefined;
	private followSelection = false;
	private detailKey: string | undefined;
	private detailPage = new ItemDetailPage();
	private readonly inlineOrigin: boolean;
	private liveOffset = 0;
	private historyOffset = 0;
	private liveOverflow = false;
	private closeRange: { start: number; end: number } | undefined;
	private model: OverlaySnapshot;
	private readonly readModel: (() => OverlaySnapshot) | undefined;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly now: () => number;
	private readonly staleMs: number;
	private readonly theme: OverlayTheme | undefined;
	private readonly onPage: ((page: number) => void) | undefined;

	constructor(model: OverlaySnapshot | (() => OverlaySnapshot), tui: TUI, done: () => void,
		options: { now?: () => number; staleMs?: number; theme?: OverlayTheme; onPage?: (page: number) => void; detailKey?: string } = {}) {
		this.readModel = typeof model === "function" ? model : undefined;
		this.model = typeof model === "function" ? model() : model;
		this.detailKey = this.selectedKey = options.detailKey;
		this.inlineOrigin = options.detailKey !== undefined;
		this.tui = tui; this.done = done;
		this.now = options.now ?? Date.now; this.staleMs = options.staleMs ?? OBSERVER_STALE_MS;
		this.theme = options.theme; this.onPage = options.onPage;
	}

	invalidate(): void {}
	update(model: OverlaySnapshot): void { this.model = model; this.tui.requestRender(); }

	handleMouse(event: { type: string; button?: string; x: number; y: number }): { handled: true } | undefined {
		const range = this.closeRange;
		if (!range || event.y !== PANEL_FRAME || event.x < range.start || event.x >= range.end || event.button !== "left") return undefined;
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		this.done(); return { handled: true };
	}

	private sections() {
		const { snapshot, receivedAt, session } = this.model;
		const { tasks, stale } = observationAt(snapshot, receivedAt, this.now(), this.staleMs);
		const reply = session.reply;
		const allowHistory = !this.inlineOrigin || (session.kind !== "unavailable" && session.kind !== "idle" && reply?.inventory.state === "ready" && reply.summary != null);
		const page = allowHistory && reply?.history.state === "ready" ? reply.history : undefined;
		const { live, finished, retained } = agentListSections(tasks, page?.rows ?? [], stale);
		// The core owns page membership. Keep a selected, just-finished episode reachable while its retained row catches up.
		const recent = finished.filter(item => !page || page.totalPages <= 1 || item.key === this.selectedKey || page.rows.some(row => item.key === agentItemKey(row.handle, row.episode)));
		return { stale, observed: live, retained: [...recent, ...retained.map(item => session.kind === "unavailable"
			? { ...item, detail: () => [`Cached history · unavailable (${session.reason ?? "unknown"})`, ...item.detail()] } : item)] };
	}

	private detailItem(key: string): InspectionItem | undefined {
		const { observed, retained } = this.sections();
		return observed.find(item => item.key === key) ?? retained.find(item => item.key === key);
	}

	handleInput(data: string): void {
		if (isKey(data, Key.ctrlAlt("f"))) { this.done(); return; }
		if (isKey(data, "escape")) {
			if (this.detailKey && !this.inlineOrigin) { this.detailKey = undefined; this.tui.requestRender(); } else this.done();
			return;
		}
		if (this.detailKey) { if (this.detailPage.handleInput(data)) this.tui.requestRender(); return; }
		if (data.toLowerCase() === "h") {
			this.historyOpen = !this.historyOpen; this.historyOffset = 0;
			if (!this.historyOpen && this.sections().retained.some(item => item.key === this.selectedKey)) this.selectedKey = undefined;
			if (this.historyOpen && (this.model.session.kind === "idle" || this.model.session.kind === "unavailable")) this.onPage?.(this.model.session.reply?.history.page ?? 0);
			this.tui.requestRender(); return;
		}
		if (isKey(data, "pageUp") || isKey(data, "pageDown")) {
			const history = this.model.session.reply?.history;
			if (!this.historyOpen || !history) return;
			const target = Math.max(0, Math.min(Math.max(1, history.totalPages) - 1, history.page + (isKey(data, "pageDown") ? 1 : -1)));
			if (target !== history.page) { this.historyOffset = 0; this.onPage?.(target); this.tui.requestRender(); }
			return;
		}
		if (!isKey(data, "enter") && !isKey(data, "up") && !isKey(data, "down")) return;
		const { observed, retained } = this.sections();
		const items = this.historyOpen ? [...observed, ...retained] : observed;
		if (isKey(data, "enter")) {
			const key = this.selectedKey ?? items[0]?.key;
			if (key) { this.followSelection = true; this.detailKey = this.selectedKey = key; this.detailPage = new ItemDetailPage(); this.tui.requestRender(); }
			return;
		}
		const at = items.findIndex(item => item.key === this.selectedKey);
		const next = Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + (isKey(data, "down") ? 1 : -1)));
		this.selectedKey = items[next]?.key;
		this.followSelection = this.selectedKey !== undefined;
		if (next < observed.length && this.liveOverflow) this.liveOffset = next;
		this.tui.requestRender();
	}

	private historyHeading(): string {
		const session = this.model.session;
		if (!this.historyOpen) return formatHistoryCollapsed(session);
		const history = session.reply?.history;
		if (history?.state === "ready") return formatHistoryNav(history).text;
		if (session.kind === "loading") return session.refreshing ? "history refreshing…" : "history loading…";
		return session.kind === "unavailable" ? `⚠ history unavailable${session.reason ? ` (${session.reason})` : ""}` : "history not loaded";
	}

	desiredWidth(terminalColumns = this.tui.terminal?.columns ?? 80): number {
		const { observed, retained } = this.sections();
		return overlayPanelWidth([{ kind: "title", text: formatSessionTitle(this.model.session.reply?.ownerSessionId) }, { kind: "group", text: this.historyHeading() },
			...[...observed, ...(this.historyOpen ? retained : [])].map(item => ({ kind: "live" as const, item, text: inspectionRow(item, terminalColumns) }))], terminalColumns);
	}

	render(width: number, height?: number): string[] {
		if (width <= 0) return [];
		// An idle repaint still checks the current owner's trust before displaying detail.
		if (this.readModel) this.model = this.readModel();
		const rows = Math.max(1, height ?? this.tui.terminal?.rows ?? 30);
		if (width <= PANEL_FRAME * 2 || rows <= PANEL_FRAME * 2) return this.renderBody(width, rows);
		const inner = width - PANEL_FRAME * 2;
		const body = this.renderBody(inner, rows - PANEL_FRAME * 2);
		if (this.closeRange) this.closeRange = { start: Math.max(0, width - 4), end: width };
		const border = (s: string) => this.theme?.fg("border", s) ?? s;
		const rule = "─".repeat(inner);
		return [border("╭" + rule + "╮"), ...body.map(line => border("│") + line + border("│")), border("╰" + rule + "╯")];
	}

	private renderBody(width: number, viewport: number): string[] {
		const textWidth = panelTextWidth(width);
		const theme = this.theme;
		const fg = (tone: PanelTone | "borderMuted", text: string) => theme?.fg(tone, text) ?? text;
		this.closeRange = closeMarkerColumns(width);
		if (this.detailKey) {
			const item = this.detailItem(this.detailKey), usage = this.model.session.reply?.usage;
			const detail = item && usage ? { ...item, detail: () => [...item.detail(), `Session recorded usage: ${formatAgentUsage(usage)}`] } : item;
			return this.detailPage.render("Agent detail", detail, textWidth, viewport, theme).map((line, i) => i === 0 ? panelTitleRow(line, width) : fillPanelRow(line, width));
		}
		const sections = this.sections();
		const { observed, stale } = sections;
		// Follow a person-selected episode into history, not the default cursor on an untouched list.
		if (this.followSelection && sections.retained.some(item => item.key === this.selectedKey)) this.historyOpen = true;
		const retained = this.historyOpen ? sections.retained : [];
		const all = [...observed, ...retained];
		if (!all.some(item => item.key === this.selectedKey)) { this.selectedKey = all[0]?.key; this.followSelection = false; }
		const session = this.model.session, reply = session.reply;
		const lines = [panelTitleRow(fg("accent", formatSessionTitle(reply?.ownerSessionId)), width)];
		const add = (s: string) => { if (lines.length < viewport) lines.push(fillPanelRow(s, width)); };
		const draw = (item: InspectionItem) => add(inspectionRow(item, textWidth, theme, item.key === this.selectedKey));
		const rule = () => add(fg("borderMuted", "─".repeat(textWidth)));
		if (viewport < 6) { const selected = all.find(item => item.key === this.selectedKey); if (selected) draw(selected); return lines; }
		if (viewport >= 10) rule();
		add(fg("accent", `${stale ? "?" : this.model.snapshot ? observed.length : reply?.summary?.liveAgents ?? "?"} live`) + fg("dim", ` · ${reply?.summary?.agents ?? "?"} agent${reply?.summary?.agents === 1 ? "" : "s"}`));
		if (session.kind === "unavailable" && reply?.history.state === "ready") add(fg("warning", `⚠ history unavailable (${session.reason ?? "unknown"}) · cached`));
		else if (reply?.inventory.state === "ready" && !reply.inventory.complete) add(fg("warning", "⚠ history partial"));
		else if (!reply && this.model.snapshot) add(fg("dim", "limited live observation"));
		else if (session.refreshing) add(fg("dim", "history refreshing"));
		this.liveOverflow = false;
		if (observed.length) {
			if (viewport >= 9) add(fg("accent", stale ? "observation stale" : "running") + fg("dim", ` · ${observed.length} agent${observed.length === 1 ? "" : "s"}`));
			// Pin live identities first while keeping history navigation and one selected historical row reachable.
			const room = Math.max(1, viewport - lines.length - 2 - Number(retained.length > 0));
			this.liveOverflow = observed.length > room;
			const count = Math.max(1, Math.min(observed.length, room - Number(this.liveOverflow)));
			this.liveOffset = windowStart(this.liveOffset, observed, count, this.selectedKey);
			observed.slice(this.liveOffset, this.liveOffset + count).forEach(draw);
			if (this.liveOverflow && room > 1) add(fg("dim", `live ${this.liveOffset + 1}–${this.liveOffset + count}/${observed.length} · ↑↓ live`));
		} else if (viewport >= 9) add(fg("dim", reply ? "No live agents; retained work is in history." : EMPTY_OBSERVER_MESSAGE));
		if (observed.length && viewport - lines.length >= 4 + Number(retained.length > 0)) rule();
		add(fg(session.kind === "unavailable" ? "warning" : "accent", this.historyHeading()));
		const room = Math.max(0, viewport - lines.length - 1);
		this.historyOffset = windowStart(this.historyOffset, retained, room, this.selectedKey);
		retained.slice(this.historyOffset, this.historyOffset + room).forEach(draw);
		add(fg("dim", sessionHelpText({ historyOpen: this.historyOpen })));
		return lines;
	}
}

/** Scroll just enough to keep the actual selected item in this single-line section. */
function windowStart(offset: number, items: InspectionItem[], count: number, selected?: string): number {
	const at = items.findIndex(item => item.key === selected);
	if (at >= 0 && count > 0) offset = Math.min(at, Math.max(offset, at - count + 1));
	return Math.max(0, Math.min(offset, items.length - count));
}
