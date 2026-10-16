import assert from "node:assert/strict";
import type { ExtensionContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Exercise the actual list component while replacing only the host modal lifetime. */
export function captureListOverlay(capture: (lines: string[]) => void): ExtensionContext["ui"]["custom"] {
	return async (factory, options) => {
		assert.equal(options?.overlay, true);
		const layout = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
		assert.equal(layout?.anchor, "center");
		const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~${text}~` } as Theme;
		const component = await factory({ terminal: { rows: 120, columns: 160 }, requestRender() {} } as TUI, theme, {} as KeybindingsManager, () => {});
		capture(component.render(160));
		return undefined as never;
	};
}
