/** Read-only list dialog in the same central overlay surface as the Subagents inspector. */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

export async function openListOverlay(
	ctx: ExtensionContext,
	title: string,
	rows: (width: number, theme: Theme) => string[],
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		let width = -1;
		let height = -1;
		let container: Container;
		let list: SelectList;
		let previousRows = "";
		const rebuild = (nextWidth: number, content: string[]) => {
			const selected = list?.getSelectedItem()?.value;
			width = nextWidth;
			height = tui.terminal.rows;
			const bodyWidth = Math.max(1, width - 4);
			const items = content.map((label, index) => ({ value: String(index), label }));
			list = new SelectList(items, Math.max(1, Math.min(items.length, Math.floor(height * 0.85) - 8)), {
				selectedPrefix: text => theme.fg("accent", text),
				selectedText: text => text, // Keep done-title strike/dim and state colors.
				description: text => theme.fg("muted", text),
				scrollInfo: text => theme.fg("dim", text),
				noMatch: text => theme.fg("dim", text),
			}, { maxPrimaryColumnWidth: bodyWidth });
			if (selected !== undefined) list.setSelectedIndex(Number(selected));
			list.onCancel = () => done();
			list.onSelect = () => done();
			container = new Container();
			const titleText = truncateToWidth(title, Math.max(0, bodyWidth - 2), "…");
			container.addChild(new Text(theme.fg("accent", titleText + " ".repeat(Math.max(0, bodyWidth - visibleWidth(titleText) - 1)) + "×"), 0, 0));
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter/Esc close"), 0, 0));
		};
		return {
			render(nextWidth: number) {
				const content = rows(Math.max(1, nextWidth - 6), theme);
				const serialized = content.join("\n");
				if (width !== nextWidth || height !== tui.terminal.rows || previousRows !== serialized) {
					rebuild(nextWidth, content); previousRows = serialized;
				}
				const innerWidth = Math.max(0, width - 4);
				const border = theme.fg("border", "─".repeat(Math.max(0, width - 2)));
				return [theme.fg("border", "╭") + border + theme.fg("border", "╮"),
					...container.render(innerWidth).map(line => {
						const clipped = truncateToWidth(line, innerWidth, "…");
						return theme.fg("border", "│ ") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + theme.fg("border", " │");
					}), theme.fg("border", "╰") + border + theme.fg("border", "╯")];
			},
			invalidate() { width = -1; },
			handleMouse(event: TuiMouseEvent) {
				if (tui.mode !== "fullscreen") return undefined;
				if (event.button === "left" && event.y === 1 && event.x >= width - 4) {
					if (event.type === "click") done();
					return { handled: true };
				}
				if (event.y < 2) return undefined;
				return list?.handleMouse({ ...event, x: event.x - 2, y: event.y - 2, width: Math.max(1, width - 4) });
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) { done(); return; }
				list?.handleInput(data); tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%", margin: 1 } });
}
