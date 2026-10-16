/** Shared presentation for independently collapsible above-editor sections. */
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface PanelHeadingOptions {
	folded: boolean;
	warning?: boolean;
	theme?: { fg(color: "accent" | "warning", text: string): string };
}

/** Content excludes the disclosure/warning markers; business summaries remain owner-specific. */
export function panelHeading(content: string, width: number, options: PanelHeadingOptions): string {
	const marker = options.folded ? "▸" : "▾";
	const line = `${marker} ${options.warning ? "! " : ""}${content}`;
	const styled = options.theme ? options.theme.fg(options.warning ? "warning" : "accent", line) : line;
	return truncateToWidth(styled, Math.max(0, width), "…");
}
