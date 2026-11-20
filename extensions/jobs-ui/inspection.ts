import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { inspectionRow, ItemDetailPage, type InspectionItem } from "../shared/inspection-rows.ts";

export const JOBS_LIST_PAGE_SIZE = 20;

export interface JobsInspectionHandle { close(): void; refresh(): void }
export interface JobsInspectionView { items: InspectionItem[]; unavailable?: string }

/** The source is re-read on every render and key, so revoked records cannot stay visible. */
export async function openJobsInspection(ctx: ExtensionContext, source: () => JobsInspectionView, initial?: string, mounted?: (handle: JobsInspectionHandle | undefined) => void): Promise<void> {
	try { await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		let closed = false;
		const close = () => { if (!closed) { closed = true; done(); } };
		mounted?.({ close, refresh: () => tui.requestRender() });
		let selected = initial;
		let detail = initial !== undefined;
		let page = new ItemDetailPage();
		let width = 0, capacity = 1;
		let hits: string[] = [];
		let pressed: string | undefined;
		return {
			render(nextWidth: number) {
				width = Math.max(0, Math.floor(nextWidth));
				const view = source(), current = view.items;
				if (!detail && !current.some(item => item.key === selected)) selected = current[0]?.key;
				const inner = Math.max(0, width - 4);
				const height = Math.max(4, Math.floor(tui.terminal.rows * 0.85));
				capacity = Math.max(1, Math.min(JOBS_LIST_PAGE_SIZE, height - 4));
				const title = truncateToWidth(detail ? "Job detail" : "Jobs", Math.max(0, inner - 2), "…");
				const header = theme.fg("accent", title + " ".repeat(Math.max(0, inner - visibleWidth(title) - 1)) + "×");
				let body: string[];
				hits = [];
				if (detail) body = page.render("Job detail", current.find(item => item.key === selected), inner, height - 3, theme).slice(1);
				else if (view.unavailable !== undefined) body = [theme.fg("warning", `Unavailable · ${view.unavailable}`), theme.fg("dim", "Esc close")];
				else if (!current.length) body = [theme.fg("dim", "No jobs"), theme.fg("dim", "Esc close")];
				else {
					const at = Math.max(0, current.findIndex(item => item.key === selected));
					const start = Math.floor(at / capacity) * capacity;
					const visible = current.slice(start, start + capacity);
					hits = visible.map(item => item.key);
					body = [...visible.map(item => inspectionRow(item, inner, theme, item.key === selected, "  ")),
						theme.fg("dim", `${start + 1}–${start + visible.length} of ${current.length} · ↑↓ select · Enter detail · PgUp/PgDn · Esc close`)];
				}
				const border = theme.fg("border", "─".repeat(Math.max(0, width - 2)));
				return [theme.fg("border", "╭") + border + theme.fg("border", "╮"), ...[header, ...body].map(line => {
					const clipped = truncateToWidth(line, inner, "…");
					return theme.fg("border", "│ ") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + theme.fg("border", " │");
				}), theme.fg("border", "╰") + border + theme.fg("border", "╯")];
			},
			invalidate() {},
			handleMouse(event: TuiMouseEvent) {
				if (tui.mode !== "fullscreen" || event.button !== "left" || (event.type !== "press" && event.type !== "click")) return;
				if (event.y === 1 && event.x >= width - 4) { if (event.type === "click") close(); return { handled: true }; }
				const key = !detail ? hits[event.y - 2] : undefined;
				if (event.type === "press") { pressed = key; return key ? { handled: true } : undefined; }
				const down = pressed; pressed = undefined;
				if (key && (down === undefined || down === key)) { selected = key; tui.requestRender(); return { handled: true }; }
			},
			handleInput(data: string) {
				const current = source().items;
				if (matchesKey(data, "escape")) { if (detail && initial === undefined) detail = false; else close(); }
				else if (detail) page.handleInput(data);
				else if (matchesKey(data, "enter") && selected && current.some(item => item.key === selected)) { detail = true; page = new ItemDetailPage(); }
				else if (matchesKey(data, "up") || matchesKey(data, "down") || data === "pageUp" || data === "pageDown" || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
					const at = Math.max(0, current.findIndex(item => item.key === selected));
					const delta = data === "pageUp" || matchesKey(data, "pageUp") ? -capacity : data === "pageDown" || matchesKey(data, "pageDown") ? capacity : matchesKey(data, "up") ? -1 : 1;
					selected = current[Math.max(0, Math.min(current.length - 1, at + delta))]?.key;
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%", margin: 1 } }); } finally { mounted?.(undefined); }
}
