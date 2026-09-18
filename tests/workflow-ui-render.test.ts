import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskDisposition, WorkflowOperation, WorksetState } from "../extensions/workflow/contracts.ts";
import { applyOperation } from "../extensions/workflow/reducer.ts";
import { renderWorkflowWidget, workflowDetailRows, type WorkflowUiTheme } from "../extensions/workflow/ui-render.ts";

const theme: WorkflowUiTheme = { fg: (_color, text) => text, strikethrough: (text) => text };
const dimensions = { width: 150, rows: 40, collapsed: false };
const context = { now: "2026-09-17T00:00:00.000Z", cwd: "/repo", sessionId: "render-test" };

function apply(state: WorksetState | undefined, operation: WorkflowOperation): WorksetState {
	const result = applyOperation(state, operation, context);
	if (!result.ok) throw new Error(result.message);
	return result.state;
}

function opened(count = 5): WorksetState {
	return apply(undefined, {
		operation: "open", expectedRevision: 0, goal: "验证工作流 👩‍💻", deliveryEndpoint: "Reviewed source",
		criteria: [{ key: "works", outcome: "Works", verification: "Tests" }],
		tasks: Array.from({ length: count }, (_, index) => ({ key: `task-${index}`, outcome: `Task outcome ${index + 1}`, covers: ["works"] })),
	});
}

function accept(state: WorksetState, id: string): WorksetState {
	const next = apply(state, {
		operation: "record", expectedRevision: state.revision,
		evidence: { provenance: "agent_declared", subject: { kind: "task", id }, fingerprint: "fixture-basis", fingerprintState: "current", checkIdentity: "fixture", result: "pass" },
	});
	return apply(next, { operation: "assess", expectedRevision: next.revision, subject: { kind: "task", id }, verdict: "accepted", evidenceIds: [Object.keys(next.evidence).at(-1)!], rationale: "Fixture evidence accepted" });
}

const snapshot = (state: WorksetState) => ({ state, recovery: undefined });

test("workflow widget shows all active dispositions and moves cancelled/superseded into full-view history", () => {
	let state = accept(opened(8), "T-4");
	const states: TaskDisposition[] = ["pending", "running", "awaiting_acceptance", "accepted", "blocked", "paused", "cancelled", "superseded"];
	Object.values(state.tasks).forEach((task, index) => { task.disposition = states[index]!; });
	state.tasks["T-5"]!.reason = "Package absent";
	state.tasks["T-5"]!.blockClass = "missing_capability";
	state.tasks["T-5"]!.nextUnblockCondition = "Package installed";
	state.tasks["T-1"]!.dependsOn = ["T-2", "T-4"];
	const rows = renderWorkflowWidget(snapshot(state), theme, dimensions);
	const text = rows.join("\n");
	assert.match(text, /1\/6 accepted/);
	assert.match(text, /○ T-1 .*waits for T-2$/m);
	assert.match(text, /◐ T-2/);
	assert.match(text, /◇ T-3 .*awaiting acceptance/);
	assert.match(text, /✓ T-4/);
	assert.match(text, /! T-5 .*blocked: Package absent/);
	assert.match(text, /Ⅱ T-6 .*paused/);
	assert.doesNotMatch(text, /T-[78]/);
	assert.equal(rows.at(-1), "");
	assert.deepEqual(rows.slice(1, -1).map((row) => row.match(/T-\d+/)?.[0]), ["T-1", "T-2", "T-3", "T-4", "T-5", "T-6"]);
	const full = workflowDetailRows(snapshot(state), theme, 150).join("\n");
	assert.match(full, /History · cancelled \/ superseded\n× T-7 .*cancelled\n↪ T-8 .*superseded/);
	assert.match(full, /Depends on: T-2, T-4/);
	assert.match(full, /Block: missing_capability/);
	assert.match(full, /Unblocks when: Package installed/);
});

test("workflow widget counts reducer-current acceptance and exposes invalidation without mutating the ledger", () => {
	const state = accept(opened(2), "T-1");
	state.tasks["T-2"]!.dependsOn = ["T-1"];
	Object.values(state.evidence)[0]!.freshness = "stale";
	const before = structuredClone(state);
	const text = renderWorkflowWidget(snapshot(state), theme, dimensions).join("\n");
	assert.match(text, /0\/2 accepted/);
	assert.match(text, /◇ T-1 .*acceptance not current/);
	assert.match(text, /T-2 .*waits for T-1/);
	workflowDetailRows(snapshot(state), theme, 50);
	assert.deepEqual(state, before);
});

test("accepted task count never claims workset completion and exposes all remaining deficit classes", () => {
	const state = accept(opened(1), "T-1");
	state.workset.alignment.state = "needs_alignment";
	state.attempts["ATT-1"] = {
		id: "ATT-1", worksetId: state.workset.id, taskId: "T-1", taskRevision: 1,
		basis: { scope: [], fingerprint: "missing", fingerprintState: "unavailable" },
		transport: "local", state: "unknown", startedAt: context.now,
	};
	const text = renderWorkflowWidget(snapshot(state), theme, { ...dimensions, width: 220 }).join("\n");
	assert.match(text, /1\/1 accepted.*needs_alignment/);
	assert.match(text, /Remaining: .*criteria not accepted.*unresolved attempts.*delivery evidence missing/);
	assert.doesNotMatch(text, /completed/);
	assert.match(workflowDetailRows(snapshot(state), theme, 120).join("\n"), /ATT-1 · unknown/);
	state.workset.disposition = "paused";
	assert.match(renderWorkflowWidget(snapshot(state), theme, dimensions)[0]!, /paused · needs_alignment/);
});

test("overflow prioritizes unfinished work stably with global counts and actual omitted dispositions", () => {
	let state = opened(14);
	for (let index = 1; index <= 5; index++) state = accept(state, `T-${index}`);
	state.tasks["T-6"]!.disposition = "paused";
	state.tasks["T-12"]!.disposition = "blocked";
	state.tasks["T-13"]!.disposition = "awaiting_acceptance";
	state.tasks["T-14"]!.disposition = "running";
	const rows = renderWorkflowWidget(snapshot(state), theme, { ...dimensions, rows: 21 });
	assert.equal(rows.length, 8);
	assert.match(rows[0]!, /5\/14 accepted/);
	assert.deepEqual(rows.slice(1, -2).map((row) => row.match(/T-\d+/)?.[0]), ["T-12", "T-13", "T-14", "T-6", "T-7"]);
	assert.match(rows.at(-2)!, /4 pending, 5 accepted hidden/);
	assert.ok(renderWorkflowWidget(snapshot(state), theme, dimensions).length <= 13);
});

test("widget bounds narrow and short terminals and sanitizes untrusted strings before theming", () => {
	const state = opened(3);
	state.workset.goal = "中文 👩‍💻 \x1b]0;title\x07goal\nnew\rline";
	state.tasks["T-1"]!.outcome = "任务\x1b[2J🚀\t\x00多行\u2028测试\u202eabc";
	state.tasks["T-2"]!.disposition = "blocked";
	state.tasks["T-2"]!.reason = "\x1b[31mstop\x1b[0m\nreason";
	const inspect = (text: string) => {
		assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/u);
		return text;
	};
	const cleanTheme: WorkflowUiTheme = { fg: (_color, text) => inspect(text), strikethrough: inspect };
	for (const width of [1, 2, 6, 15, 31, 80]) {
		for (const height of [1, 3, 9, 40]) {
			const rows = renderWorkflowWidget(snapshot(state), cleanTheme, { width, rows: height, collapsed: false });
			assert.ok(rows.length <= Math.min(12, Math.max(1, Math.floor(height / 3))) + 1);
			for (const row of rows) assert.ok(visibleWidth(row) <= width, row);
		}
		for (const row of workflowDetailRows(snapshot(state), cleanTheme, width)) assert.ok(visibleWidth(row) <= width, row);
	}
	assert.deepEqual(renderWorkflowWidget(snapshot(state), theme, { ...dimensions, width: 0 }), []);
});

test("no workset stays absent, recovery never shows stale tasks, and compact/closed views remain truthful", () => {
	assert.deepEqual(renderWorkflowWidget({ state: undefined, recovery: undefined }, theme, dimensions), []);
	assert.match(workflowDetailRows({ state: undefined, recovery: undefined }, theme, 80).join("\n"), /No workflow workset/);
	const state = opened();
	const recovery = { state, recovery: "Invalid snapshot\n\x1b[2J" };
	const warning = renderWorkflowWidget(recovery, theme, dimensions).join("\n");
	assert.match(warning, /state unavailable/);
	assert.doesNotMatch(warning, /T-1/);
	assert.match(workflowDetailRows(recovery, theme, 80).join("\n"), /Invalid snapshot/);
	const compact = renderWorkflowWidget(snapshot(state), theme, { ...dimensions, collapsed: true });
	assert.equal(compact.length, 3);
	assert.match(compact[1]!, /expand/);
	for (const closeOutcome of ["completed", "cancelled", "superseded"] as const) {
		state.workset.disposition = "closed";
		state.workset.closeOutcome = closeOutcome;
		const rows = renderWorkflowWidget(snapshot(state), theme, dimensions);
		assert.equal(rows.length, 2);
		assert.ok(rows[0]!.endsWith(closeOutcome));
		assert.match(rows[0]!, /0\/5 accepted/);
	}
});

test("widget caps rows at 120 columns on wide terminals and preserves glyph and status through middle truncation", () => {
	const state = opened(3);
	state.workset.goal = "Improve the workflow trigger affordance across description, guidelines, and every visible task surface".repeat(3);
	state.tasks["T-1"]!.outcome = "extensions/workflow/tool.ts registerTool description promptSnippet promptGuidelines rewritten with action-first copy".repeat(2);
	state.tasks["T-1"]!.disposition = "awaiting_acceptance";
	state.tasks["T-2"]!.dependsOn = ["T-1"];
	state.tasks["T-3"]!.disposition = "blocked";
	state.tasks["T-3"]!.reason = "x".repeat(120);
	for (const width of [40, 80, 120, 150, 220]) {
		const rows = renderWorkflowWidget(snapshot(state), theme, { width, rows: 40, collapsed: false });
		for (const row of rows) assert.ok(visibleWidth(row) <= Math.min(width, 120), `width ${width}: ${row}`);
	}
	const text = stripTerminalSequences(renderWorkflowWidget(snapshot(state), theme, { width: 220, rows: 40, collapsed: false }).join("\n"));
	assert.match(text, /● Tasks .*… \(0\/3 accepted\)/m);
	assert.match(text, /◇ T-1 .*… · awaiting acceptance$/m);
	assert.match(text, /○ T-2 .*· waits for T-1$/m);
	assert.match(text, /! T-3 .*· blocked: x+…$/m);
	assert.doesNotMatch(text, /action-first copy/);
});

test("task titles render in place of outcomes while the detail view keeps the full outcome", () => {
	const state = opened(2);
	state.tasks["T-1"]!.title = "Rewrite trigger copy";
	state.tasks["T-1"]!.outcome = "Rewrite the registerTool description and promptGuidelines in extensions/workflow/tool.ts";
	state.tasks["T-2"]!.disposition = "awaiting_acceptance";
	const text = renderWorkflowWidget(snapshot(state), theme, dimensions).join("\n");
	assert.match(text, /○ T-1 Rewrite trigger copy/);
	assert.match(text, /◇ T-2 Task outcome 2 · awaiting acceptance/);
	assert.doesNotMatch(text, /registerTool/);
	const full = workflowDetailRows(snapshot(state), theme, 120).join("\n");
	assert.match(full, /T-1 Rewrite trigger copy/);
	assert.match(full, /Outcome: Rewrite the registerTool description and promptGuidelines/);
});
