import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { InspectionFrame } from "./inspection-rows.ts";

const COMPOSER_EVENT = "above-editor.composer";

export const ABOVE_EDITOR_WIDGET_KEY = "above-editor";
export const ABOVE_EDITOR_SLOTS = ["tasks", "jobs", "agents"] as const;
export type AboveEditorSlot = (typeof ABOVE_EDITOR_SLOTS)[number];

export interface AboveEditorContribution {
	render(width: number, terminalRows: number, theme: unknown, selected?: string): string[] | InspectionFrame;
	openItem?(key: string): void | Promise<void>;
	/** Fullscreen header click. Must not take editor focus or mutate business state. */
	activate?(): void;
}

export interface AboveEditorMount {
	mode: string;
	hasUI: boolean;
	ui: {
		setWidget: ExtensionContext["ui"]["setWidget"];
	};
}

export interface AboveEditorComposer {
	attach(ctx: AboveEditorMount): void;
	set(slot: AboveEditorSlot, contribution: AboveEditorContribution | undefined): boolean;
	/** Explicit keyboard entry after the owner has shown and unfolded its section. */
	focus(slot: AboveEditorSlot): boolean;
	invalidate(): boolean;
	slots(): AboveEditorSlot[];
}

interface RowHit { slot: AboveEditorSlot; key?: string }

/** Both Pi screen implementations expose their focus owner. Only take focus when we can return it. */
function canRestoreFocus(tui: TUI | undefined): tui is TUI & { getFocusedComponent(): Component | null } {
	return !!tui && "getFocusedComponent" in tui && typeof tui.getFocusedComponent === "function";
}

function interactive(ctx: AboveEditorMount | undefined): ctx is AboveEditorMount {
	return !!ctx && ctx.mode === "tui" && ctx.hasUI;
}

export function createAboveEditor(): AboveEditorComposer {
	const slots = new Map<AboveEditorSlot, AboveEditorContribution>();
	let ctx: AboveEditorMount | undefined;
	let widget: Component | undefined;
	let host: TUI | undefined;
	let selected: { slot: AboveEditorSlot; key: string } | undefined;
	let inspecting: typeof selected;
	let previous: Component | null = null;
	const items = new Map<AboveEditorSlot, readonly string[]>();
	const release = () => {
		selected = undefined;
		if (widget && canRestoreFocus(host) && host.getFocusedComponent() === widget) host.setFocus(previous);
		host?.requestRender?.();
	};
	const focus = (slot: AboveEditorSlot, key?: string) => {
		if (!canRestoreFocus(host) || !widget || host.hasOverlay?.()) return false;
		// A slash command may unfold the section before the next physical paint.
		if (key === undefined) widget.render(host.terminal.columns);
		const choices = items.get(slot);
		key ??= choices?.[0];
		if (!key || !choices?.includes(key)) return false;
		if (host.getFocusedComponent() !== widget) previous = host.getFocusedComponent();
		selected = { slot, key };
		host.setFocus(widget);
		host.requestRender();
		return true;
	};
	const createWidget = (tui: TUI, theme: unknown): Component => {
		host = tui;
		let hits = new Map<number, RowHit>();
		let pressed: RowHit | undefined;
		const component: Component = {
			capturesViewportInput: true,
			render(width) {
				const rows: string[] = [];
				if (selected && selected !== inspecting && canRestoreFocus(tui) && tui.getFocusedComponent() !== component && !tui.hasOverlay?.()) selected = undefined;
				hits = new Map(); items.clear();
				for (const slot of ABOVE_EDITOR_SLOTS) {
					const contribution = slots.get(slot);
					if (!contribution) continue;
					let frame: string[] | InspectionFrame;
					try { frame = contribution.render(width, tui.terminal?.rows || 36, theme, selected?.slot === slot ? selected.key : undefined); }
					catch { continue; }
					const part = Array.isArray(frame) ? frame : frame.lines;
					if (!part.length) continue;
					if (rows.length) rows.push("");
					hits.set(rows.length, { slot });
					if (!Array.isArray(frame)) {
						items.set(slot, frame.items);
						frame.keys.forEach((key, index) => { if (key) hits.set(rows.length + index, { slot, key }); });
					}
					rows.push(...part);
				}
				if (selected && !items.get(selected.slot)?.includes(selected.key)) release();
				return rows.length ? [...rows, ""] : [];
			},
			handleMouse(event: TuiMouseEvent) {
				if (tui.mode !== "fullscreen" || event.button !== "left" || (event.type !== "press" && event.type !== "click")) return;
				const hit = hits.get(event.y);
				if (event.type === "press") { pressed = hit; return hit ? { handled: true } : undefined; }
				const down = pressed; pressed = undefined;
				if (!hit || (down && (down.slot !== hit.slot || down.key !== hit.key))) return;
				if (hit.key) focus(hit.slot, hit.key);
				else { if (selected?.slot === hit.slot) release(); slots.get(hit.slot)?.activate?.(); }
				return { handled: true };
			},
			handleInput(data) {
				if (!selected) { release(); return; }
				const { slot, key } = selected;
				const keys = items.get(slot) ?? [];
				const index = keys.indexOf(key);
				if (matchesKey(data, "escape") || index < 0) { release(); return; }
				if (matchesKey(data, "enter")) {
					const origin = selected, editor = previous;
					inspecting = origin;
					// Give Pi a durable fallback while the overlay is open: this widget or record may disappear.
					tui.setFocus(editor);
					const restore = () => {
						if (inspecting === origin) inspecting = undefined;
						if (widget === component && selected === origin && canRestoreFocus(tui) && tui.getFocusedComponent() === editor) focus(slot, key);
					};
					try { void Promise.resolve(slots.get(slot)?.openItem?.(key)).then(restore, restore); } catch { restore(); }
					return;
				}
				const step = matchesKey(data, "down") ? 1 : matchesKey(data, "up") ? -1 : 0;
				if (step) { selected.key = keys[Math.max(0, Math.min(keys.length - 1, index + step))]!; tui.requestRender(); return; }
				const editor = previous; release(); editor?.handleInput?.(data);
			},
			invalidate() {},
		};
		widget = component;
		return component;
	};
	const publish = (): boolean => {
		if (!interactive(ctx)) return true;
		try {
			if (!slots.size) {
				release(); widget = undefined; host = undefined; items.clear();
				ctx.ui.setWidget(ABOVE_EDITOR_WIDGET_KEY, undefined);
			} else if (widget && host?.requestRender) {
				// Keep the physical focus target stable while the execution owners publish updates.
				host.requestRender();
			} else ctx.ui.setWidget(ABOVE_EDITOR_WIDGET_KEY, createWidget, { placement: "aboveEditor" });
			return true;
		} catch {
			release(); widget = undefined; host = undefined;
			try { ctx.ui.setWidget(ABOVE_EDITOR_WIDGET_KEY, undefined); } catch {  }
			return false;
		}
	};
	return {
		attach(next) { ctx = next; },
		focus,
		set(slot, contribution) {
			if (contribution) slots.set(slot, contribution);
			else { if (selected?.slot === slot) release(); slots.delete(slot); }
			return publish();
		},
		invalidate: publish,
		slots() { return ABOVE_EDITOR_SLOTS.filter(slot => slots.has(slot)); },
	};
}

/**
 * One composer for co-loaded presentation extensions.
 * Pi gives each extension a different events facade and does not share module
 * instances, so the lease is resolved on the public bus rather than a module singleton.
 */
export function sharedAboveEditor(pi: ExtensionAPI): AboveEditorComposer {
	let shared: AboveEditorComposer | undefined;
	pi.events.emit(COMPOSER_EVENT, { accept: (composer: AboveEditorComposer) => { shared = composer; } });
	const composer = shared ?? createAboveEditor();
	if (!shared) {
		pi.events.on(COMPOSER_EVENT, (request: unknown) => {
			const accept = (request as { accept?: (composer: AboveEditorComposer) => void })?.accept;
			if (typeof accept === "function") accept(composer);
		});
	}
	return composer;
}
