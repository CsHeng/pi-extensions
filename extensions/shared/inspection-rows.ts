import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PanelTheme, PanelTone } from "./panel-heading.ts";

/** A read-only presentation of one owned record. Keys survive reorder; labels need not be unique. */
export interface InspectionItem {
	key: string;
	glyph: string;
	tone: PanelTone;
	name: string;
	compactName?: string;
	/** A same-title discriminator stays visible when the readable title is shortened. */
	nameSuffix?: string;
	activity: string;
	meta?: string;
	tail: string;
	detail(): string[];
}

export interface InspectionFrame {
	lines: string[];
	/** Physical rows have keys only for actual items, never for headings or overflow hints. */
	keys: (string | undefined)[];
	items: string[];
}

const plain: PanelTheme = { fg: (_color, text) => text };
const clip = (text: string, room: number) => truncateToWidth(text, Math.max(0, room), "…");

/** Spend actual terminal cells on activity only after reserving the state glyph and important suffix. */
export function inspectionRow(item: InspectionItem, width: number, theme: PanelTheme = plain, selected = false, branch = ""): string {
	if (width < 1) return "";
	const glyph = theme.fg(item.tone, item.glyph);
	const marker = selected ? "› " : branch;
	const prefix = (visibleWidth(marker) + visibleWidth(item.glyph) + 4 <= width ? theme.fg(selected ? "accent" : "dim", marker) : "") + glyph;
	let room = Math.max(0, width - visibleWidth(prefix) - 1);
	const tail = clip(item.tail, room);
	const suffix = item.nameSuffix ?? "", suffixWidth = visibleWidth(suffix);
	const fullName = suffix ? item.name + " " + suffix : item.name;
	const nameWidth = visibleWidth(fullName), activityWidth = visibleWidth(item.activity);
	const minName = Math.min(nameWidth, suffix ? suffixWidth + 8 : item.compactName ? Math.min(20, visibleWidth(item.compactName)) : 12);
	const minAction = Math.min(8, activityWidth);
	const fieldGaps = Number(!!tail) + Number(!!nameWidth && !!activityWidth) + Number(!!item.meta);
	const needed = visibleWidth(tail) + minName + minAction + visibleWidth(item.meta ?? "");
	const sep = item.meta && needed + 3 * fieldGaps <= room ? " | " : " ";
	if (tail) room -= visibleWidth(tail) + sep.length;
	if (nameWidth && activityWidth) room -= sep.length;
	room = Math.max(0, room);
	const meta = item.meta && visibleWidth(item.meta) + sep.length + minName + minAction <= room ? item.meta : "";
	if (meta) room -= visibleWidth(meta) + sep.length;
	const nameBudget = Math.min(nameWidth, room, Math.max(suffixWidth, Math.min(room - minAction, Math.max(minName, room - activityWidth, Math.ceil(room / 2)))));
	const nameText = nameWidth > nameBudget && item.compactName && width < 64 ? item.compactName : item.name;
	const namePart = clip(nameText, nameBudget - (suffix ? suffixWidth + 1 : 0));
	const name = suffix ? (namePart ? namePart + " " : "") + clip(suffix, nameBudget) : namePart;
	const activity = clip(item.activity, room - visibleWidth(name));
	const fields = [name && theme.fg("text", name), meta && theme.fg("dim", meta), activity && theme.fg("muted", activity), tail && theme.fg(item.tone, tail)].filter(Boolean);
	return truncateToWidth(prefix + (fields.length ? " " + fields.join(theme.fg("dim", sep)) : ""), width);
}

/** One heading and a bounded identity-preserving window. The selected row may be beyond the first screenful. */
export function inspectionFrame(heading: string, items: readonly InspectionItem[], width: number, maxRows: number, theme: PanelTheme = plain,
	options: { selected?: string; hidden?: number; hint?: string } = {}): InspectionFrame {
	if (width < 1 || maxRows < 1) return { lines: [], keys: [], items: [] };
	const lines = [options.selected ? clip(heading + theme.fg("dim", " · ↑↓ select · Enter details · Esc chat"), width) : heading];
	const keys: (string | undefined)[] = [undefined];
	const space = maxRows - 1;
	const hidden = options.hidden ?? 0;
	const hint = space > 1 && items.length + hidden > space;
	const count = Math.min(items.length, space - Number(hint));
	const at = items.findIndex(item => item.key === options.selected);
	const start = Math.min(items.length - count, Math.max(0, at - count + 1));
	for (let i = start; i < start + count; i++) {
		const item = items[i]!;
		lines.push(inspectionRow(item, width, theme, i === at, i === start + count - 1 && !hint ? "└─ " : "├─ "));
		keys.push(item.key);
	}
	if (hint) {
		const more = start ? `${start + 1}–${start + count}/${items.length + hidden}` : `${items.length - count + hidden} more`;
		lines.push(clip(theme.fg("dim", `└─ … ${more}${options.hint ? ` · ${options.hint}` : ""}`), width));
		keys.push(undefined);
	}
	return { lines, keys, items: count ? items.map(item => item.key) : [] };
}

/** Scroll only this record's bounded, owner-provided detail; the containing view owns Enter/Escape and its lifetime. */
export class ItemDetailPage {
	private offset = 0;
	private pageSize = 1;
	private maxOffset = 0;

	handleInput(data: string): boolean {
		if (matchesKey(data, "up")) this.offset--;
		else if (matchesKey(data, "down")) this.offset++;
		else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
		else if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = this.maxOffset;
		else return false;
		this.offset = Math.max(0, Math.min(this.maxOffset, this.offset));
		return true;
	}

	render(title: string, item: InspectionItem | undefined, width: number, height: number, theme: { fg(color: "accent" | "dim", text: string): string } = plain): string[] {
		if (width < 1 || height < 1) return [];
		const body = (item?.detail() ?? ["Record unavailable"]).flatMap(line => line.split("\n").flatMap(part => wrapTextWithAnsi(part, width)));
		this.pageSize = Math.max(1, height - 2);
		this.maxOffset = Math.max(0, body.length - this.pageSize);
		this.offset = Math.min(this.maxOffset, this.offset);
		const position = this.maxOffset > 0 ? ` · ${this.offset + 1}–${Math.min(body.length, this.offset + this.pageSize)}/${body.length}` : "";
		return [clip(theme.fg("accent", title), width), ...body.slice(this.offset, this.offset + this.pageSize),
			clip(theme.fg("dim", `Esc back · ↑↓ scroll · PgUp/PgDn${position}`), width)].slice(0, height);
	}
}
