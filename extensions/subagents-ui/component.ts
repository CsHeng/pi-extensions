import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { SnapshotTaskV1, SnapshotV1 } from "../subagents/events.ts";
import { formatDuration } from "../subagents/render.ts";
import { formatStatus } from "./render.ts";

export type OverlayAction = { type: "close" } | { type: "cancel-run" } | { type: "cancel-task"; taskId: string };

export class SubagentsOverlay {
	focused = true;
	private selected = 0;
	private snapshot: SnapshotV1;
	private readonly tui: TUI;
	private readonly done: (action: OverlayAction) => void;
	constructor(snapshot: SnapshotV1, tui: TUI, done: (action: OverlayAction) => void) {
		this.snapshot = snapshot;
		this.tui = tui;
		this.done = done;
	}

	update(snapshot: SnapshotV1): void {
		this.snapshot = snapshot;
		if (this.selected >= snapshot.tasks.length) this.selected = Math.max(0, snapshot.tasks.length - 1);
		this.tui.requestRender();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ type: "close" });
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(this.snapshot.tasks.length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "R" || matchesKey(data, "shift+r")) {
			this.done({ type: "cancel-run" });
			return;
		}
		if (data === "x" || matchesKey(data, "x")) {
			const task = this.snapshot.tasks[this.selected];
			if (task) this.done({ type: "cancel-task", taskId: task.id });
		}
	}

	render(width: number): string[] {
		const lines = [formatStatus(this.snapshot), "↑↓ select  x cancel task  R cancel run  esc close"];
		this.snapshot.tasks.forEach((task, index) => {
			lines.push(this.taskLine(task, index === this.selected, width));
		});
		return lines;
	}

	private taskLine(task: SnapshotTaskV1, selected: boolean, width: number): string {
		const marker = selected ? ">" : " ";
		const line = `${marker} ${task.ordinal} ${task.role} ${task.status} ${task.executionPhase} t${task.assistantTurns} ${formatDuration(task.elapsedMs)}`;
		return line.length <= width ? line : line.slice(0, Math.max(0, width));
	}
}
