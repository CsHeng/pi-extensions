/** Presentation-only above-editor composition. One native widget, fixed slot order, no business registry. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";

const COMPOSER_EVENT = "csheng.above-editor.composer";

export const ABOVE_EDITOR_WIDGET_KEY = "csheng-above-editor";
export const ABOVE_EDITOR_SLOTS = ["tasks", "jobs", "subagents"] as const;
export type AboveEditorSlot = (typeof ABOVE_EDITOR_SLOTS)[number];

export interface AboveEditorContribution {
	render(width: number, terminalRows: number, theme: unknown): string[];
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
	invalidate(): boolean;
	slots(): AboveEditorSlot[];
}

interface HeaderHit { slot: AboveEditorSlot; y: number }

function interactive(ctx: AboveEditorMount | undefined): ctx is AboveEditorMount {
	return !!ctx && ctx.mode === "tui" && ctx.hasUI;
}

export function createAboveEditor(): AboveEditorComposer {
	const slots = new Map<AboveEditorSlot, AboveEditorContribution>();
	let ctx: AboveEditorMount | undefined;
	let publishing = false;
	const publish = (): boolean => {
		if (publishing) return true;
		if (!interactive(ctx)) return true;
		publishing = true;
		const mount = ctx;
		try {
			mount.ui.setWidget(ABOVE_EDITOR_WIDGET_KEY, ABOVE_EDITOR_SLOTS.some(slot => slots.has(slot)) ? (tui: TUI, theme: unknown): Component => {
				let headers: HeaderHit[] = [];
				return {
					render(width: number) {
						const rows: string[] = [];
						const next: HeaderHit[] = [];
						const terminalRows = tui?.terminal?.rows || 36;
						for (const slot of ABOVE_EDITOR_SLOTS) {
							const contribution = slots.get(slot);
							if (!contribution) continue;
							let part: string[] = [];
							try { part = contribution.render(width, terminalRows, theme); }
							catch { part = []; }
							if (!part.length) continue;
							if (rows.length) rows.push("");
							next.push({ slot, y: rows.length });
							rows.push(...part);
						}
						headers = next;
						return rows.length ? [...rows, ""] : [];
					},
					handleMouse(event: TuiMouseEvent) {
						if (tui?.mode !== "fullscreen" || event.button !== "left") return undefined;
						if (event.type !== "press" && event.type !== "click") return undefined;
						const hit = headers.find(item => item.y === event.y);
						if (!hit) return undefined;
						if (event.type === "press") return { handled: true };
						try { slots.get(hit.slot)?.activate?.(); }
						catch { /* Presentation only. */ }
						return { handled: true };
					},
					invalidate() {},
				};
			} : undefined, { placement: "aboveEditor" });
			return true;
		} catch {
			try { mount.ui.setWidget(ABOVE_EDITOR_WIDGET_KEY, undefined); } catch { /* View only. */ }
			return false;
		} finally { publishing = false; }
	};
	return {
		attach(next) { ctx = next; publish(); },
		set(slot, contribution) {
			if (contribution) slots.set(slot, contribution);
			else slots.delete(slot);
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
