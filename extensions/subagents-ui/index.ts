import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import {
	CANCEL_RECEIPT_EVENT,
	CANCEL_REQUEST_EVENT,
	SNAPSHOT_EVENT,
	parseCancelReceipt,
	parseSnapshot,
	type CancelReceiptV1,
	type SnapshotV1,
} from "../subagents/events.ts";
import { SubagentsOverlay, type OverlayAction } from "./component.ts";
import {
	SUBAGENTS_UI_COMMAND,
	SUBAGENTS_UI_ENTRY_TYPE,
	SUBAGENTS_UI_PANEL_KEY,
	SUBAGENTS_UI_STATUS_KEY,
	entryFromSnapshot,
	formatEntry,
	formatPanel,
	formatReceipt,
	formatStatus,
	type SubagentsRunEntryData,
} from "./render.ts";

export {
	SUBAGENTS_UI_COMMAND,
	SUBAGENTS_UI_ENTRY_TYPE,
	SUBAGENTS_UI_PANEL_KEY,
	SUBAGENTS_UI_STATUS_KEY,
};

function createSubagentsUiExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		let ctx: ExtensionContext | undefined;
		let snapshot: SnapshotV1 | undefined;
		let receipt: CancelReceiptV1 | undefined;
		let overlay: SubagentsOverlay | undefined;
		let lastFinalRun: string | undefined;

		const tui = () => ctx?.mode === "tui";

		const clearUi = () => {
			overlay = undefined;
			if (!tui() || !ctx) return;
			ctx.ui.setStatus(SUBAGENTS_UI_STATUS_KEY, undefined);
			ctx.ui.setWidget(SUBAGENTS_UI_PANEL_KEY, undefined);
		};

		const renderLive = () => {
			if (!tui() || !ctx || !snapshot || snapshot.phase === "settled") {
				clearUi();
				return;
			}
			ctx.ui.setStatus(SUBAGENTS_UI_STATUS_KEY, formatStatus(snapshot));
			ctx.ui.setWidget(SUBAGENTS_UI_PANEL_KEY, formatPanel(snapshot), { placement: "belowEditor" });
			overlay?.update(snapshot);
		};

		const requestCancel = async (action: OverlayAction) => {
			if (!tui() || !ctx || !snapshot || action.type === "close") return;
			const taskId = action.type === "cancel-task" ? action.taskId : undefined;
			const confirmed = await ctx.ui.confirm(
				"Cancel subagent work",
				action.type === "cancel-run" ? "Cancel the current subagent run?" : `Cancel task ${taskId}?`,
			);
			if (!confirmed || !snapshot) return;
			pi.events.emit(CANCEL_REQUEST_EVENT, {
				version: 1,
				requestId: randomUUID(),
				runId: snapshot.runId,
				target: action.type === "cancel-run" ? "run" : "task",
				...(taskId === undefined ? {} : { taskId }),
			});
		};

		const openOverlay = async () => {
			if (!tui() || !ctx || !snapshot || snapshot.phase === "settled") {
				ctx?.ui.notify("No active subagent run.", "info");
				return;
			}
			const current = snapshot;
			await ctx.ui.custom<OverlayAction | null>(
				(tuiInstance, _theme, _kb, done) => {
					overlay = new SubagentsOverlay(current, tuiInstance, done);
					return overlay;
				},
				{ overlay: true, onHandle: (handle) => { handle.focus(); } },
			).then(async (action) => {
				overlay = undefined;
				if (action) await requestCancel(action);
			});
		};

		pi.events.on(SNAPSHOT_EVENT, (data) => {
			const parsed = parseSnapshot(data);
			if (!parsed.ok) return;
			if (snapshot && parsed.value.runId !== snapshot.runId && snapshot.phase !== "settled") return;
			snapshot = parsed.value;
			if (snapshot.phase === "settled") {
				if (tui() && lastFinalRun !== snapshot.runId) {
					lastFinalRun = snapshot.runId;
					pi.appendEntry<SubagentsRunEntryData>(SUBAGENTS_UI_ENTRY_TYPE, entryFromSnapshot(snapshot));
				}
				clearUi();
				return;
			}
			renderLive();
		});

		pi.events.on(CANCEL_RECEIPT_EVENT, (data) => {
			const parsed = parseCancelReceipt(data);
			if (!parsed.ok) return;
			receipt = parsed.value;
			if (tui()) ctx?.ui.notify(formatReceipt(receipt), "info");
		});

		pi.registerCommand(SUBAGENTS_UI_COMMAND, {
			description: "Inspect the current subagent run",
			handler: async (_args, commandCtx) => {
				ctx = commandCtx;
				await openOverlay();
			},
		});

		pi.registerShortcut(Key.ctrlAlt("f"), {
			description: "Inspect the current subagent run",
			handler: async (shortcutCtx) => {
				ctx = shortcutCtx;
				await openOverlay();
			},
		});

		pi.registerEntryRenderer<SubagentsRunEntryData>(SUBAGENTS_UI_ENTRY_TYPE, (entry, { expanded }, theme) => {
			const data = entry.data;
			if (!data || data.version !== 1) return new Text(theme.fg("muted", "Subagents run"), 1, 0);
			return new Text(theme.fg("muted", formatEntry(data, expanded)), 1, 0);
		});

		pi.on("session_start", (_event, sessionCtx) => {
			ctx = sessionCtx;
			if (!tui()) clearUi();
		});

		pi.on("session_shutdown", () => {
			clearUi();
			snapshot = undefined;
			receipt = undefined;
			ctx = undefined;
			lastFinalRun = undefined;
		});
	};
}

export default createSubagentsUiExtension();
export { createSubagentsUiExtension };
