/** Shared presentation for independently collapsible above-editor sections. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PanelTone = "accent" | "warning" | "error" | "success" | "text" | "muted" | "dim";
export interface PanelTheme { fg(color: PanelTone, text: string): string }

/**
 * `▾ Title · subtitle (progress) focus · alerts`.
 * The section name leads; progress is a muted aside; the line ends on what is active now
 * (`2 running`, `1 doing`) and then on alerts, so the eye lands on current work.
 */
export interface PanelHeadingContent {
	title: string;
	/** Optional owner text such as a list title. It shrinks first and drops when too little room remains. */
	subtitle?: string;
	/** Completed-of-total summary shown in parentheses, e.g. `3/7 done`. */
	progress?: string;
	/** Current active counts; zero counts are omitted by the owner. */
	focus?: readonly string[];
	/** Current conditions that need attention; the only source of the warning marker. */
	alerts?: readonly string[];
}

export interface PanelHeadingOptions {
	folded: boolean;
	theme?: PanelTheme | undefined;
}

const SEPARATOR = " · ";
const SUBTITLE_MIN = 8;
const plain: PanelTheme = { fg: (_color, text) => text };

/** Accept a host theme only when it exposes `fg`; otherwise render plain text. */
export function panelTheme(value: unknown): PanelTheme | undefined {
	if (!value || typeof value !== "object") return undefined;
	return typeof (value as { fg?: unknown }).fg === "function" ? value as PanelTheme : undefined;
}

export function panelHeading(content: PanelHeadingContent, width: number, options: PanelHeadingOptions): string {
	width = Math.max(0, Math.floor(width));
	const theme = options.theme ?? plain;
	const alerts = (content.alerts ?? []).filter(Boolean);
	const focus = (content.focus ?? []).filter(Boolean);
	const warning = alerts.length > 0;
	const head = `${options.folded ? "▸" : "▾"} ${warning ? "! " : ""}${content.title}`;
	const progress = content.progress ? ` (${content.progress})` : "";
	const tail: Array<{ text: string; tone: PanelTone }> = [
		...focus.map(text => ({ text, tone: "text" as const })),
		...alerts.map(text => ({ text, tone: "warning" as const })),
	];
	const tailText = tail.map(part => part.text).join(SEPARATOR);
	const fixed = visibleWidth(head) + visibleWidth(progress) + (tailText ? 1 + visibleWidth(tailText) : 0);
	const subtitleRoom = width - fixed - visibleWidth(SEPARATOR);
	let line = theme.fg(warning ? "warning" : "accent", head);
	if (content.subtitle && subtitleRoom >= SUBTITLE_MIN) line += theme.fg("dim", SEPARATOR) + theme.fg("text", truncateToWidth(content.subtitle, subtitleRoom, "…"));
	if (progress) line += theme.fg("muted", progress);
	tail.forEach((part, index) => { line += (index === 0 ? " " : theme.fg("dim", SEPARATOR)) + theme.fg(part.tone, part.text); });
	return truncateToWidth(line, width, "…");
}
