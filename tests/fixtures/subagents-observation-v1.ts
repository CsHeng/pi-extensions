import { collectNativeObservation } from "../../extensions/subagents/observability.ts";
import type { ParentObservation } from "../../extensions/subagents/observation-hooks.ts";
import type { LocalTiming } from "../../extensions/subagents/telemetry.ts";

/** Frozen synthetic producer-shaped evidence; these durations/costs are not live measurements. */
export function observationFixture() {
	const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 1 } };
	const assistant = { role: "assistant", provider: "synthetic", model: "fixture", content: [], usage };
	const native = (owner: string, body: unknown[]) => `${[ { type: "session", version: 3, id: owner }, ...body].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const sessions = Array.from({ length: 3 }, (_, index) => {
		const owner = `child-${index}`;
		const text = native(owner, [{ type: "message", id: "answer", parentId: null, message: assistant }]);
		return { handle: `handle-${index}`, role: "worker", episode: 1, state: "idle", reportComplete: true,
			result: { id: `worker-${index}`, role: "worker", status: "succeeded", reportComplete: true, observationVersion: 1, observation: collectNativeObservation(text, { startLeaf: null, endLeaf: "answer", launched: true }) },
			candidate: { id: `candidate-${index}`, episode: 1, status: "not-applied", changedPaths: ["synthetic.txt"], appliedPaths: [] } };
	});
	const body: Array<Record<string, any>> = [
		{ type: "message", id: "user", parentId: null, message: { role: "user", content: "PRIVATE_PROMPT" } },
		{ type: "message", id: "before", parentId: "user", message: assistant },
		{ type: "message", id: "tool", parentId: "before", message: { role: "toolResult", toolCallId: "call", toolName: "csheng_subagent_sessions", details: { schemaVersion: 1, action: "create", status: "succeeded", sessions }, content: [{ type: "text", text: "PRIVATE_REPORT accepted delivery" }] } },
		{ type: "message", id: "after", parentId: "tool", message: assistant },
	];
	const timing: LocalTiming = { version: 1, clockKey: "parent-clock", originMs: 0, boundary: { startMs: 0, endMs: 600_000 }, complete: true,
		spans: { assistant: [{ startMs: 0, endMs: 0 }, { startMs: 600_000, endMs: 600_000 }], reasoning: [], localTool: [], compaction: [], delegationWait: [{ startMs: 0, endMs: 600_000 }] } };
	const observation: ParentObservation = {
		version: 1, range: { startLeaf: "user", endLeaf: "after" }, timing,
		native: collectNativeObservation(native("parent", body), { startLeaf: "user", endLeaf: "after", launched: true }),
		runs: [{ clockKey: "parent-clock", originMs: 0, telemetry: { schemaVersion: 4, runId: "run", runDurationMs: 600_000, requestedTasks: 3, admittedTasks: 3, launchedChildren: 3, peakConcurrency: 3, peakConcurrencyByRole: { worker: 3, reviewer: 0, explorer: 0 },
			timing: { boundary: "tool-entry", complete: true, scheduler: { startMs: 0, endMs: 600_000 }, waits: [], children: sessions.map((session) => ({ taskId: session.result.observation.ownerSessionId!, role: "worker", startMs: 0, endMs: 600_000 })) } } }],
	};
	body.push({ type: "custom", id: "observation", parentId: "after", customType: "csheng-parent-observation", data: observation });
	return { body, observation, sessions, text: () => native("parent", body) };
}
