/** Shared tree-row layout for the above-editor sections and their central lists. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PanelTheme, PanelTone } from "./panel-heading.ts";

/**
 * One item row: `├─ ◐ primary   field  field`. The glyph carries state in shape and tone,
 * the primary text is the item's name, and fields form aligned muted columns after it.
 */
export interface PanelRowSpec {
	glyph: string;
	glyphTone: PanelTone;
	primary: string;
	primaryTone: PanelTone;
	/** Applied to the clipped primary text after tone, e.g. a done task's strike-through. */
	decorate?: (text: string) => string;
	fields?: readonly string[];
}

export interface PanelRowsOptions {
	/** Per-field alignment; durations read best right-aligned. */
	align?: ReadonlyArray<"left" | "right">;
	/** Total rows available for items plus the overflow line. */
	maxRows: number;
	/** Number of items that exist beyond `specs`, e.g. unloaded history. */
	hidden?: number;
	/**
	 * `flex` (default) shrinks the primary text so every field stays visible, for long free text such as a
	 * command. `fixed` keeps an identity whole and lets trailing fields clip at the right edge.
	 */
	primary?: "flex" | "fixed";
	/** Command shown on the overflow line. */
	hint?: string;
}

/**
 * Panel duration: `850ms`, `46s`, `3m 46s`, `1h 3m 46s`. Units are spaced because panel fields are
 * separated by column gaps; the footer and working row keep their compact unspaced form.
 */
export function formatPanelDuration(durationMs: number | null): string {
	if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "unknown";
	if (durationMs < 1_000) return `${Math.floor(durationMs)}ms`;
	const total = Math.floor(durationMs / 1_000);
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

const GAP = "  ";
const PRIMARY_MIN = 12;

function pad(text: string, width: number, align: "left" | "right"): string {
	const fill = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return align === "right" ? fill + text : text + fill;
}

export function panelRows(specs: readonly PanelRowSpec[], width: number, theme: PanelTheme, options: PanelRowsOptions): string[] {
	width = Math.max(0, Math.floor(width));
	const room = Math.max(0, Math.floor(options.maxRows));
	if (!width || !room) return [];
	const hidden = Math.max(0, options.hidden ?? 0);
	const overflow = specs.length + hidden > room;
	const hint = overflow && room >= 2;
	const shown = specs.slice(0, Math.max(0, room - (hint ? 1 : 0)));
	const columns: number[] = [];
	for (const spec of shown) (spec.fields ?? []).forEach((field, index) => { columns[index] = Math.max(columns[index] ?? 0, visibleWidth(field)); });
	const fieldsWidth = columns.reduce((sum, column) => sum + visibleWidth(GAP) + column, 0);
	const prefixWidth = visibleWidth("├─ ") + Math.max(1, ...shown.map(spec => visibleWidth(spec.glyph))) + 1;
	const longest = Math.max(0, ...shown.map(spec => visibleWidth(spec.primary)));
	const primaryWidth = options.primary === "fixed"
		? Math.min(longest, Math.max(1, width - prefixWidth))
		: Math.min(longest, Math.max(PRIMARY_MIN, width - prefixWidth - fieldsWidth));
	const rows = shown.map((spec, index) => {
		const branch = index === shown.length - 1 && !hint ? "└─ " : "├─ ";
		const clipped = truncateToWidth(spec.primary, primaryWidth, "…");
		const toned = theme.fg(spec.primaryTone, clipped);
		const primary = (spec.decorate ? spec.decorate(toned) : toned) + " ".repeat(Math.max(0, primaryWidth - visibleWidth(clipped)));
		const fields = columns.map((column, at) => pad(spec.fields?.[at] ?? "", column, options.align?.[at] ?? "left")).join(GAP);
		const line = theme.fg("dim", branch) + theme.fg(spec.glyphTone, spec.glyph) + " " + primary
			+ (fields.trim() ? theme.fg("muted", GAP + fields.replace(/\s+$/u, "")) : "");
		return truncateToWidth(line, width, "…");
	});
	if (hint) {
		const more = specs.length - shown.length + hidden;
		rows.push(truncateToWidth(theme.fg("dim", `└─ … ${more} more${options.hint ? ` · ${options.hint}` : ""}`), width, "…"));
	}
	return rows;
}
