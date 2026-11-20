import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createAboveEditor, type AboveEditorContribution, type AboveEditorMount } from "../extensions/shared/above-editor.ts";
import { inspectionFrame, inspectionRow, ItemDetailPage, type InspectionItem } from "../extensions/shared/inspection-rows.ts";

const item = (key: string): InspectionItem => ({ key, glyph: "◐", tone: "accent", name: key, activity: "核对接口".repeat(32),
	meta: "optional model", tail: "exit 7", detail: () => Array.from({ length: 8 }, (_, i) => `result ${i}`) });

test("a job or agent spends the real pane width on activity, preserving its critical suffix and terminal-cell bound", () => {
	const record = item("worker");
	const theme = { fg: (_tone: string, s: string) => `\x1b[32m${s}\x1b[0m` };
	for (const width of [1, 4, 16, 40, 80, 180]) {
		const row = inspectionRow(record, width, theme, true);
		assert.ok(visibleWidth(row) <= width);
		if (width >= 16) assert.match(row, /exit 7/);
		if (width === 40) assert.match(row, /核对/);
		if (width === 180) assert.ok(visibleWidth(row) > 175, "does not clip at 120 or split a wide cell");
	}
	const frame = inspectionFrame("Agents", Array.from("abcde", item), 60, 4, undefined, { selected: "e" });
	assert.deepEqual(frame.keys, [undefined, "d", "e", undefined]);
	assert.match(frame.lines[2]!, /› ◐ e/);
});

test("same-title discriminators survive title clipping without taking space from other rows", () => {
	const common = { ...item("A"), name: "Reviewer: " + "长标题".repeat(18), activity: "read · current file", tail: "12s" };
	for (const width of [40, 80, 160]) {
		const first = inspectionRow({ ...common, nameSuffix: "[abcdef011111]" }, width);
		const second = inspectionRow({ ...common, nameSuffix: "[abcdef012222]" }, width);
		assert.ok(first.includes("[abcdef011111]") && second.includes("[abcdef012222]"));
		assert.ok(visibleWidth(first) <= width && first.includes("12s"));
		assert.ok(!inspectionRow(common, width).includes("[abcdef"));
	}
});

test("detail scroll follows available rows, with explicit unavailable evidence on revocation", () => {
	const view = new ItemDetailPage();
	const draw = () => view.render("Job", item("a"), 25, 5);
	assert.match(draw().join("\n"), /result 0/);
	assert.ok(view.handleInput("\x1b[6~"));
	assert.match(draw().join("\n"), /result 3/);
	assert.ok(view.handleInput("\x1b[F"));
	assert.match(draw().join("\n"), /result 7/);
	assert.match(view.render("Job", undefined, 40, 5).join("\n"), /unavailable/);
});

test("inline selection belongs to a stable record, and only explicit input takes focus from the editor", async () => {
	const composer = createAboveEditor();
	const editor: Component = { render: () => [], invalidate() {} };
	let focused: Component | null = editor;
	const tui = { mode: "fullscreen", terminal: { rows: 24, columns: 80 }, requestRender() {}, getFocusedComponent: () => focused,
		setFocus: (value: Component | null) => { focused = value; }, hasOverlay: () => false } as unknown as TUI;
	let widget!: Component;
	composer.attach({ mode: "tui", hasUI: true, ui: { setWidget: (_key, factory) => {
		if (typeof factory === "function") widget = factory(tui, {} as never);
	} } } as AboveEditorMount);
	let order = ["a", "b", "c", "d"], openKey = "", finished!: () => void;
	const contribution: AboveEditorContribution = {
		render: (width, _rows, _theme, selected) => inspectionFrame("Jobs", order.map(item), width, 4, undefined, selected ? { selected } : {}),
		openItem: key => { openKey = key; return new Promise<void>(resolve => { finished = resolve; }); },
	};
	composer.set("jobs", contribution);
	widget.render(80);
	assert.equal(focused, editor);
	assert.ok(composer.focus("jobs"));
	widget.handleInput!("\x1b[B");
	order = ["c", "a", "d", "b"];
	composer.set("jobs", contribution);
	assert.match(widget.render(80).join("\n"), /› ◐ b/);
	widget.handleInput!("\r");
	assert.equal(openKey, "b");
	assert.equal(focused, editor, "the host overlay saves the editor as its fallback");
	finished(); await Promise.resolve();
	assert.equal(focused, widget);
	widget.handleInput!("\x1b");
	assert.equal(focused, editor);
	widget.render(80);
	const click = (type: "press" | "click") => widget.handleMouse!({ type, button: "left", y: 1, x: 3 } as TuiMouseEvent);
	click("press"); order.reverse(); widget.render(80); click("click");
	assert.equal(focused, editor, "a row moving under a pending click is not the chosen record");
	click("press"); click("click");
	assert.equal(focused, widget);
	widget.handleInput!("\r");
	composer.set("jobs", undefined); finished(); await Promise.resolve();
	assert.equal(focused, editor, "an old detail cannot reclaim focus after its section is removed");
});
