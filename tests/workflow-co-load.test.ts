import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/subagents/index.ts";
import subagentsUiExtension from "../extensions/subagents-ui/index.ts";
import statusFooterExtension from "../extensions/status-footer/index.ts";
import workTimingExtension, { WORK_TIMING_ENTRY_TYPE } from "../extensions/work-timing/index.ts";
import workflowExtension from "../extensions/workflow/index.ts";
import type { WorksetState } from "../extensions/workflow/contracts.ts";
import { createHostHarness, createTrace, createTraceObserver, waitForTrace } from "./fixtures/workflow/host-fixture.ts";

// Deliberately register workflow before the real timing/observer consumers, not last.
const packageExtensions = [
	workflowExtension,
	subagentsExtension as unknown as (pi: ExtensionAPI) => void,
	subagentsUiExtension as unknown as (pi: ExtensionAPI) => void,
	workTimingExtension as unknown as (pi: ExtensionAPI) => void,
	statusFooterExtension as unknown as (pi: ExtensionAPI) => void,
];

for (const mode of ["tui", "rpc"] as const) {
	test(`real host ${mode} co-load: bounded reconciliation starts after every settlement consumer`, async (t) => {
		const trace = createTrace();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let first = true;
		const lateConsumer = (pi: ExtensionAPI) => {
			pi.on("agent_settled", async () => {
				if (!first) return;
				first = false;
				trace.record("late:blocked");
				await gate;
				trace.record("late:finished");
			});
			pi.on("before_agent_start", (_event, ctx) => {
				trace.record("co-load:before", { timingEntries: ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === WORK_TIMING_ENTRY_TYPE).length });
			});
		};
		const harness = await createHostHarness({ mode, trace, extensions: [...packageExtensions, createTraceObserver(trace), lateConsumer] });
		t.after(async () => { release(); await harness.dispose(); });
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("csheng_workflow", {
				operation: "open", expectedRevision: 0, goal: "Co-loaded workflow", deliveryEndpoint: "co-load evidence",
				criteria: [{ key: "c", outcome: "Criterion", verification: "check" }], tasks: [{ key: "t", outcome: "Task", covers: ["c"] }],
			} as never)),
			fauxAssistantMessage("prematurely stopped"),
			fauxAssistantMessage(fauxToolCall("csheng_workflow", { operation: "pause", expectedRevision: 2, reason: "explicit fixture blocker" } as never)),
			fauxAssistantMessage("truthfully paused"),
		]);
		const running = harness.session.prompt("go");
		await waitForTrace(trace, (entry) => entry.event === "late:blocked");
		assert.equal(harness.faux.state.callCount, 2, "no new interaction starts while a later consumer is pending");
		release();
		await running;
		await waitForTrace(trace, () => trace.entries.filter((entry) => entry.event === "native:agent_settled").length === 2);
		const branch = harness.session.sessionManager.getBranch();
		const snapshot = branch.findLast((entry) => entry.type === "custom" && entry.customType === "csheng-workflow-state") as { data: { state: WorksetState } };
		assert.equal(snapshot.data.state.workset.disposition, "paused");
		assert.equal(snapshot.data.state.workset.review.used, 1);
		assert.equal(snapshot.data.state.criteria["AC-1"]!.disposition, "unverified", "continuation is not semantic acceptance");
		assert.equal(harness.faux.state.callCount, 4);
		const input = trace.entries.filter((entry) => entry.event === "input");
		assert.equal(input.length, 2);
		assert.equal(input[1]!.detail?.source, "extension");
		assert.ok(trace.entries.indexOf(input[1]!) > trace.entries.findIndex((entry) => entry.event === "native:agent_settled"));
		const before = trace.entries.filter((entry) => entry.event === "co-load:before");
		assert.equal(before.length, 2);
		assert.equal(before[1]!.detail?.timingEntries, mode === "tui" ? 1 : 0, "prior timing settlement precedes next interaction initialization");
		assert.equal(branch.filter((entry) => entry.type === "custom" && entry.customType === WORK_TIMING_ENTRY_TYPE).length, mode === "tui" ? 2 : 0);
		assert.deepEqual(harness.errors, []);
	});
}
