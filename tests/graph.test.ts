import assert from "node:assert/strict";
import test from "node:test";

import { admitTaskGraph, graphIsTerminal, initialProgress, readyTasks, type TaskGraphV1 } from "../extensions/workflow-harness/task-graph.ts";

function task(taskId: string, dependsOn: string[] = []): Record<string, unknown> {
	return {
		taskId,
		description: `task ${taskId}`,
		dependsOn,
		readPaths: [],
		writePaths: [`src/${taskId}.ts`],
		resourceLocks: [`lock-${taskId}`],
		isolation: "controller-checkout",
		verification: [`verify-${taskId}`],
		doneWhen: [`done-${taskId}`],
		review: { required: false, reasons: [] },
		attemptLimit: 1,
		recovery: "fix-forward",
	};
}

function graph(tasks: Record<string, unknown>[], terminals: string[]): Record<string, unknown> {
	return { schemaVersion: 1, graphId: "graph-1", requestId: "request-1", approved: true, rootFormalRole: "planning", terminalTaskIds: terminals, tasks };
}

test("admits a closed serial DAG and returns only its first ready task", () => {
	const admitted = admitTaskGraph(graph([task("A"), task("B", ["A"])], ["B"]));
	const progress = initialProgress(admitted);
	assert.deepEqual(readyTasks(admitted, progress).map((item) => item.taskId), ["A"]);
	progress.A = { status: "complete", attempts: 1 };
	assert.deepEqual(readyTasks(admitted, progress).map((item) => item.taskId), ["B"]);
	progress.B = { status: "complete", attempts: 1 };
	assert.equal(graphIsTerminal(admitted, progress), true);
});

test("rejects cycles, unreachable tasks, unsafe paths, and unordered conflicts", () => {
	assert.throws(() => admitTaskGraph(graph([task("A", ["B"]), task("B", ["A"])], ["B"])), /cycle/);
	assert.throws(() => admitTaskGraph(graph([task("A"), task("B")], ["B"])), /not required/);
	const unsafe = task("A");
	unsafe.writePaths = ["../escape"];
	assert.throws(() => admitTaskGraph(graph([unsafe], ["A"])), /unsafe path/);
	const left = task("A");
	const right = task("B");
	right.writePaths = left.writePaths;
	assert.throws(() => admitTaskGraph(graph([left, right], ["A", "B"])), /conflict/);
});

test("rejects unknown fields, missing oracles, and unbounded attempts", () => {
	const unknown = task("A");
	unknown.extra = true;
	assert.throws(() => admitTaskGraph(graph([unknown], ["A"])), /exactly/);
	const noOracle = task("A");
	noOracle.verification = [];
	assert.throws(() => admitTaskGraph(graph([noOracle], ["A"])), /must not be empty/);
	const attempts = task("A");
	attempts.attemptLimit = 3;
	assert.throws(() => admitTaskGraph(graph([attempts], ["A"])), /must be 1 or 2/);
});
