import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowStore } from "./store.ts";
import { renderWorkflowWidget, workflowDetailRows, type WorkflowUiSnapshot } from "./ui-render.ts";

export const WORKFLOW_WIDGET_KEY = "csheng.workflow.tasks";
export const WORKFLOW_UI_COMMAND = "workflow-ui";
const UI_FAILURE = "Workflow task view disabled after a UI error. The committed ledger is unchanged; use /reload to restore the view.";

/** One viewport over the current ledger; scrolling never changes workflow state. */
export class WorkflowTaskList {
	private offset = 0;
	private pageSize = 1;
	private worksetId: string | undefined;
	private readonly snapshot: () => WorkflowUiSnapshot;
	private readonly tui: TUI;
	private readonly theme: () => Theme;
	private readonly done: () => void;
	constructor(
		snapshot: () => WorkflowUiSnapshot,
		tui: TUI,
		theme: () => Theme,
		done: () => void,
	) {
		this.snapshot = snapshot; this.tui = tui; this.theme = theme; this.done = done;
	}
	invalidate(): void {}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) { this.done(); return; }
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
		else if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
		else return;
		this.tui.requestRender();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const theme = this.theme();
		const rows = Math.max(1, Math.floor((this.tui.terminal.rows || 24) * 0.8));
		const snapshot = this.snapshot();
		if (snapshot.state?.workset.id !== this.worksetId) { this.worksetId = snapshot.state?.workset.id; this.offset = 0; }
		const content = workflowDetailRows(snapshot, theme, Math.max(1, width - 2));
		this.pageSize = Math.max(1, rows - 2);
		this.offset = Math.min(this.offset, Math.max(0, content.length - this.pageSize));
		const lines = [theme.fg("accent", "Tasks · workflow"), ...content.slice(this.offset, this.offset + this.pageSize),
			theme.fg("dim", `↑↓ PgUp/PgDn scroll · Esc close · ${this.offset + 1}-${Math.min(this.offset + this.pageSize, content.length)}/${content.length}`)];
		return lines.slice(0, rows).map((line) => {
			const text = truncateToWidth(` ${line}`, width, "…");
			return theme.bg("selectedBg", text + " ".repeat(Math.max(0, width - visibleWidth(text))));
		});
	}
}

/** Lifecycle methods are called around the core's branch replay/reconciliation, in that order. */
export function registerWorkflowUi(pi: ExtensionAPI, store: WorkflowStore): {
	detach(): void;
	attach(ctx: ExtensionContext): void;
} {
	let ctx: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let widgetTui: TUI | undefined;
	let listTui: TUI | undefined;
	let dismissList: (() => void) | undefined;
	let listOpen = false;
	let registered = false;
	let hidden = false;
	let collapsed = false;
	let disabled = false;
	let worksetId: string | undefined;
	let generation = 0;
	const snapshot = (): WorkflowUiSnapshot => ({ state: store.current(), recovery: store.recovery() });

	const clearWidget = (): void => {
		if (!registered) return;
		registered = false;
		widgetTui = undefined;
		ctx?.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
	};
	const fail = (): void => {
		if (disabled) return;
		disabled = true;
		unsubscribe?.(); unsubscribe = undefined;
		try { clearWidget(); } catch { /* The host UI may already have been disposed. */ }
		try { dismissList?.(); } catch { /* A replaced custom view no longer has a live handle. */ }
		listOpen = false; dismissList = undefined; listTui = undefined;
		try { ctx?.ui.notify(UI_FAILURE, "error"); } catch { /* No live UI remains to report to. */ }
	};
	const safely = (action: () => void): void => { try { action(); } catch { fail(); } };
	const refresh = (): void => {
		if (!ctx || disabled) return;
		const id = store.current()?.workset.id;
		if (id !== worksetId) { worksetId = id; collapsed = false; }
		listTui?.requestRender();
		if (hidden || (!store.current() && !store.recovery())) { clearWidget(); return; }
		if (registered) { widgetTui?.requestRender(); return; }
		const version = generation;
		registered = true;
		ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, (tui) => {
			if (version !== generation || disabled) return { render: () => [], invalidate() {} };
			widgetTui = tui;
			return {
				invalidate() {},
				render(width) {
					if (version !== generation || !ctx || disabled || hidden) return [];
					try {
						return renderWorkflowWidget(snapshot(), ctx.ui.theme, { width, rows: tui.terminal.rows || 24, collapsed });
					} catch { fail(); return []; }
				},
			};
		}, { placement: "aboveEditor" });
	};
	const detach = (): void => {
		generation += 1;
		unsubscribe?.(); unsubscribe = undefined;
		// Core replay must not refresh a component still bound to the previous owner.
		try { clearWidget(); } catch { /* Session replacement may invalidate the old UI proxy first. */ }
		try { dismissList?.(); } catch { /* The host may already have removed the overlay. */ }
		ctx = undefined; widgetTui = undefined; listTui = undefined; dismissList = undefined;
		listOpen = false; hidden = false; collapsed = false; disabled = false; worksetId = undefined;
	};
	const openList = async (): Promise<void> => {
		if (!ctx || disabled || listOpen) return;
		const owner = ctx;
		const version = generation;
		listOpen = true;
		try {
			await owner.ui.custom<void>((tui, _theme, _keys, done) => {
				if (version !== generation || disabled) { done(); return { render: () => [], invalidate() {} }; }
				listTui = tui; dismissList = () => done();
				const list = new WorkflowTaskList(snapshot, tui, () => owner.ui.theme, dismissList);
				return {
					invalidate() { list.invalidate(); },
					handleInput(data: string) { if (version === generation && !disabled) safely(() => list.handleInput(data)); },
					render(width: number) {
						if (version !== generation || disabled) return [];
						try { return list.render(width); } catch { fail(); return []; }
					},
				};
			}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 } });
		} catch {
			if (version === generation) fail();
		} finally {
			if (version === generation) { listOpen = false; listTui = undefined; dismissList = undefined; }
		}
	};
	pi.registerCommand(WORKFLOW_UI_COMMAND, {
		description: "Workflow task view: toggle, show, hide, or list (read-only)",
		handler: async (args, commandContext) => {
			if (commandContext.mode !== "tui" || !ctx) return;
			if (disabled) { try { ctx.ui.notify(UI_FAILURE, "error"); } catch {} return; }
			switch (args.trim()) {
				case "": collapsed = !collapsed; break;
				case "hide": hidden = true; break;
				case "show": hidden = false; break;
				case "list": await openList(); return;
				default: safely(() => ctx?.ui.notify("Usage: /workflow-ui [show|hide|list]", "info")); return;
			}
			safely(refresh);
		},
	});
	pi.on("session_shutdown", detach);
	return {
		detach,
		attach(context) {
			if (context.mode !== "tui") return;
			ctx = context;
			unsubscribe = store.subscribe(refresh, fail);
			safely(refresh);
		},
	};
}
