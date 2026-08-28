import assert from "node:assert/strict";
import test from "node:test";

import { admitTaskGraph, initialProgress, readyTasks } from "../extensions/workflow-harness/task-graph.ts";

function node(index: number, dependsOn: string[]): Record<string, unknown> {
	const taskId = `T${index}`;
	return {
		taskId,
		description: taskId,
		dependsOn,
		readPaths: [],
		writePaths: [`out/${taskId}`],
		resourceLocks: [`lock-${taskId}`],
		isolation: "controller-checkout",
		verification: [`verify ${taskId}`],
		doneWhen: [`done ${taskId}`],
		review: { required: false, reasons: [] },
		attemptLimit: 1,
		recovery: "fix-forward",
	};
}

test("generated serial DAGs expose tasks only after dependencies complete", () => {
	for (let size = 1; size <= 100; size += 1) {
		const tasks = Array.from({ length: size }, (_, index) => node(index, index === 0 ? [] : [`T${index - 1}`]));
		const graph = admitTaskGraph({ schemaVersion: 1, graphId: `g-${size}`, requestId: `r-${size}`, approved: true, rootFormalRole: "none", terminalTaskIds: [`T${size - 1}`], tasks });
		const progress = initialProgress(graph);
		for (let index = 0; index < size; index += 1) {
			assert.equal(readyTasks(graph, progress)[0]?.taskId, `T${index}`);
			progress[`T${index}`] = { status: "complete", attempts: 1 };
		}
		assert.deepEqual(readyTasks(graph, progress), []);
	}
});
